/**
 * Persistence for income distributions.
 *
 * Tenant-scoped throughout; migration 056's policies are the backstop, and they
 * are dual-axis on `distribution_claims` — a holder matches on their own wallet,
 * an issuer through the asset.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { distributionClaims, distributions, type Distribution } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

export interface Holder {
  address: string;
  balance: string;
}

export interface ClaimRow {
  id: string;
  amount: string;
  status: string;
  claimedAt: Date | null;
  tokenSymbol: string;
  currency: string;
  note: string | null;
  declaredAt: Date;
}

@Injectable()
export class DistributionsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Holders with a non-zero balance — the cap table at this instant.
   *
   * Raw SQL because `balances` has no Drizzle schema: it is written by the
   * indexer and read the same way in tokens.service.ts. Served from the INDEXED
   * balances rather than the chain, which would be one RPC call per holder.
   */
  async holders(t: TenantContext, tokenAddress: string): Promise<Holder[]> {
    const res = await this.db.scoped(t, (tx) =>
      tx.execute(sql`
        SELECT address, balance FROM balances
         WHERE lower(token) = lower(${tokenAddress}) AND balance <> 0
      `),
    );
    return res.rows as unknown as Holder[];
  }

  list(t: TenantContext): Promise<Distribution[]> {
    return this.db.scoped(t, (tx) =>
      tx.select().from(distributions).orderBy(desc(distributions.createdAt)),
    );
  }

  /**
   * Declare a payout and write every holder's share in ONE transaction.
   *
   * Both halves must land together: a declaration with no claims owes everyone
   * nothing, and claims with no declaration are unattributable money. Callers
   * cannot compose this differently because the transaction is opened here.
   */
  async declare(
    t: TenantContext,
    input: {
      tokenSymbol: string;
      totalAmount: string;
      currency: string;
      note: string | null;
      declaredByEmail: string | null;
    },
    allocation: { wallet: string; amount: number }[],
  ): Promise<Distribution> {
    return this.db.scoped(t, async (tx) => {
      const [dist] = await tx.insert(distributions).values(input).returning();
      if (allocation.length > 0) {
        await tx.insert(distributionClaims).values(
          allocation.map((a) => ({
            distributionId: dist.id,
            wallet: a.wallet.toLowerCase(),
            amount: String(a.amount),
          })),
        );
      }
      return dist;
    });
  }

  /** Every claim across a person's wallets, with the declaration's context. */
  claimsForWallets(t: TenantContext, wallets: string[]): Promise<ClaimRow[]> {
    if (wallets.length === 0) return Promise.resolve([]);
    const lowered = wallets.map((w) => w.toLowerCase());
    return this.db.scoped(t, (tx) =>
      tx
        .select({
          id: distributionClaims.id,
          amount: distributionClaims.amount,
          status: distributionClaims.status,
          claimedAt: distributionClaims.claimedAt,
          tokenSymbol: distributions.tokenSymbol,
          currency: distributions.currency,
          note: distributions.note,
          declaredAt: distributions.createdAt,
        })
        .from(distributionClaims)
        .innerJoin(distributions, eq(distributions.id, distributionClaims.distributionId))
        .where(inArray(sql`lower(${distributionClaims.wallet})`, lowered))
        .orderBy(desc(distributions.createdAt)),
    );
  }

  /**
   * Mark every claimable row for these wallets claimed, returning what was paid.
   *
   * The `status = 'claimable'` predicate is inside the UPDATE, so two concurrent
   * claims cannot both collect the same row — the second matches nothing and
   * returns an empty set rather than paying twice.
   */
  async claimAll(t: TenantContext, wallets: string[]): Promise<{ count: number; total: number }> {
    if (wallets.length === 0) return { count: 0, total: 0 };
    const lowered = wallets.map((w) => w.toLowerCase());
    const rows = await this.db.scoped(t, (tx) =>
      tx
        .update(distributionClaims)
        .set({ status: 'claimed', claimedAt: new Date() })
        .where(
          and(
            inArray(sql`lower(${distributionClaims.wallet})`, lowered),
            eq(distributionClaims.status, 'claimable'),
          ),
        )
        .returning({ amount: distributionClaims.amount }),
    );
    return {
      count: rows.length,
      total: rows.reduce((s, r) => s + Number(r.amount), 0),
    };
  }
}
