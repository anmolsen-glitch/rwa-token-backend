/**
 * Income distributions — rent and dividend payouts.
 *
 * DECLARE: the issuer (or the property's manager) declares a total for an
 * asset; we snapshot the cap table and allocate it pro-rata to each holder as a
 * claimable amount. CLAIM: the investor collects their share across every
 * wallet they have linked.
 *
 * Ported from ../rwa-token-backend/src/services/distributions.service.ts.
 *
 * The allocation is a SNAPSHOT taken at declaration time, and that is the
 * substantive rule: selling afterwards does not change what you were owed for
 * the period the payout covers, and buying afterwards does not earn you a share
 * of it. The chain is the register; the claim rows are what the register said
 * on the day.
 *
 * Money is integer paise throughout — `allocatePayout` uses the
 * largest-remainder method so the per-holder amounts sum to the declared total
 * EXACTLY. Independent rounding would leave the issuer a few paise short or
 * over on every payout, which is a reconciliation problem forever after.
 *
 * NOT CUSTODIAL, and worth being plain about: claiming marks the platform's
 * ledger paid. In dev nothing moves. A production deployment settles to a bank
 * or a stablecoin and reconciles against that — this module owns who is owed
 * what, not the movement of funds.
 */
import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { allocatePayout, toPaise } from '@shared/money/money';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { OfferingsRepository } from '@modules/offerings/offerings.repository';
import { ManagersService } from '@modules/managers/managers.service';
import { OnboardingService } from '@modules/onboarding/onboarding.service';
import { DistributionsRepository } from './distributions.repository';

@Injectable()
export class DistributionsService {
  constructor(
    private readonly repo: DistributionsRepository,
    private readonly tokens: TokensRepository,
    private readonly offerings: OfferingsRepository,
    private readonly managers: ManagersService,
    private readonly onboarding: OnboardingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Declare a payout for an asset.
   *
   * Two authorisation layers, and they answer different questions. The TOKEN
   * lookup is the tenant check — another issuer's symbol 404s here. Then
   * `assertOperates` narrows it further for a 'manager' principal, who may only
   * declare for the properties they actually run. An issuer_admin passes the
   * second check by definition; a manager needs both.
   */
  async declare(
    principal: Principal,
    tenant: TenantContext,
    symbol: string,
    input: { amount: string; note?: string | null },
  ) {
    const token = await this.tokens.require(tenant, symbol);

    /* Resolve the offering only to answer "does this manager run it?". A token
       with no offering row cannot be manager-operated, so a manager is refused
       and an issuer_admin is unaffected. */
    const offering = await this.offerings.findByTokenSymbol(tenant, token.symbol);
    await this.managers.assertOperates(principal, tenant, {
      id: offering?.id ?? token.symbol,
      managerId: offering?.managerId ?? null,
    });

    if (toPaise(input.amount) <= 0n) {
      throw new AppError('INVALID_AMOUNT', 400, 'Amount must be positive.');
    }

    const holders = await this.repo.holders(tenant, token.address);
    const supply = holders.reduce((s, h) => s + Number(h.balance), 0);
    if (supply <= 0) {
      /* Declaring against an empty cap table would create a payout with no
         claimants — money declared and owed to nobody. */
      throw AppError.conflict(
        'NO_HOLDERS',
        `${token.symbol} has no holders to distribute to.`,
      );
    }

    const allocation = allocatePayout(Number(input.amount), holders);
    const dist = await this.repo.declare(
      tenant,
      {
        tokenSymbol: token.symbol,
        totalAmount: input.amount,
        currency: 'INR',
        note: input.note ?? null,
        declaredByEmail: principal.email ?? null,
      },
      allocation,
    );

    await this.audit.record(principal, tenant, {
      action: 'distribution.declare',
      target: token.symbol,
      params: { distributionId: dist.id, totalAmount: input.amount, holders: holders.length },
    });

    return {
      id: dist.id,
      symbol: token.symbol,
      totalAmount: input.amount,
      currency: dist.currency,
      holders: holders.length,
      declaredAt: dist.createdAt.toISOString(),
    };
  }

  /** Past declarations for the caller's assets. */
  async list(tenant: TenantContext) {
    const rows = await this.repo.list(tenant);
    return {
      items: rows.map((d) => ({
        id: d.id,
        tokenSymbol: d.tokenSymbol,
        totalAmount: d.totalAmount,
        currency: d.currency,
        note: d.note,
        declaredByEmail: d.declaredByEmail,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  /**
   * An investor's claims across every wallet they have linked.
   *
   * Summed across wallets because one PERSON is owed the total, however many
   * addresses they held the asset across.
   */
  async forInvestor(connectedWallet: string) {
    const { tenant, wallets } = await this.walletsOf(connectedWallet);
    const claims = await this.repo.claimsForWallets(tenant, wallets);
    const claimable = claims.filter((c) => c.status === 'claimable');

    return {
      claimableTotal: claimable.reduce((s, c) => s + Number(c.amount), 0),
      currency: claims[0]?.currency ?? 'INR',
      items: claims.map((c) => ({
        id: c.id,
        tokenSymbol: c.tokenSymbol,
        amount: c.amount,
        currency: c.currency,
        note: c.note,
        status: c.status,
        claimedAt: c.claimedAt?.toISOString() ?? null,
        declaredAt: c.declaredAt.toISOString(),
      })),
    };
  }

  /**
   * Claim everything claimable.
   *
   * The `claimable -> claimed` transition happens in a single UPDATE with the
   * status in its WHERE clause, so two concurrent claims cannot both collect
   * the same rows — the loser matches nothing and gets NOTHING_TO_CLAIM rather
   * than a second payout.
   */
  async claim(principal: Principal, connectedWallet: string) {
    const { tenant, wallets, primary } = await this.walletsOf(connectedWallet);
    const { count, total } = await this.repo.claimAll(tenant, wallets);
    if (count === 0) {
      throw AppError.conflict('NOTHING_TO_CLAIM', 'Nothing to claim.');
    }

    await this.audit.record(principal, tenant, {
      action: 'distribution.claim',
      target: primary,
      params: { claims: count, total },
    });
    return { claims: count, total, currency: 'INR' };
  }

  private async walletsOf(connectedWallet: string) {
    const primary = await this.onboarding.resolvePrimaryWallet(connectedWallet);
    return {
      primary,
      wallets: await this.onboarding.walletsForPerson(primary),
      tenant: { kind: 'investor', investorWallet: primary } as TenantContext,
    };
  }
}
