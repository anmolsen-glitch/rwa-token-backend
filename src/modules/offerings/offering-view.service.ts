/**
 * The ENRICHED offering view — ported from
 * ../rwa-token-backend/src/services/offerings.service.ts `enrich()`.
 *
 * Both portals were built against this computed shape (tokens issued/available,
 * raised, pctFunded, holders, NAV per token, appreciation, realized yield,
 * lock-in days, the operating manager's card, an open buyback). The thin row
 * view the strangler port originally returned broke every screen that renders
 * those numbers, so this is a PARITY port: field names and semantics match the
 * Express output exactly.
 *
 * Money fields here are NUMBERS, deliberately breaking the string-money rule:
 * this is a display aggregate both frontends consume with arithmetic
 * (percentages, INR formatting), not a booking amount. Nothing here is written
 * back to the database.
 *
 * DB reads use the worker connection: these are the same aggregate stats every
 * marketplace visitor sees, and the public path has no tenant to scope by.
 * Chain reads (lock-in duration, token owner) are cached by token address —
 * both are fixed at deploy time.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppConfig } from '@shared/config/app-config.service';
import { ChainService } from '@shared/chain/chain.service';
import type { Offering } from '@shared/db/schema';
import { ManagersService } from '@modules/managers/managers.service';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { IssuersRepository } from '@modules/issuers/issuers.repository';
import { OfferingsRepository } from './offerings.repository';
import { OfferingFeaturesRepository } from './offering-features.repository';
import { RedisService } from '@shared/redis/redis.service';

const LOCKUP_ABI = ['function getLockupDuration(address compliance) view returns (uint256)'];

export interface EnrichedOffering {
  id: string;
  tokenSymbol: string | null;
  name: string;
  location: string | null;
  assetType: string | null;
  image: string | null;
  images: string[];
  description: string | null;
  currency: string;
  pricePerToken: number;
  minInvestment: number;
  maxInvestment: number | null;
  maxTokensPerInvestor: number | null;
  accreditedMaxInvestment: number | null;
  accreditedMaxTokensPerInvestor: number | null;
  requiresAccreditation: boolean;
  targetRaise: number;
  minimumRaise: number | null;
  yieldPct: number | null;
  targetYieldPct: number | null;
  realizedYieldPct: number | null;
  currentValuation: number;
  navPerToken: number;
  appreciationPct: number;
  valuationUpdatedAt: string | null;
  country: number;
  lockupDays: number | null;
  status: string;
  visibility: string;
  propertyType: string | null;
  cashFlowing: boolean;
  occupancyPct: number | null;
  managerId: string | null;
  manager: { id: string; name: string; company: string | null; bio: string | null; logoUrl: string | null; contactEmail: string | null } | null;
  issuerId: string | null;
  issuerName: string | null;
  ownerOccupied: boolean;
  sellerWallet: string | null;
  retainedPct: number | null;
  buyback: { active: boolean; pricePerToken: number; sellerWallet: string; remaining: number | null } | null;
  live: boolean;
  tokenAddress: string | null;
  owner: string | null;
  tokensIssued: number;
  tokensTotal: number;
  tokensAvailable: number;
  raised: number;
  pctFunded: number;
  holders: number;
}

@Injectable()
export class OfferingViewService {
  private readonly logger = new Logger(OfferingViewService.name);

  constructor(
    private readonly repo: OfferingsRepository,
    private readonly features: OfferingFeaturesRepository,
    private readonly tokens: TokensRepository,
    private readonly managers: ManagersService,
    private readonly issuerRepo: IssuersRepository,
    private readonly chain: ChainService,
    private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  async enrichAll(rows: Offering[]): Promise<EnrichedOffering[]> {
    const enriched = [];
    for (const row of rows) {
      enriched.push(await this.enrich(row));
    }
    return enriched;
  }

  async enrich(o: Offering): Promise<EnrichedOffering> {
    const num = (v: string | null): number | null => (v === null ? null : Number(v));
    const pricePerToken = Number(o.pricePerToken);
    const targetRaise = Number(o.targetRaise);
    const tokensTotal = pricePerToken > 0 ? Math.floor(targetRaise / pricePerToken) : 0;
    const maxInvestment = num(o.maxInvestment);
    const maxTokensPerInvestor =
      maxInvestment !== null && pricePerToken > 0 ? Math.floor(maxInvestment / pricePerToken) : null;
    const accreditedMaxInvestment = num(o.accreditedMaxInvestment);
    const accreditedMaxTokensPerInvestor =
      accreditedMaxInvestment !== null && pricePerToken > 0
        ? Math.floor(accreditedMaxInvestment / pricePerToken)
        : null;

    /* Valuation / NAV: the appraised value floats; the issuance price is fixed. */
    const currentValuation = o.currentValuation === null ? targetRaise : Number(o.currentValuation);
    const navPerToken =
      tokensTotal > 0 ? Math.round((currentValuation / tokensTotal) * 100) / 100 : pricePerToken;
    const appreciationPct =
      pricePerToken > 0
        ? Math.round(((navPerToken - pricePerToken) / pricePerToken) * 1000) / 10
        : 0;

    /* Yield: target is the issuer's projection; realized is trailing-12mo
       income against the current valuation. */
    const targetYieldPct = num(o.yieldPct);
    let realizedYieldPct: number | null = null;
    if (o.tokenSymbol && currentValuation > 0) {
      const income = await this.repo.distributedIncome(o.tokenSymbol, 365);
      realizedYieldPct = income > 0 ? Math.round((income / currentValuation) * 1000) / 10 : 0;
    }

    const base: EnrichedOffering = {
      id: o.id,
      tokenSymbol: o.tokenSymbol,
      name: o.name,
      location: o.location,
      assetType: o.assetType,
      image: o.image,
      images: o.images ?? [],
      description: o.description,
      currency: o.currency,
      pricePerToken,
      minInvestment: Number(o.minInvestment),
      maxInvestment,
      maxTokensPerInvestor,
      accreditedMaxInvestment,
      accreditedMaxTokensPerInvestor,
      requiresAccreditation: o.requiresAccreditation,
      targetRaise,
      minimumRaise: num(o.minimumRaise),
      yieldPct: targetYieldPct,
      targetYieldPct,
      realizedYieldPct,
      currentValuation,
      navPerToken,
      appreciationPct,
      valuationUpdatedAt: o.valuationUpdatedAt?.toISOString() ?? null,
      country: o.country,
      lockupDays: null,
      status: o.status,
      visibility: o.visibility,
      propertyType: o.propertyType,
      /* Cash-flowing if flagged by the admin OR it has actually paid income. */
      cashFlowing: o.cashFlowing || (realizedYieldPct !== null && realizedYieldPct > 0),
      occupancyPct: num(o.occupancyPct),
      managerId: o.managerId,
      manager: null,
      issuerId: o.issuerId,
      issuerName: null,
      ownerOccupied: o.ownerOccupied,
      sellerWallet: o.sellerWallet,
      retainedPct: num(o.retainedPct),
      buyback: null,
      live: false,
      tokenAddress: null,
      owner: null,
      tokensIssued: 0,
      tokensTotal,
      tokensAvailable: tokensTotal,
      raised: 0,
      pctFunded: 0,
      holders: 0,
    };

    if (o.managerId) {
      base.manager = await this.managers.publicCard(o.managerId);
    }

    if (o.issuerId) {
      try {
        const issuer = await this.issuerRepo.findAnyTenant(o.issuerId);
        if (issuer) base.issuerName = issuer.name;
      } catch { /* non-critical — the name is a display convenience */ }
    }

    /* Surface an open seller-buyback so holders know they can sell back. */
    const bb = await this.features.openBuybackAnyTenant(o.id);
    if (bb) {
      const remaining =
        bb.maxTokens == null ? null : Math.max(0, Number(bb.maxTokens) - Number(bb.tokensBought));
      base.buyback = {
        active: true,
        pricePerToken: Number(bb.pricePerToken),
        sellerWallet: bb.sellerWallet,
        remaining,
      };
    }

    const token = o.tokenSymbol ? await this.tokens.findAnyTenant(o.tokenSymbol) : undefined;
    if (!token) return base;

    const [{ tokensIssued, holders }, lockupDays, owner] = await Promise.all([
      this.repo.holderStats(token.address),
      this.lockupDaysFor(token.address),
      this.ownerOf(token.address),
    ]);
    const raised = tokensIssued * pricePerToken;
    return {
      ...base,
      lockupDays,
      live: true,
      tokenAddress: token.address,
      owner,
      tokensIssued,
      tokensAvailable: Math.max(tokensTotal - tokensIssued, 0),
      raised,
      pctFunded:
        targetRaise > 0 ? Math.min(Math.round((raised / targetRaise) * 1000) / 10, 100) : 0,
      holders,
    };
  }

  /** Lock-in days from the on-chain lockup module; null when unreadable. */
  private async lockupDaysFor(tokenAddress: string): Promise<number | null> {
    try {
      const cached = await this.redis.client.get(`token:lockup:${tokenAddress}`);
      if (cached !== null) {
        this.logger.debug(`CACHE HIT: lockupDaysFor ${tokenAddress}`);
        return cached === '-1' ? null : Number(cached);
      }
    } catch (err) { 
      this.logger.error(`CACHE ERROR: lockupDaysFor ${tokenAddress}`, err);
    }
    
    this.logger.debug(`CACHE MISS: lockupDaysFor ${tokenAddress} - Fetching from RPC`);
    const moduleAddr = this.config.get('LOCKUP_MODULE');
    if (!moduleAddr) return null;
    try {
      const compliance = (await this.chain.token(tokenAddress).compliance()) as string;
      const lockup = new ethers.Contract(moduleAddr, LOCKUP_ABI, this.chain.provider);
      const days = Math.round(Number(await lockup.getLockupDuration(compliance)) / 86400);
      try {
        await this.redis.client.set(`token:lockup:${tokenAddress}`, days.toString(), 'EX', 300);
      } catch { /* ignore */ }
      return days;
    } catch {
      // It failed, meaning no lockup module or another error. Cache it as -1 to prevent retries.
      try {
        await this.redis.client.set(`token:lockup:${tokenAddress}`, '-1', 'EX', 300);
      } catch { /* ignore */ }
      return null;
    }
  }

  private async ownerOf(tokenAddress: string): Promise<string | null> {
    try {
      const cached = await this.redis.client.get(`token:owner:${tokenAddress}`);
      if (cached !== null) {
        this.logger.debug(`CACHE HIT: ownerOf ${tokenAddress}`);
        return cached === '-1' ? null : cached;
      }
    } catch (err) {
      this.logger.error(`CACHE ERROR: ownerOf ${tokenAddress}`, err);
    }

    this.logger.debug(`CACHE MISS: ownerOf ${tokenAddress} - Fetching from RPC`);
    try {
      const owner = (await this.chain.token(tokenAddress).owner()) as string;
      try {
        await this.redis.client.set(`token:owner:${tokenAddress}`, owner, 'EX', 300);
      } catch { /* ignore */ }
      return owner;
    } catch (err) {
      this.logger.warn({ err, tokenAddress }, 'offering view: owner read failed');
      try {
        await this.redis.client.set(`token:owner:${tokenAddress}`, '-1', 'EX', 300);
      } catch { /* ignore */ }
      return null;
    }
  }
}
