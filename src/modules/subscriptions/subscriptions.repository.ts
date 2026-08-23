/**
 * Order persistence — including the ORDER RACE fix.
 *
 * `createOrderAtomic` is ported VERBATIM in structure from
 * ../rwa-token-backend/src/lib/db/index.ts. It is the single most contended
 * write in the system, and the shape is deliberate:
 *
 *   1. Lock the offering row (SELECT ... FOR UPDATE) so only one order for this
 *      offering is decided at a time.
 *   2. Re-read the contended values — reserved supply, issued supply, this
 *      person's reservation — INSIDE the lock. Deciding on values read before
 *      the lock is exactly the race: two investors both see "10 left" and both
 *      buy 10.
 *   3. Evaluate the pure limit rules.
 *   4. Insert, or roll back (which releases the lock and reserves nothing).
 *
 * The on-chain inputs (a person's existing balance) are read BEFORE the lock on
 * purpose — they are slow and effectively monotonic, and holding a row lock
 * across an RPC call would serialise every order behind the network.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { subscriptions } from '@shared/db/schema';
import { checkOrderLimits, type LimitResult } from '@shared/money/order-limits';
import type { TenantContext } from '@shared/auth/tenant-context';
import type { Subscription } from '@shared/db/schema';

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] }).rows ?? []);
}

export interface CreateOrderInput {
  offeringId: string;
  tokenAddress: string;
  tokensTotal: number;
  tokensWanted: number;
  maxTokensPerInvestor: number | null;
  heldByPerson: number;
  personWallets: string[];
  sub: {
    reference: string;
    wallet: string;
    tokenSymbol: string;
    amountFiat: number;
    currency: string;
    pricePerToken: number;
    paymentProvider: string;
  };
}

export type CreateOrderResult =
  | { ok: true; sub: Subscription }
  | (LimitResult & { ok: false });

@Injectable()
export class SubscriptionsRepository {
  constructor(private readonly db: DbService) {}

  async createOrderAtomic(
    tenant: TenantContext,
    input: CreateOrderInput,
  ): Promise<CreateOrderResult> {
    return this.db.scoped(tenant, async (tx) => {
      /* 1. Serialise orders for this offering. */
      await tx.execute(sql`SELECT id FROM offerings WHERE id = ${input.offeringId} FOR UPDATE`);

      /* 2a. Supply reserved across ALL wallets — re-read under the lock. */
      const reservedAll = Number(
        rowsOf<{ t: string }>(
          await tx.execute(sql`
            SELECT COALESCE(SUM(tokens),0)::int AS t FROM subscriptions
             WHERE offering_id = ${input.offeringId}
               AND status IN ('pending_payment','paid','settling')
          `),
        )[0]?.t ?? 0,
      );

      /* 2b. Issued on-chain, from the indexed balances. */
      const tokensIssued = Number(
        rowsOf<{ t: string }>(
          await tx.execute(sql`
            SELECT COALESCE(SUM(balance),0) AS t FROM balances
             WHERE token = ${input.tokenAddress.toLowerCase()} AND balance <> 0
          `),
        )[0]?.t ?? 0,
      );

      /* 2c. This PERSON's reservation across every wallet they control. */
      let reservedByPerson = 0;
      if (input.maxTokensPerInvestor !== null && input.personWallets.length > 0) {
        const wallets = input.personWallets.map((w) => w.toLowerCase());
        /*
         * Typed builder rather than a raw `wallet = ANY(${array})`: an array
         * interpolated into drizzle's sql template does not bind as a Postgres
         * array, and the query fails at runtime. inArray() emits the correct
         * parameterised form.
         */
        const rows = await tx
          .select({ t: sql<number>`COALESCE(SUM(${subscriptions.tokens}),0)::int` })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.offeringId, input.offeringId),
              inArray(subscriptions.status, ['pending_payment', 'paid', 'settling']),
              inArray(subscriptions.wallet, wallets),
            ),
          );
        reservedByPerson = Number(rows[0]?.t ?? 0);
      }

      /* 3. Pure rules — unit-tested without a database. */
      const verdict = checkOrderLimits({
        tokensWanted: input.tokensWanted,
        tokensTotal: input.tokensTotal,
        tokensIssued,
        reservedAll,
        maxTokensPerInvestor: input.maxTokensPerInvestor,
        heldByPerson: input.heldByPerson,
        reservedByPerson,
      });
      if (!verdict.ok) return verdict as CreateOrderResult;

      /* 4. Reserve. */
      const s = input.sub;
      /*
       * The INSERT stays raw — it is the reservation inside the row lock and
       * is deliberately untouched. But it RETURNS ONLY THE ID, and the mapped
       * row is read back with the query builder: a raw `RETURNING *` hands the
       * caller snake_case keys under a `Subscription` type. See rowsOf.
       */
      const [{ id: newId }] = rowsOf<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO subscriptions
            (reference, wallet, offering_id, token_symbol, amount_fiat, currency,
             price_per_token, tokens, payment_provider, status)
          VALUES (${s.reference}, ${s.wallet.toLowerCase()}, ${input.offeringId}, ${s.tokenSymbol},
                  ${s.amountFiat}, ${s.currency}, ${s.pricePerToken}, ${input.tokensWanted},
                  ${s.paymentProvider}, 'pending_payment')
          RETURNING id
        `),
      );
      const [inserted] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, newId))
        .limit(1);
      return { ok: true, sub: inserted };
    });
  }

  async byReference(tenant: TenantContext, reference: string): Promise<Subscription | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.reference, reference)).limit(1),
    );
    return row;
  }

  /** Webhook path: no tenant, matched by the provider's own reference. */
  async byPaymentRef(paymentRef: string): Promise<Subscription | undefined> {
    const [row] = await this.db.worker('subscriptions: lookup by payment ref', (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.paymentRef, paymentRef)).limit(1),
    );
    return row;
  }

  /**
   * Load by id WITHOUT a tenant.
   *
   * Settlement is driven by a provider webhook, which has no session and
   * therefore no tenant. Authorization for that path is the webhook signature,
   * not RLS.
   */
  async byId(id: string): Promise<Subscription | undefined> {
    const [row] = await this.db.worker('subscriptions: lookup by id', (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1),
    );
    return row;
  }

  async update(
    id: string,
    patch: { status?: string; paymentRef?: string | null; txHash?: string | null; error?: string | null },
  ): Promise<void> {
    await this.db.worker('subscriptions: update', async (tx) => {
      await tx.execute(sql`
        UPDATE subscriptions SET
          status      = COALESCE(${patch.status ?? null}, status),
          payment_ref = COALESCE(${patch.paymentRef ?? null}, payment_ref),
          tx_hash     = COALESCE(${patch.txHash ?? null}, tx_hash),
          error       = ${patch.error ?? null},
          updated_at  = now()
        WHERE id = ${id}
      `);
    });
  }

  /**
   * Claim an order for settlement: paid -> settling, atomically.
   *
   * Same reasoning as the approval claim — the webhook and the investor's own
   * "pay" call can arrive together, and both settling would mint twice.
   */
  async claimForSettlement(id: string): Promise<boolean> {
    const rows = await this.db.worker('subscriptions: claim for settlement', async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`
          UPDATE subscriptions SET status = 'settling', updated_at = now()
           WHERE id = ${id} AND status = 'paid'
           RETURNING id
        `),
      ),
    );
    return rows.length > 0;
  }

  /**
   * Claim an order for refund: paid|failed -> refunding, atomically.
   *
   * The mirror of the settlement claim. Concurrent closes must not both call
   * the payment provider for the same order — a double refund is money out
   * twice, and providers do not all reject it.
   */
  async claimForRefund(id: string): Promise<boolean> {
    const rows = await this.db.worker('subscriptions: claim for refund', async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`
          UPDATE subscriptions SET status = 'refunding', updated_at = now()
           WHERE id = ${id} AND status IN ('paid', 'failed')
           RETURNING id
        `),
      ),
    );
    return rows.length > 0;
  }

  /**
   * Orders of an offering in a given status — the escrow working set.
   *
   * Uses the QUERY BUILDER, not raw SQL: `SELECT *` returns snake_case columns
   * and casting the result to `Subscription` only makes the mismatch invisible.
   * That cost a debugging round — `toPaise(row.amountFiat)` on an undefined
   * field threw "NaN cannot be converted to a BigInt" from inside the escrow
   * close. Raw SQL is fine where only an id comes back; never for a mapped row.
   */
  byOfferingStatus(offeringId: string, status: string): Promise<Subscription[]> {
    return this.db.worker('subscriptions: escrow working set', (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.offeringId, offeringId), eq(subscriptions.status, status)))
        .orderBy(asc(subscriptions.createdAt)),
    );
  }

  /**
   * Commit an offering's close outcome, atomically.
   *
   * Only one close may DECIDE. From the moment this lands, new orders are
   * rejected and late payments auto-refund, so it must happen BEFORE any money
   * moves — otherwise a concurrent close could settle what this one refunds.
   */
  async claimOfferingClosed(offeringId: string, outcome: 'funded' | 'cancelled'): Promise<boolean> {
    const rows = await this.db.worker('subscriptions: claim offering close', async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`
          UPDATE offerings SET status = ${outcome}, updated_at = now()
           WHERE id = ${offeringId} AND status NOT IN ('funded', 'cancelled')
           RETURNING id
        `),
      ),
    );
    return rows.length > 0;
  }

  /** Reservations parked in pending_payment longer than the TTL. */
  stalePendingPayment(minutes: number): Promise<Subscription[]> {
    return this.db.worker('subscriptions: stale reservation scan', (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, 'pending_payment'),
            sql`${subscriptions.createdAt} < now() - (${minutes} || ' minutes')::interval`,
          ),
        )
        .orderBy(asc(subscriptions.createdAt)),
    );
  }

  /**
   * Release one abandoned reservation.
   *
   * Conditional on the status, so a payment landing mid-scan always wins: the
   * UPDATE matches nothing and the order proceeds normally.
   */
  async expirePendingPayment(id: string, reason: string): Promise<boolean> {
    const rows = await this.db.worker('subscriptions: expire reservation', async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`
          UPDATE subscriptions
             SET status = 'expired', error = ${reason}, updated_at = now()
           WHERE id = ${id} AND status = 'pending_payment'
           RETURNING id
        `),
      ),
    );
    return rows.length > 0;
  }

  /** Orders stuck mid-settlement — the process died holding the claim. */
  staleSettling(minutes: number): Promise<Subscription[]> {
    return this.db.worker('subscriptions: stale settlement scan', (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, 'settling'),
            sql`${subscriptions.updatedAt} < now() - (${minutes} || ' minutes')::interval`,
          ),
        )
        .orderBy(asc(subscriptions.updatedAt)),
    );
  }

  /**
   * Every wallet the PERSON controls, plus their accreditation tier.
   *
   * Caps are per-INVESTOR, not per-wallet — otherwise anyone could bypass a cap
   * by connecting a second address. Resolved through accounts (migration 047),
   * which is where accreditation actually lives.
   */
  async personFor(wallet: string): Promise<{ wallets: string[]; accredited: boolean }> {
    const rows = await this.db.worker('subscriptions: resolve person', async (tx) =>
      rowsOf<{ wallet: string; accreditation_status: string | null }>(
        await tx.execute(sql`
          SELECT i2.wallet, a.accreditation_status
            FROM investors i1
            LEFT JOIN accounts  a  ON a.id = i1.account_id
            LEFT JOIN investors i2 ON i2.account_id = i1.account_id
           WHERE lower(i1.wallet) = lower(${wallet})
        `),
      ),
    );

    if (rows.length === 0) {
      /* Unlinked wallet: it is its own "person". Fail closed on the tier —
         an unknown investor is never accredited. */
      return { wallets: [wallet.toLowerCase()], accredited: false };
    }
    const wallets = rows.map((r) => r.wallet?.toLowerCase()).filter(Boolean);
    return {
      wallets: wallets.length ? wallets : [wallet.toLowerCase()],
      accredited: rows[0].accreditation_status === 'accredited',
    };
  }

  /**
   * Recent orders for back-office reconciliation. No WHERE clause on purpose:
   * RLS is the filter — an issuer sees orders through its own offerings, the
   * platform sees everything (dual-axis policy, migration 050).
   */
  listRecent(tenant: TenantContext, limit: number): Promise<Subscription[]> {
    return this.db.scoped(tenant, (tx) =>
      tx.select().from(subscriptions).orderBy(desc(subscriptions.createdAt)).limit(limit),
    );
  }

  listForWallet(tenant: TenantContext, wallet: string): Promise<Subscription[]> {
    return this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(subscriptions)
        .where(sql`lower(${subscriptions.wallet}) = lower(${wallet})`)
        .orderBy(desc(subscriptions.createdAt)),
    );
  }
}
