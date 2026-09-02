/**
 * Offering reads, tenant-scoped.
 *
 * Isolation is enforced TWICE, on purpose (TENANCY_MODEL.md §1 D3):
 *   1. the issuer predicates below, and
 *   2. Postgres RLS policies (migration 042) on the app_tenant_login connection.
 *
 * The predicates are not redundant. They keep the intent readable at the call
 * site and make the scoping unit-testable; RLS is the backstop that holds when
 * someone forgets one.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { offerings, tokens, type Offering } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

/** The columns a caller may set. `issuerId` and `status` are NOT among them. */
export interface NewOfferingInput {
  id: string;
  name: string;
  location?: string | null;
  assetType?: string | null;
  image?: string | null;
  description?: string | null;
  currency: string;
  pricePerToken: string;
  minInvestment: string;
  targetRaise: string;
  yieldPct?: string | null;
  country: number;
  maxInvestment?: string | null;
  accreditedMaxInvestment?: string | null;
  minimumRaise?: string | null;
  requiresAccreditation?: boolean;
  /* Listing detail + token plan, written by the asset-creation wizard. */
  visibility?: string;
  propertyType?: string | null;
  occupancyPct?: string | null;
  ownerOccupied?: boolean;
  sellerWallet?: string | null;
  retainedPct?: string | null;
  currentValuation?: string | null;
  images?: string[];
  documents?: unknown;
  tokenPlan?: unknown;
}

