import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { AppConfig } from '@shared/config/app-config.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { Offering } from '@shared/db/schema';
import { IssuersRepository } from '@modules/issuers/issuers.repository';
import { DeployService } from './deploy.service';
import { OfferingsRepository, type NewOfferingInput } from './offerings.repository';
import type { CreateAssetDto } from './dto/create-asset.dto';

/** Documents the wizard collects on an asset before it can be listed. */
export const REQUIRED_ASSET_DOCS = ['Title Deed', 'Valuation Report', 'SPV Ownership Proof'] as const;

/**
 * Wire shape for an offering.
 *
 * Money is NUMERIC in Postgres and arrives as a string. It stays a string on
 * the wire — JSON numbers are IEEE doubles and would silently round paise.
 * Clients format; they never arithmetic on these directly.
 */
export interface OfferingView {
  id: string;
  name: string;
  tokenSymbol: string | null;
  issuerId: string;
  status: string;
  location: string | null;
  assetType: string | null;
  currency: string;
  pricePerToken: string;
  minInvestment: string;
  targetRaise: string;
  yieldPct: string | null;
  country: number;
  image: string | null;
  createdAt: string;
}

@Injectable()
export class OfferingsService {
  constructor(
    private readonly repo: OfferingsRepository,
    private readonly issuers: IssuersRepository,
    private readonly deploy: DeployService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /** The caller's own issuer, or a 403 for anyone who has none. */
  private static issuerIdOf(tenant: TenantContext): string {
    if (tenant.kind !== 'issuer') {
      throw AppError.forbidden('Only an issuer can manage offerings.');
    }
    return tenant.issuerId;
  }

  private static view(o: Offering): OfferingView {
    return {
      id: o.id,
      name: o.name,
      tokenSymbol: o.tokenSymbol,
      issuerId: o.issuerId,
      status: o.status,
      location: o.location,
      assetType: o.assetType,
      currency: o.currency,
      pricePerToken: o.pricePerToken,
      minInvestment: o.minInvestment,
      targetRaise: o.targetRaise,
      yieldPct: o.yieldPct,
      country: o.country,
      image: o.image,
      createdAt: o.createdAt.toISOString(),
    };
  }

  async list(tenant: TenantContext): Promise<{ items: OfferingView[] }> {
    const rows = await this.repo.list(tenant);
    return { items: rows.map(OfferingsService.view) };
  }

  async listPublic(): Promise<{ items: OfferingView[] }> {
    const rows = await this.repo.listPublic();
    return { items: rows.map(OfferingsService.view) };
  }

  async findById(tenant: TenantContext, id: string): Promise<OfferingView> {
    const row = await this.repo.findById(tenant, id);
    /* 404 rather than 403 when it exists but belongs to another issuer:
       "this id exists but is not yours" is itself a cross-tenant disclosure. */
    if (!row) throw AppError.notFound('Offering', id);
    return OfferingsService.view(row);
  }

  /**
   * Create an offering.
   *
   * The issuer comes from the TENANT, never the body. Requires approved KYB:
   * an unverified entity must not be able to list a security.
   */
  async create(
    principal: Principal,
    tenant: TenantContext,
    input: NewOfferingInput & { requiresAccreditation?: boolean },
  ): Promise<OfferingView> {
    const issuerId = OfferingsService.issuerIdOf(tenant);

    const issuer = await this.issuers.findById(tenant, issuerId);
    if (!issuer) throw AppError.notFound('Issuer', issuerId);
    if (issuer.kybStatus !== 'approved') {
      throw AppError.conflict(
        'KYB_NOT_APPROVED',
        'Your KYB must be approved before you can list an offering.',
        { kybStatus: issuer.kybStatus },
      );
    }

    const existing = await this.repo.findById(tenant, input.id);
    if (existing) {
      throw AppError.conflict('OFFERING_EXISTS', `An offering with id "${input.id}" already exists.`);
    }

    const row = await this.repo.create(tenant, issuerId, input);
    await this.audit.record(principal, tenant, {
      action: 'offering.create',
      target: row.id,
      params: { name: input.name, requiresAccreditation: input.requiresAccreditation ?? false },
    });
    return OfferingsService.view(row);
  }

  async update(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    patch: Partial<NewOfferingInput>,
  ): Promise<OfferingView> {
    OfferingsService.issuerIdOf(tenant);
    const row = await this.repo.update(tenant, id, patch);
    /* RLS already hid another issuer's offering, so a miss is a 404 either way. */
    if (!row) throw AppError.notFound('Offering', id);

    await this.audit.record(principal, tenant, {
      action: 'offering.update',
      target: id,
      params: { fields: Object.keys(patch) },
    });
    return OfferingsService.view(row);
  }

  /**
   * Delete an offering.
   *
   * Refused once a token exists: the asset is on-chain and may have holders, so
   * removing the row would orphan real holdings. Close it instead.
   */
  async remove(principal: Principal, tenant: TenantContext, id: string): Promise<{ ok: true }> {
    OfferingsService.issuerIdOf(tenant);
    const existing = await this.repo.findById(tenant, id);
    if (!existing) throw AppError.notFound('Offering', id);
    if (existing.tokenSymbol) {
      throw AppError.conflict(
        'TOKEN_DEPLOYED',
        'This offering has a deployed token and cannot be deleted. Close it instead.',
        { tokenSymbol: existing.tokenSymbol },
      );
    }
    const removed = await this.repo.remove(tenant, id);
    if (!removed) throw AppError.notFound('Offering', id);

    await this.audit.record(principal, tenant, { action: 'offering.delete', target: id });
    return { ok: true };
  }

  async setStatus(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    status: string,
  ): Promise<OfferingView> {
    OfferingsService.issuerIdOf(tenant);
    const existing = await this.repo.findById(tenant, id);
    if (!existing) throw AppError.notFound('Offering', id);
    if (status === 'open' && !existing.tokenSymbol) {
      /* Opening for investment without a token would take money for an asset
         that cannot be minted. */
      throw AppError.conflict(
        'NO_TOKEN',
        'Deploy the token before opening this offering for investment.',
      );
    }
    const row = await this.repo.update(tenant, id, { status });
    if (!row) throw AppError.notFound('Offering', id);
    await this.audit.record(principal, tenant, {
      action: 'offering.status',
      target: id,
      params: { from: existing.status, to: status },
    });
    return OfferingsService.view(row);
  }

  /**
   * Deploy the token suite for this offering.
   *
   * Records the `tokens` row FIRST-CLASS (migration 039) rather than leaving it
   * to the indexer: every tenant scope for this asset resolves through that
   * table, so it must exist the moment the suite does.
   */
  async deployToken(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    input: { symbol: string; decimals: number; maxHolders?: number; lockupDays?: number },
  ) {
    const issuerId = OfferingsService.issuerIdOf(tenant);
    const offering = await this.repo.findById(tenant, id);
    if (!offering) throw AppError.notFound('Offering', id);
    if (offering.tokenSymbol) {
      throw AppError.conflict(
        'ALREADY_DEPLOYED',
        `This offering already has token ${offering.tokenSymbol}.`,
      );
    }
    if (await this.repo.tokenSymbolInUse(input.symbol)) {
      throw AppError.conflict(
        'TOKEN_SYMBOL_EXISTS',
        `A token "${input.symbol}" already exists.`,
        { symbol: input.symbol },
      );
    }

    const issuer = await this.issuers.findById(tenant, issuerId);
    if (!issuer) throw AppError.notFound('Issuer', issuerId);
    if (issuer.kybStatus !== 'approved') {
      throw AppError.conflict('KYB_NOT_APPROVED', 'Your KYB must be approved before deploying.');
    }
    if (!issuer.ownerWallet) {
      /* The suite's OWNER is the issuer's wallet. Deploying without one would
         make the platform the owner of the issuer's asset. */
      throw AppError.unprocessable(
        'NO_OWNER_WALLET',
        'Set the issuer owner wallet before deploying — it becomes the token owner on-chain.',
      );
    }

    /* Fall back to what the create-asset wizard recorded, so deploying is a
       one-click confirmation of choices already made, not a re-entry of them.
       The accredited-only flag comes from the COLUMN — never the plan. */
    const plan = (offering.tokenPlan ?? {}) as {
      tokenName?: string;
      maxHolders?: number;
      lockupDays?: number;
      intendedStatus?: string;
    };

    const { address, adopted } = await this.deploy.deploySuite({
      name: plan.tokenName?.trim() || offering.name,
      symbol: input.symbol,
      decimals: input.decimals,
      ownerWallet: issuer.ownerWallet,
      maxHolders: input.maxHolders ?? plan.maxHolders ?? 500,
      lockupDays: input.lockupDays ?? plan.lockupDays ?? 0,
      requiresAccreditation: offering.requiresAccreditation,
    });

    await this.repo.recordToken(tenant, {
      network: this.config.get('NETWORK'),
      symbol: input.symbol,
      issuerId,
      address,
    });
    await this.repo.setTokenSymbol(tenant, id, input.symbol);

    /* A listing created as "Live" waited at coming_soon because it had no
       token to invest in. It has one now — apply the operator's original
       choice. */
    if (plan.intendedStatus === 'open' && offering.status === 'coming_soon') {
      await this.repo.update(tenant, id, { status: 'open' });
    }

    await this.audit.record(principal, tenant, {
      action: 'offering.deploy_token',
      target: id,
      params: { symbol: input.symbol, address, adopted },
    });

    return { offeringId: id, symbol: input.symbol, address, adopted };
  }

  /**
   * Create an asset from the wizard: the LISTING plus a recorded token PLAN.
   *
   * Ported from ../rwa-token-backend/src/services/issuers.service.ts
   * createAsset — minus the `deployNow` one-shot, deliberately. The two commits
   * (Postgres row, on-chain suite) cannot be atomic, so the durable record goes
   * first and the deploy is its own retryable step (`deployToken` above, whose
   * adoption path recovers an interrupted attempt). A single request doing both
   * is the shape that needed a write-ahead `pending_deploys` table and a
   * recovery sweeper; splitting the steps removes that failure mode instead of
   * managing it.
   *
   * The issuer named in the PATH is a filter that must agree with the caller's
   * tenant — an issuer may only name itself; the platform operator may name
   * anyone (audited, like every platform action).
   */
  async createAsset(
    principal: Principal,
    tenant: TenantContext,
    issuerId: string,
    input: CreateAssetDto,
  ) {
    if (tenant.kind === 'issuer' && tenant.issuerId !== issuerId) {
      /* 404, not 403: "that issuer exists but is not yours" is a disclosure. */
      throw AppError.notFound('Issuer', issuerId);
    }
    if (tenant.kind !== 'issuer' && tenant.kind !== 'platform') {
      throw AppError.forbidden('Only issuer or platform staff can create assets.');
    }

    if (input.deployNow) {
      throw AppError.unprocessable(
        'DEPLOY_IS_SEPARATE',
        'Asset creation no longer deploys in the same request. Create the listing, then call POST /api/admin/offerings/:id/deploy-token — it is safe to retry.',
      );
    }

    const issuer = await this.issuers.findById(tenant, issuerId);
    if (!issuer) throw AppError.notFound('Issuer', issuerId);
    if (issuer.kybStatus !== 'approved') {
      throw AppError.conflict(
        'KYB_NOT_APPROVED',
        'Issuer KYB must be approved before listing an asset.',
        { kybStatus: issuer.kybStatus },
      );
    }
    if (!issuer.ownerWallet) {
      throw AppError.unprocessable(
        'NO_OWNER_WALLET',
        'Set the issuer owner wallet first — it becomes the token owner on-chain.',
      );
    }

    /* Supply is DERIVED from targetRaise / pricePerToken. A stated total that
       disagrees means the operator was shown one number while the platform
       would enforce another — reject rather than silently pick one. */
    if (input.totalTokens != null) {
      const price = Number(input.pricePerToken);
      if (!(price > 0)) {
        throw AppError.unprocessable('PRICE_REQUIRED', 'Price per token must be greater than zero.');
      }
      const derived = Number(input.targetRaise) / price;
      if (Math.abs(derived - input.totalTokens) > 0.5) {
        throw AppError.unprocessable(
          'SUPPLY_MISMATCH',
          `Total tokens (${input.totalTokens}) doesn't match the raise: ${input.targetRaise} / ${input.pricePerToken} = ${Math.round(derived)}.`,
        );
      }
    }

    /* Every required document must be present WITH a URL before listing. */
    const provided = new Map((input.documents ?? []).map((d) => [d.type, d]));
    const missing = REQUIRED_ASSET_DOCS.filter((t) => !provided.get(t)?.url);
    if (missing.length) {
      throw AppError.unprocessable(
        'MISSING_DOCUMENTS',
        `Missing required document(s): ${missing.join(', ')}.`,
        { missing },
      );
    }

    const symbol = input.symbol.trim().toUpperCase();
    const id = symbol.toLowerCase();

    /* Fail early if the symbol is already spoken for, not at deploy time. */
    if (await this.repo.tokenSymbolInUse(symbol)) {
      throw AppError.conflict('TOKEN_SYMBOL_EXISTS', `A token "${symbol}" already exists.`, {
        symbol,
      });
    }
    if (await this.repo.findById(tenant, id)) {
      throw AppError.conflict('OFFERING_EXISTS', `An offering with id "${id}" already exists.`);
    }

    /* Everything the deploy step will need, plus the status to apply once a
       token exists — an offering cannot be `open` before it can be invested
       in, so a wizard asking for "Live" records the intent here and
       deployToken applies it. */
    const tokenPlan = {
      symbol,
      tokenName: input.tokenName?.trim() || input.name,
      maxHolders: input.maxHolders ?? 500,
      lockupDays: input.lockupDays ?? 0,
      requiresAccreditation: input.requiresAccreditation === true,
      intendedStatus: input.status ?? 'open',
    };

    const row = await this.repo.create(tenant, issuerId, {
      id,
      name: input.name,
      location: input.location ?? null,
      assetType: input.assetType ?? null,
      image: input.image ?? input.images?.[0] ?? null,
      description: input.description ?? null,
      currency: input.currency,
      pricePerToken: input.pricePerToken,
      minInvestment: input.minInvestment,
      maxInvestment: input.maxInvestment ?? null,
      accreditedMaxInvestment: input.accreditedMaxInvestment ?? null,
      requiresAccreditation: input.requiresAccreditation === true,
      targetRaise: input.targetRaise,
      minimumRaise: input.minimumRaise ?? null,
      yieldPct: input.yieldPct ?? null,
      country: input.country,
      visibility: input.visibility === 'private' ? 'private' : 'public',
      propertyType: input.propertyType ?? null,
      occupancyPct: input.occupancyPct ?? null,
      ownerOccupied: input.ownerOccupied === true,
      sellerWallet: input.sellerWallet ?? null,
      retainedPct: input.retainedPct ?? null,
      currentValuation: input.propertyValue ?? null,
      images: input.images ?? [],
      documents: input.documents ?? [],
      tokenPlan,
    });

    await this.audit.record(principal, tenant, {
      action: 'asset.create',
      target: issuerId,
      params: { symbol, name: input.name, deployed: false },
    });

    return {
      token: null,
      offering: OfferingsService.view(row),
      nextStep: 'Deploy the token from Offerings → Deploy token.',
    };
  }
}
