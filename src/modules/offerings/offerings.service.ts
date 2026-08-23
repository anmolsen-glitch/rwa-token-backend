import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { AppConfig } from '@shared/config/app-config.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { Offering } from '@shared/db/schema';
import { IssuersRepository } from '@modules/issuers/issuers.repository';
import { DeployService } from './deploy.service';
import { OfferingsRepository, type NewOfferingInput } from './offerings.repository';

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
    input: { symbol: string; decimals: number; maxHolders: number; lockupDays: number },
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

    const { address, adopted } = await this.deploy.deploySuite({
      name: offering.name,
      symbol: input.symbol,
      decimals: input.decimals,
      ownerWallet: issuer.ownerWallet,
      maxHolders: input.maxHolders,
      lockupDays: input.lockupDays,
      requiresAccreditation: offering.requiresAccreditation,
    });

    await this.repo.recordToken(tenant, {
      network: this.config.get('NETWORK'),
      symbol: input.symbol,
      issuerId,
      address,
    });
    await this.repo.setTokenSymbol(tenant, id, input.symbol);

    await this.audit.record(principal, tenant, {
      action: 'offering.deploy_token',
      target: id,
      params: { symbol: input.symbol, address, adopted },
    });

    return { offeringId: id, symbol: input.symbol, address, adopted };
  }
}