@Injectable()
export class OfferingsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * The issuer predicate for a caller.
   *
   * `undefined` means "no restriction" (platform admin). Investors see every
   * issuer's offerings — this is a marketplace, and browsing is cross-issuer by
   * design (TENANCY_MODEL.md §2.4).
   *
   * Since migration 043 offerings.issuer_id is NOT NULL, so every offering has
   * exactly one owner — there is no longer an unassigned bucket to reason about.
   */
  private scopeFilter(tenant: TenantContext): SQL | undefined {
    if (tenant.kind === 'issuer') return eq(offerings.issuerId, tenant.issuerId);
    return undefined;
  }

  async list(tenant: TenantContext): Promise<Offering[]> {
    const where = this.scopeFilter(tenant);
    return this.db.scoped(tenant, (tx) => {
      const q = tx.select().from(offerings);
      return (where ? q.where(where) : q).orderBy(asc(offerings.sortOrder), desc(offerings.createdAt));
    });
  }

  async findById(tenant: TenantContext, id: string): Promise<Offering | undefined> {
    const scope = this.scopeFilter(tenant);
    const where = scope ? and(eq(offerings.id, id), scope) : eq(offerings.id, id);
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx.select().from(offerings).where(where).limit(1),
    );
    return row;
  }

  /** Resolve an offering by its deployed token symbol. */
  async findByTokenSymbol(tenant: TenantContext, symbol: string): Promise<Offering | undefined> {
    const scope = this.scopeFilter(tenant);
    const bySymbol = sql`upper(${offerings.tokenSymbol}) = upper(${symbol})`;
    const where = scope ? and(bySymbol, scope) : bySymbol;
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx.select().from(offerings).where(where).limit(1),
    );
    return row;
  }

  /**
   * What a signed-in investor may see: every public offering, plus private
   * placements when they are accredited.
   *
   * Private placements are restricted to accredited investors, so `accredited`
   * comes from the person's own record — never from the request.
   */
  async listVisibleToInvestor(accredited: boolean): Promise<Offering[]> {
    const visible = accredited
      ? or(eq(offerings.visibility, 'public'), eq(offerings.visibility, 'private'))
      : eq(offerings.visibility, 'public');
    return this.db.scoped({ kind: 'platform' }, (tx) =>
      tx
        .select()
        .from(offerings)
        .where(
          and(
            visible,
            or(eq(offerings.status, 'open'), eq(offerings.status, 'coming_soon')),
          ),
        )
        .orderBy(asc(offerings.sortOrder), desc(offerings.createdAt)),
    );
  }

  /** Public marketplace listing — no session, so no tenant. Platform scope. */
  async listPublic(): Promise<Offering[]> {
    return this.db.scoped({ kind: 'platform' }, (tx) =>
      tx
        .select()
        .from(offerings)
        .where(
          and(
            eq(offerings.visibility, 'public'),
            or(eq(offerings.status, 'open'), eq(offerings.status, 'coming_soon')),
          ),
        )
        .orderBy(asc(offerings.sortOrder), desc(offerings.createdAt)),
    );
  }

  /**
   * Create an offering for an issuer.
   *
   * `issuerId` comes from the caller's TENANT, never the body — the RLS WITH
   * CHECK on offerings enforces the same thing, so a bug here still cannot
   * create an asset under someone else's issuer.
   */
  async create(
    tenant: TenantContext,
    issuerId: string,
    input: NewOfferingInput,
  ): Promise<Offering> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx
        .insert(offerings)
        .values({ ...input, issuerId, status: 'coming_soon' })
        .returning(),
    );
    return row;
  }

  async update(
    tenant: TenantContext,
    id: string,
    patch: Partial<NewOfferingInput> & { status?: string },
  ): Promise<Offering | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx
        .update(offerings)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(offerings.id, id))
        .returning(),
    );
    return row;
  }

  /**
   * Delete an offering.
   *
   * Refuses once a token exists: the asset is on-chain and holders may exist, so
   * removing the row would orphan real holdings. Callers close instead.
   */
  async remove(tenant: TenantContext, id: string): Promise<boolean> {
    const rows = await this.db.scoped(tenant, (tx) =>
      tx
        .delete(offerings)
        .where(and(eq(offerings.id, id), sql`${offerings.tokenSymbol} IS NULL`))
        .returning({ id: offerings.id }),
    );
    return rows.length > 0;
  }

  /** Record the deployed token on the offering. */
  async setTokenSymbol(tenant: TenantContext, id: string, symbol: string): Promise<void> {
    await this.db.scoped(tenant, (tx) =>
      tx
        .update(offerings)
        .set({ tokenSymbol: symbol, updatedAt: new Date() })
        .where(eq(offerings.id, id)),
    );
  }

  /**
   * Insert the authoritative token row (migration 039).
   *
   * Written here rather than by the indexer so that `tokens` exists the moment
   * a suite is deployed — every tenant scope for that asset depends on it.
   */
  async recordToken(
    tenant: TenantContext,
    t: { network: string; symbol: string; issuerId: string; address: string },
  ): Promise<void> {
    await this.db.scoped(tenant, (tx) =>
      tx.insert(tokens).values(t).onConflictDoNothing(),
    );
  }

  /** One issuer's offerings — the assets slice of the SPV detail panel. */
  listForIssuer(tenant: TenantContext, issuerId: string): Promise<Offering[]> {
    return this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(offerings)
        .where(eq(offerings.issuerId, issuerId))
        .orderBy(asc(offerings.sortOrder), asc(offerings.id)),
    );
  }

  /**
   * Holder count + tokens issued for a token, from the indexed balances.
   * Worker read: these are the public marketplace's aggregate stats, the same
   * numbers every visitor sees — not tenant-gated data.
   */
  async holderStats(tokenAddress: string): Promise<{ tokensIssued: number; holders: number }> {
    const rows = await this.db.worker('offerings: holder stats', (tx) =>
      tx.execute(sql`
        SELECT COUNT(*)::int AS holders, COALESCE(SUM(balance),0) AS issued
          FROM balances WHERE token = ${tokenAddress.toLowerCase()} AND balance <> 0
      `),
    );
    const [row] = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
      holders: number;
      issued: string;
    }[];
    return { tokensIssued: Number(row?.issued ?? 0), holders: Number(row?.holders ?? 0) };
  }

  /** Realized income paid out for a token in a trailing window (view stat). */
  async distributedIncome(tokenSymbol: string, sinceDays: number): Promise<number> {
    const rows = await this.db.worker('offerings: realized income stat', (tx) =>
      tx.execute(sql`
        SELECT COALESCE(SUM(total_amount),0) AS t FROM distributions
         WHERE token_symbol = ${tokenSymbol}
           AND created_at > now() - (${String(sinceDays)} || ' days')::interval
      `),
    );
    const [row] = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
      t: string;
    }[];
    return Number(row?.t ?? 0);
  }

  /**
   * Is a symbol already a deployed token on ANY issuer? Worker connection on
   * purpose: symbols are globally unique on-chain (the factory salt derives
   * from them), so the check must see across tenants or it cannot answer.
   */
  async tokenSymbolInUse(symbol: string): Promise<boolean> {
    const rows = await this.db.worker('offerings: symbol uniqueness check', (tx) =>
      tx
        .select({ symbol: tokens.symbol })
        .from(tokens)
        .where(sql`upper(${tokens.symbol}) = upper(${symbol})`)
        .limit(1),
    );
    return rows.length > 0;
  }

  /** Worker read: resolve a symbol to an address globally. */
  async findTokenAddressBySymbol(symbol: string): Promise<string | undefined> {
    const rows = await this.db.worker('offerings: resolve token address', (tx) =>
      tx
        .select({ address: tokens.address })
        .from(tokens)
        .where(sql`upper(${tokens.symbol}) = upper(${symbol})`)
        .limit(1),
    );
    return rows[0]?.address;
  }
}
