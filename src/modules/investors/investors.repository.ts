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
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import {
  accounts,
  investors,
  issuerInvestorAcceptance,
  subscriptions,
  type Acceptance,
  type Investor,
  type Subscription,
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
}
