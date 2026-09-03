/**
 * Account (person) reads/writes.
 *
 * db.worker() because a person is platform-global and, before wallet
 * connection, belongs to no tenant at all. Self-access is enforced by the
 * account session: every method here is called with an accountId taken from the
 * verified token, never from the request.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import {
  accountOtps,
  accounts,
  investors,
  type Account,
  type Investor,
  type OtpPurpose,
} from '@shared/db/schema';

@Injectable()
export class AccountRepository {
  constructor(private readonly db: DbService) {}

  async byEmail(email: string): Promise<Account | undefined> {
    const [row] = await this.db.worker('account: lookup by email', (tx) =>
      tx
        .select()
        .from(accounts)
        .where(sql`lower(${accounts.email}) = lower(${email})`)
        .limit(1),
    );
    return row;
  }

  async byId(id: string): Promise<Account | undefined> {
    const [row] = await this.db.worker('account: lookup by id', (tx) =>
      tx.select().from(accounts).where(eq(accounts.id, id)).limit(1),
    );
    return row;
  }

  walletsFor(accountId: string): Promise<Investor[]> {
    return this.db.worker('account: linked wallets', (tx) =>
      tx.select().from(investors).where(eq(investors.accountId, accountId)),
    );
  }

  async create(email: string, passwordHash: string, name: string | null): Promise<Account> {
    const [row] = await this.db.worker('account: create', (tx) =>
      tx
        .insert(accounts)
        .values({ email: email.toLowerCase(), passwordHash, name, emailVerified: false })
        .returning(),
    );
    return row;
  }

  async setPassword(accountId: string, passwordHash: string): Promise<void> {
    await this.db.worker('account: set password', (tx) =>
      tx
        .update(accounts)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(accounts.id, accountId)),
    );
  }

  async markEmailVerified(accountId: string): Promise<void> {
    await this.db.worker('account: mark email verified', (tx) =>
      tx
        .update(accounts)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(accounts.id, accountId)),
    );
  }

  /** One live code per (email, purpose) — a resend replaces the previous one. */
  async upsertOtp(
    email: string,
    purpose: OtpPurpose,
    code: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.db.worker('account: issue otp', (tx) =>
      tx
        .insert(accountOtps)
        .values({ email: email.toLowerCase(), purpose, code, expiresAt })
        .onConflictDoUpdate({
          target: [accountOtps.email, accountOtps.purpose],
          set: { code, expiresAt, createdAt: new Date() },
        }),
    );
  }

  /**
   * Atomically consume a code.
   *
   * DELETE ... RETURNING with the expiry in the predicate makes the code
   * one-time-use and replay-safe under concurrency: exactly one caller can win.
   * Select-then-delete would let two requests both succeed on the same code.
   */
  async consumeOtp(email: string, purpose: OtpPurpose, code: string): Promise<boolean> {
    const rows = await this.db.worker('account: consume otp', (tx) =>
      tx
        .delete(accountOtps)
        .where(
          and(
            sql`lower(${accountOtps.email}) = lower(${email})`,
            eq(accountOtps.purpose, purpose),
            eq(accountOtps.code, code),
            gt(accountOtps.expiresAt, sql`now()`),
          ),
        )
        .returning(),
    );
    return rows.length > 0;
  }

  /** Move the person into the review queue. */
  async submitKyc(
    accountId: string,
    country: number | null,
    name: string | null,
    kycDetails: Record<string, unknown>,
  ): Promise<void> {
    await this.db.worker('account: submit kyc', async (tx) => {
      await tx
        .update(accounts)
        .set({
          kycStatus: 'applied',
          kycSubmittedAt: new Date(),
          kycNote: null,
          kycRejectedAt: null,
          kycDetails,
          ...(country !== null ? { country } : {}),
          ...(name !== null ? { name } : {}),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));

      /* TEMPORARY Express mirror — keep wallet rows in sync for issuer detail UI. */
      await tx
        .update(investors)
        .set({
          kycStatus: 'applied',
          kycSubmittedAt: new Date(),
          kycNote: null,
          kycRejectedAt: null,
          kycDetails,
          ...(country !== null ? { country } : {}),
          updatedAt: new Date(),
        })
        .where(eq(investors.accountId, accountId));
    });
  }

  /**
   * Link a wallet whose control has been proven by SIWE.
   *
   * Creates the wallet-level investors row if absent. The unique index on
   * investors.account_id is NOT used here — one person may link several wallets,
   * each getting its own row.
   */
  async linkWallet(accountId: string, wallet: string): Promise<void> {
    await this.db.worker('account: link wallet', async (tx) => {
      const existing = await tx
        .select()
        .from(investors)
        .where(sql`lower(${investors.wallet}) = lower(${wallet})`)
        .limit(1);

      if (existing.length === 0) {
        const [acct] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        await tx.insert(investors).values({
          wallet: wallet.toLowerCase(),
          accountId,
          kycStatus: acct?.kycStatus ?? 'none',
          kycVersion: acct?.kycVersion ?? '1',
          kycDetails: acct?.kycDetails ?? {},
          country: acct?.country ?? null,
          verified: false,
        });
        return;
      }

      const owner = existing[0].accountId;
      if (owner && owner !== accountId) {
        /* Surfaced as a 409 by the service — silently re-parenting a wallet
           would move someone else's holdings under this person. */
        throw new Error('WALLET_OWNED_BY_ANOTHER_ACCOUNT');
      }
      const [acct] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      await tx
        .update(investors)
        .set({
          accountId,
          kycStatus: acct?.kycStatus ?? existing[0].kycStatus,
          kycVersion: acct?.kycVersion ?? existing[0].kycVersion,
          kycDetails: acct?.kycDetails ?? existing[0].kycDetails,
          country: acct?.country ?? existing[0].country,
          amlStatus: acct?.amlStatus ?? existing[0].amlStatus,
          accreditationStatus: acct?.accreditationStatus ?? existing[0].accreditationStatus,
          accreditationNote: acct?.accreditationNote ?? existing[0].accreditationNote,
          updatedAt: new Date(),
        })
        .where(sql`lower(${investors.wallet}) = lower(${wallet})`);
    });
  }
}
