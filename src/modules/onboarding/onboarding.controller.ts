/**
 *   POST /api/admin/onboarding/prepare   sign claims for the investor to submit
 *   POST /api/admin/onboarding/confirm   register the identity (agent) once on-chain
 *   GET  /api/onboarding/status    where an investor stands, no writes
 *
 * The gap between prepare and confirm is the investor calling addClaim from
 * their own wallet. The platform cannot do it for them — that is what
 * non-custodial means here.
 */
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles, Session, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';
import { OnboardingService } from './onboarding.service';
import { InvestorOnboardDto, OnboardRequestDto } from './dto/onboard.dto';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiConflict, ApiValidationError } from '@shared/openapi/api-error.decorator';

@ApiTags('Onboarding')
@ApiAuthErrors()
@Controller('admin/onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @ApiOperation({
    summary: 'Phase 1 — sign claims for the investor to submit',
    description:
      'NON-CUSTODIAL. Ensures a live ONCHAINID exists (the platform deploys it and pays ' +
      'gas, but the INVESTOR\'s wallet is its management key), then signs one claim per ' +
      'required topic and returns the payloads. It does NOT send addClaim — only a key on ' +
      'the investor\'s own identity may do that, and the platform holds none.\n\n' +
      '**Next:** the investor calls `identity.addClaim(topic, scheme, issuer, signature, ' +
      'data, uri)` from their wallet, then you call `/confirm`.\n\n' +
      'Topics already present and valid are skipped, so re-running costs the investor nothing.',
  })
  @ApiValidationError()
  @Post('prepare')
  @Roles('compliance', 'issuer_admin')
  @HttpCode(200)
  prepare(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Body() dto: OnboardRequestDto,
  ) {
    /* `now` is passed in rather than read inside the service so the claim
       timestamp is injectable and the signing path stays deterministic in
       tests. */
    return this.onboarding.prepare(principal, tenant, dto.wallet, dto.tokenSymbol, new Date());
  }

  @ApiOperation({
    summary: 'Phase 3 — register the identity (platform-managed compliance)',
    description:
      'Uses the ERC-3643 AGENT key to register the investor in the token\'s ' +
      'IdentityRegistry. Refuses while required claims are missing on-chain, because ' +
      'registering an unverifiable identity produces a holder who cannot transfer and is ' +
      'painful to debug. Idempotent.',
  })
  @ApiValidationError()
  @ApiConflict('No ONCHAINID yet — call /prepare first.', 'NO_IDENTITY')
  @ApiConflict(
    'Required claims are not on-chain yet; the investor must submit them from their own wallet.',
    'CLAIMS_NOT_SUBMITTED',
  )
  @Post('confirm')
  @Roles('compliance', 'issuer_admin')
  @HttpCode(200)
  confirm(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Body() dto: OnboardRequestDto,
  ) {
    return this.onboarding.confirm(principal, tenant, dto.wallet, dto.tokenSymbol);
  }

  @ApiOperation({
    summary: 'Onboarding progress (read-only)',
    description: 'Identity, per-topic claim presence, registry membership, and isVerified. Sends nothing.',
  })
  @ApiQuery({ name: 'wallet', description: 'Investor wallet address' })
  @ApiQuery({ name: 'tokenSymbol', description: 'Token symbol, e.g. `MBWT`' })
  @Get('status')
  status(@Query('wallet') wallet: string, @Query('tokenSymbol') tokenSymbol: string) {
    return this.onboarding.status(wallet, tokenSymbol);
  }
}

/**
 * The INVESTOR-driven half of onboarding.
 *
 * This is the flow that actually runs in production, and it was missing: the
 * admin routes above exist for operators acting on someone's behalf (lost-key
 * recovery does exactly that), but in the non-custodial model it is the
 * investor who submits `addClaim` from their own wallet, so it is the investor
 * who must be able to call prepare and confirm.
 *
 * The wallet comes from the VERIFIED TOKEN, never the body — an investor may
 * only ever onboard themselves.
 */
@ApiTags('Investor')
@ApiAuthErrors()
@Session('investor')
@Controller('investor/onboard')
export class InvestorOnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  private static walletOf(p: Principal): string {
    if (!p.wallet) throw AppError.forbidden('Connect a wallet first.');
    return p.wallet;
  }

  @ApiOperation({
    summary: 'Phase 1 — get your signed claims',
    description:
      'Returns claim payloads for you to submit yourself. The platform deploys your ' +
      'ONCHAINID and pays the gas, but YOUR wallet is its management key, so only you can ' +
      'call addClaim. Re-running is free: topics already present and valid are skipped.',
  })
  @ApiValidationError()
  @HttpCode(200)
  @Post('start')
  start(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Body() dto: InvestorOnboardDto,
  ) {
    return this.onboarding.prepare(
      p,
      t,
      InvestorOnboardingController.walletOf(p),
      dto.tokenSymbol,
      new Date(),
    );
  }

  @ApiOperation({
    summary: 'Phase 2 — confirm and get registered',
    description:
      'Call after your addClaim transactions confirm. Verifies the claims are on-chain, ' +
      'then registers you in the asset\'s identity registry (an agent action — that is ' +
      'platform-managed compliance, not custody). Refuses if the claims are not there yet.',
  })
  @ApiValidationError()
  @ApiConflict('Claims are not on-chain yet.', 'CLAIMS_NOT_SUBMITTED')
  @HttpCode(200)
  @Post('complete')
  complete(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Body() dto: InvestorOnboardDto,
  ) {
    return this.onboarding.confirm(
      p,
      t,
      InvestorOnboardingController.walletOf(p),
      dto.tokenSymbol,
    );
  }
}
