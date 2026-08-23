/**
 * Persistence for the offering-attached features.
 *
 * Everything is tenant-scoped via db.scoped(); the RLS policies from migration
 * 051 are the backstop. Investors can READ valuations, updates, the buyback bid
 * and governance — that is the asset's public face and they need it to decide
 * whether to buy or sell — but only the owning issuer can write.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import {
  buybackOffers,
  buybackSales,
  managerProposals,
  managerVotes,
  propertyUpdates,
  valuations,
  type BuybackOffer,
  type BuybackSale,
  type ManagerProposal,
  type PropertyUpdate,
  type Valuation,
} from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class OfferingFeaturesRepository {
  constructor(private readonly db: DbService) {}

  /* ---- valuations ------------------------------------------------------ */

  listValuations(t: TenantContext, offeringId: string): Promise<Valuation[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(valuations)
        .where(eq(valuations.offeringId, offeringId))
        .orderBy(desc(valuations.createdAt)),
    );
  }

  async addValuation(
    t: TenantContext,
    v: { offeringId: string; totalValue: string; note?: string; source?: string; createdByEmail?: string },
  ): Promise<Valuation> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(valuations)
        .values({
          offeringId: v.offeringId,
          totalValue: v.totalValue,
          note: v.note ?? null,
          source: v.source ?? 'manual',
          createdByEmail: v.createdByEmail ?? null,
        })
        .returning(),
    );
    return row;
  }

  /* ---- manager updates -------------------------------------------------- */

  listUpdates(t: TenantContext, offeringId: string): Promise<PropertyUpdate[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(propertyUpdates)
        .where(eq(propertyUpdates.offeringId, offeringId))
        .orderBy(desc(propertyUpdates.createdAt)),
    );
  }

  async addUpdate(
    t: TenantContext,
    u: { offeringId: string; title: string; body: string; managerId?: string },
  ): Promise<PropertyUpdate> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(propertyUpdates)
        .values({
          offeringId: u.offeringId,
          title: u.title,
          body: u.body,
          managerId: u.managerId ?? null,
        })
        .returning(),
    );
    return row;
  }

  /* ---- buyback ---------------------------------------------------------- */

  async getBuyback(t: TenantContext, offeringId: string): Promise<BuybackOffer | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.select().from(buybackOffers).where(eq(buybackOffers.offeringId, offeringId)).limit(1),
    );
    return row;
  }

  /**
   * The open buyback for the PUBLIC offering view. Worker connection: the
   * marketplace has no tenant, and an open bid is marketing surface, not
   * tenant-gated data.
   */
  async openBuybackAnyTenant(offeringId: string): Promise<BuybackOffer | undefined> {
    const [row] = await this.db.worker('offerings: public buyback view', (tx) =>
      tx.select().from(buybackOffers).where(eq(buybackOffers.offeringId, offeringId)).limit(1),
    );
    return row && row.status === 'open' ? row : undefined;
  }

  /**
   * Open or replace the standing bid. One per offering, so this upserts —
   * two live bids for the same asset would be ambiguous to a seller.
   */
  async upsertBuyback(
    t: TenantContext,
    b: { offeringId: string; sellerWallet: string; pricePerToken: string; maxTokens: number | null },
  ): Promise<BuybackOffer> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(buybackOffers)
        .values({ ...b, status: 'open', tokensBought: 0, closedAt: null })
        .onConflictDoUpdate({
          target: buybackOffers.offeringId,
          set: {
            sellerWallet: b.sellerWallet,
            pricePerToken: b.pricePerToken,
            maxTokens: b.maxTokens,
            status: 'open',
            closedAt: null,
          },
        })
        .returning(),
    );
    return row;
  }

  /**
   * Close the bid.
   *
   * Never deletes: `buyback_sales` reference the offering, and the terms a past
   * sale executed under are part of the record.
   */
  async closeBuyback(t: TenantContext, offeringId: string): Promise<boolean> {
    const rows = await this.db.scoped(t, (tx) =>
      tx
        .update(buybackOffers)
        .set({ status: 'closed', closedAt: new Date() })
        .where(and(eq(buybackOffers.offeringId, offeringId), eq(buybackOffers.status, 'open')))
        .returning({ id: buybackOffers.offeringId }),
    );
    return rows.length > 0;
  }

  /* ---- governance ------------------------------------------------------- */

  listProposals(t: TenantContext, offeringId: string): Promise<ManagerProposal[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(managerProposals)
        .where(eq(managerProposals.offeringId, offeringId))
        .orderBy(desc(managerProposals.createdAt)),
    );
  }

  async getProposal(t: TenantContext, id: string): Promise<ManagerProposal | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.select().from(managerProposals).where(eq(managerProposals.id, id)).limit(1),
    );
    return row;
  }

  async addProposal(
    t: TenantContext,
    p: { offeringId: string; proposedManagerId: string; reason?: string; closesAt: Date; createdBy: string },
  ): Promise<ManagerProposal> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(managerProposals)
        .values({
          offeringId: p.offeringId,
          proposedManagerId: p.proposedManagerId,
          reason: p.reason ?? null,
          closesAt: p.closesAt,
          createdBy: p.createdBy,
          status: 'open',
        })
        .returning(),
    );
    return row;
  }

  /** Tally by choice, weighted by the balance captured at vote time. */
  async tally(t: TenantContext, proposalId: string): Promise<{ for: number; against: number; voters: number }> {
    const rows = await this.db.scoped(t, (tx) =>
      tx
        .select({ choice: managerVotes.choice, weight: managerVotes.weight })
        .from(managerVotes)
        .where(eq(managerVotes.proposalId, proposalId)),
    );
    let f = 0;
    let a = 0;
    for (const r of rows) {
      if (r.choice === 'for') f += Number(r.weight);
      else a += Number(r.weight);
    }
    return { for: f, against: a, voters: rows.length };
  }

  /**
   * Close a proposal with its outcome.
   *
   * Atomic on `status = 'open'`: two concurrent closes must not both decide,
   * and only one may swap the manager.
   */
  async closeProposal(t: TenantContext, id: string, passed: boolean): Promise<boolean> {
    const rows = await this.db.scoped(t, (tx) =>
      tx
        .update(managerProposals)
        .set({ status: passed ? 'passed' : 'rejected' })
        .where(and(eq(managerProposals.id, id), eq(managerProposals.status, 'open')))
        .returning({ id: managerProposals.id }),
    );
    return rows.length > 0;
  }

  async assignManager(t: TenantContext, offeringId: string, managerId: string | null): Promise<void> {
    await this.db.scoped(t, (tx) =>
      tx.execute(sql`
        UPDATE offerings SET manager_id = ${managerId}, updated_at = now()
         WHERE id = ${offeringId}
      `),
    );
  }

  /**
   * Does this manager exist and is it active?
   *
   * `managers` belongs to a module that has not been ported yet, so this is a
   * deliberate one-query exception to "a repository touches only its own
   * tables" — it is an existence check, not business logic, and it moves to
   * ManagersService the moment that module lands. Without it a proposal can
   * name a manager id that does not exist, pass a vote, and assign nothing.
   */
  async managerIsActive(t: TenantContext, managerId: string): Promise<boolean> {
    const rows = await this.db.scoped(t, (tx) =>
      tx.execute(sql`SELECT 1 FROM managers WHERE id = ${managerId} AND status = 'active'`),
    );
    return rows.rows.length > 0;
  }

  /* ---- investor-side writes -------------------------------------------- */

  /**
   * Record (or revise) a vote.
   *
   * Upsert on (proposal_id, wallet): changing your mind before the window
   * closes is normal, and re-voting must replace rather than double-count. The
   * weight is re-captured on each write, so a revision reflects the holding at
   * the moment of the revision.
   */
  async upsertVote(
    t: TenantContext,
    v: { proposalId: string; wallet: string; weight: number; choice: 'for' | 'against' },
  ): Promise<void> {
    await this.db.scoped(t, (tx) =>
      tx
        .insert(managerVotes)
        .values({
          proposalId: v.proposalId,
          wallet: v.wallet.toLowerCase(),
          weight: String(v.weight),
          choice: v.choice,
        })
        .onConflictDoUpdate({
          target: [managerVotes.proposalId, managerVotes.wallet],
          set: { weight: String(v.weight), choice: v.choice, votedAt: new Date() },
        }),
    );
  }

  /**
   * Book a sell-back against the standing bid.
   *
   * Ported from the Express `recordBuybackSale`, and the transaction shape is
   * the point: the bid row is locked FOR UPDATE, then the duplicate-tx check
   * and the remaining-budget check both run INSIDE that lock. Read them outside
   * and two concurrent sellers can each see the same remaining budget and both
   * pass — the issuer buys more than it offered to.
   *
   * Returns a reason instead of throwing so the caller maps it to an HTTP code;
   * the repository stays free of status codes.
   */
  async recordSale(
    t: TenantContext,
    s: {
      offeringId: string;
      wallet: string;
      tokens: number;
      pricePerToken: string;
      amountFiat: string;
      txHash: string;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.db.scoped(t, async (tx) => {
      const locked = await tx.execute(
        sql`SELECT status, max_tokens, tokens_bought FROM buyback_offers
             WHERE offering_id = ${s.offeringId} FOR UPDATE`,
      );
      const offer = locked.rows[0] as
        | { status: string; max_tokens: string | null; tokens_bought: string }
        | undefined;
      if (!offer || offer.status !== 'open') {
        return { ok: false as const, reason: 'There is no open buy-back for this asset.' };
      }

      /* One on-chain transfer backs at most one sale. A unique index enforces
         this too; checking here yields a usable message instead of a 23505. */
      const dup = await tx.execute(
        sql`SELECT 1 FROM buyback_sales WHERE tx_hash = ${s.txHash}`,
      );
      if (dup.rows.length > 0) {
        return {
          ok: false as const,
          reason: 'This transaction has already been recorded as a sell-back.',
        };
      }

      if (offer.max_tokens != null) {
        const remaining = Number(offer.max_tokens) - Number(offer.tokens_bought);
        if (s.tokens > remaining) {
          return { ok: false as const, reason: `Only ${remaining} tokens remain in this buy-back.` };
        }
      }

      await tx.execute(
        sql`UPDATE buyback_offers SET tokens_bought = tokens_bought + ${s.tokens}
             WHERE offering_id = ${s.offeringId}`,
      );
      await tx.insert(buybackSales).values({
        offeringId: s.offeringId,
        wallet: s.wallet.toLowerCase(),
        tokens: s.tokens,
        pricePerToken: s.pricePerToken,
        amountFiat: s.amountFiat,
        txHash: s.txHash,
      });
      return { ok: true as const };
    });
  }

  /** A seller's own sell-back history for one offering. */
  listSales(t: TenantContext, offeringId: string): Promise<BuybackSale[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(buybackSales)
        .where(eq(buybackSales.offeringId, offeringId))
        .orderBy(desc(buybackSales.createdAt)),
    );
  }
}
