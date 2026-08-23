/**
 * KYC review queue and decisions — keyed on the PERSON (accounts).
 *
 * Since migration 045 `accounts` is the source of truth for KYC, because the
 * flow is sign up -> KYC -> connect wallet and a wallet may not exist yet.
 *
 * DUAL-WRITE, TEMPORARY. The Express app still reads investors.kyc_status, and
 * both apps share one database. So every decision written here is also mirrored
 * onto any linked investors rows. Delete the mirror — and this comment — when
 * the Express KYC routes are removed. It is done explicitly in the repository
 * rather than via a trigger so it is greppable and obvious.
 *
 * Uses db.worker(): KYC is a platform-level operation on a platform-global
 * record, and the subject has by definition not joined anyone's cap table yet.
 * Authorization is the @Roles('platform_admin') guard; every decision is audited.
 */
import { Injectable } from '@nestjs/common';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { accounts, investors, type Account } from '@shared/db/schema';

/** Statuses awaiting a human decision. */
export const REVIEW_STATUSES = ['applied', 'verifying'] as const;

export interface KycSubject extends Account {
  /** Wallets this person has linked. Empty until they reach step 3. */
  walletCount: number;
}

@Injectable()
export class KycRepository {
  constructor(private readonly db: DbService) {}

  async getByAccountId(accountId: string): Promise<Account | undefined> {
    const [row] = await this.db.worker('kyc: load account', (tx) =>
      tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
    );
    return row;
  }

  /**
   * Resolve a subject from either an account id or a wallet address.
   *
   * The admin UI and existing links refer to investors by wallet, but the
   * subject is now the person — so a wallet is resolved THROUGH to its account.
   * A wallet with no linked account has no person to decide about.
   */
  async resolveSubject(idOrWallet: string): Promise<Account | undefined> {
    if (/^\d+$/.test(idOrWallet)) return this.getByAccountId(idOrWallet);

    const [row] = await this.db.worker('kyc: resolve subject by wallet', (tx) =>
      tx
        .select({ account: accounts })
        .from(investors)
        .innerJoin(accounts, eq(accounts.id, investors.accountId))
        .where(sql`lower(${investors.wallet}) = lower(${idOrWallet})`)
        .limit(1),
    );
    return row?.account;
  }

  /**
   * Resolve a person from the KYC provider's own reference.
   *
   * `kyc_ref` still lives on the wallet-keyed `investors` row (migration 045
   * moved status, not the vendor reference), so this joins through to the
   * account — the actual subject of a KYC decision.
   */
  async byKycRef(checkRef: string): Promise<Account | undefined> {
    const [row] = await this.db.worker('kyc: resolve by provider ref', (tx) =>
      tx
        .select({ account: accounts })
        .from(investors)
        .innerJoin(accounts, eq(accounts.id, investors.accountId))
        .where(sql`${investors.kycRef} = ${checkRef}`)
        .limit(1),
    );
    return row?.account;
  }

  listPending(): Promise<Account[]> {
    return this.db.worker('kyc: review queue', (tx) =>
      tx
        .select()
        .from(accounts)
        .where(inArray(accounts.kycStatus, [...REVIEW_STATUSES]))
        .orderBy(desc(accounts.updatedAt)),
    );
  }

  async walletCount(accountId: string): Promise<number> {
    const rows = await this.db.worker('kyc: count linked wallets', (tx) =>
      tx.select({ w: investors.wallet }).from(investors).where(eq(investors.accountId, accountId)),
    );
    return rows.length;
  }

  /**
   * Record a decision against the person, mirroring to linked wallets.
   *
   * bumpVersion applies on APPROVAL only: a fresh verification supersedes every
   * issuer's prior reliance, which is what makes their acceptance show as stale
   * (TENANCY_MODEL.md §5.3).
   */
  async setDecision(
    accountId: string,
    status: string,
    note: string | null,
    bumpVersion: boolean,
  ): Promise<void> {
    await this.db.worker('kyc: record decision', async (tx) => {
      const bump = bumpVersion
        ? { kycVersion: sql`${accounts.kycVersion} + 1` as unknown as string }
        : {};

      await tx
        .update(accounts)
        .set({
          kycStatus: status,
          kycNote: note,
          kycRejectedAt: status === 'rejected' ? new Date() : null,
          ...bump,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));

      /* TEMPORARY Express mirror — see the file header. */
      await tx
        .update(investors)
        .set({
          kycStatus: status,
          kycNote: note,
          kycRejectedAt: status === 'rejected' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(investors.accountId, accountId));
    });
  }
}
