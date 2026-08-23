/**
 * Investor + acceptance reads.
 *
 * Every query is tenant-scoped, and the RLS policies from migration 044 apply
 * on top. For an issuer caller the database itself restricts `investors` to
 * that issuer's cap table, so the absence of an explicit cap-table join here is
 * not an oversight — it is the policy doing its job. The service still audits
 * the read (§5.2).
 */
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import {
  accounts,
  auditLog,
  investors,
  issuerInvestorAcceptance,
  subscriptions,
  wallets,
  type Acceptance,
  type Investor,
  type Subscription,
  type Wallet,
} from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class InvestorsRepository {
  constructor(private readonly db: DbService) {}

  list(tenant: TenantContext): Promise<Investor[]> {
    return this.db.scoped(tenant, (tx) =>
      tx.select().from(investors).orderBy(desc(investors.createdAt)),
    );
  }

  async findByWallet(tenant: TenantContext, wallet: string): Promise<Investor | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(investors)
        .where(sql`lower(${investors.wallet}) = lower(${wallet})`)
        .limit(1),
    );
    return row;
  }

  /** The investor's orders. Scoped by whichever axis the caller sits on. */
  subscriptionsFor(tenant: TenantContext, wallet: string): Promise<Subscription[]> {
    return this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(sql`lower(${subscriptions.wallet}) = lower(${wallet})`)
        .orderBy(desc(subscriptions.createdAt)),
    );
  }

  /**
   * The PERSON's current KYC version (migration 045 moved it to accounts).
   *
   * Staleness compares an acceptance's pinned version against this. Reading it
   * off the wallet-keyed investors row would compare two different subjects —
   * acceptance is keyed on accounts.id.
   */
  async accountKycVersion(accountId: string): Promise<string | undefined> {
    const [row] = await this.db.worker('investors: person kyc version', (tx) =>
      tx.select({ v: accounts.kycVersion }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
    );
    return row?.v;
  }

  async acceptanceFor(
    tenant: TenantContext,
    issuerId: string,
    accountId: string,
  ): Promise<Acceptance | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(issuerInvestorAcceptance)
        .where(
          and(
            eq(issuerInvestorAcceptance.issuerId, issuerId),
            eq(issuerInvestorAcceptance.investorId, accountId),
          ),
        )
        .limit(1),
    );
    return row;
  }

  async upsertAcceptance(
    tenant: TenantContext,
    row: {
      issuerId: string;
      investorId: string;
      status: string;
      kycVersion: string;
      decidedBy: string;
      note?: string;
    },
  ): Promise<Acceptance> {
    const [saved] = await this.db.scoped(tenant, (tx) =>
      tx
        .insert(issuerInvestorAcceptance)
        .values({ ...row, note: row.note ?? null })
        .onConflictDoUpdate({
          target: [issuerInvestorAcceptance.issuerId, issuerInvestorAcceptance.investorId],
          set: {
            status: row.status,
            kycVersion: row.kycVersion,
            decidedBy: row.decidedBy,
            note: row.note ?? null,
            decidedAt: new Date(),
          },
        })
        .returning(),
    );
    return saved;
  }

  /** Link rows (screening outcome, linked-at) for a person's wallets. */
  linkedWallets(primaryWallet: string): Promise<Wallet[]> {
    return this.db.worker('investors: linked wallets for admin panel', (tx) =>
      tx
        .select()
        .from(wallets)
        .where(eq(wallets.primaryWallet, primaryWallet.toLowerCase()))
        .orderBy(asc(wallets.createdAt)),
    );
  }

  /**
   * The audit rows targeting any of a person's wallets — the admin panel's
   * activity timeline. Worker read: the panel is platform-side and the rows
   * may span issuers (the person can hold assets from several).
   */
  timelineFor(targets: string[], limit: number) {
    if (targets.length === 0) return Promise.resolve([]);
    const lowered = targets.map((t) => t.toLowerCase());
    return this.db.worker('investors: person timeline', (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(inArray(sql`lower(${auditLog.target})`, lowered))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit),
    );
  }
}
