/**
 *   POST /api/aml/:accountId/rescreen        re-screen every wallet
 *   GET  /api/aml/:accountId                 screening history (case file)
 *
 *   GET  /api/accreditation/candidates       KYC-approved, not yet accredited
 *   POST /api/accreditation/:accountId/approve
 *   POST /api/accreditation/:accountId/reject
 *
 * platform_admin only. Both are PLATFORM determinations relied upon by every
 * issuer — an issuer's officer making them would be deciding on behalf of their
 * competitors (TENANCY_MODEL.md §D2).
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { AmlService } from './aml.service';
import { AccreditationService } from './accreditation.service';
import { AccreditationDecisionDto, AccreditationRejectDto } from './dto/decision.dto';

@ApiTags('AML')
@ApiAuthErrors()
@Roles('platform_admin')
@Controller('admin/aml')
export class AmlController {
  constructor(private readonly aml: AmlService) {}

  @ApiOperation({
    summary: 'Re-screen every wallet this person controls',
    description:
      'Ongoing monitoring, or an investor disputing a flag. Each wallet is screened and ' +
      'recorded append-only, then the person-level status is recomputed as the WORST ' +
      'decision across their wallets — one clean wallet and one sanctioned wallet is ' +
      '`blocked`, never `clear`.',
  })
  @ApiParam({ name: 'accountId', description: 'Account id of the person' })
  @ApiNotFound('Account')
  @HttpCode(200)
  @Post(':accountId/rescreen')
  rescreen(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('accountId') accountId: string,
  ) {
    return this.aml.rescreen(principal, tenant, accountId);
  }

  @ApiOperation({
    summary: 'Screening history (compliance case file)',
    description:
      'Append-only: every screen ever run against every wallet the person controls, ' +
      'newest first, plus the current aggregate status.',
  })
  @ApiParam({ name: 'accountId', description: 'Account id of the person' })
  @ApiNotFound('Account')
  @Get(':accountId')
  history(@Param('accountId') accountId: string) {
    return this.aml.history(accountId);
  }
}

@ApiTags('Accreditation')
@ApiAuthErrors()
@Roles('platform_admin')
@Controller('admin/accreditation')
export class AccreditationController {
  constructor(private readonly accreditation: AccreditationService) {}

  @ApiOperation({
    summary: 'Review candidates',
    description: 'KYC-approved people who are not yet accredited. Exposes PII, so audited.',
  })
  @Get('candidates')
  candidates(@CurrentUser() principal: Principal, @Tenant() tenant: TenantContext) {
    return this.accreditation.candidates(principal, tenant);
  }

  @ApiOperation({
    summary: 'Grant accreditation',
    description:
      'OFF-CHAIN ONLY. Under the non-custodial model the platform cannot attach a claim ' +
      'to the investor\'s ONCHAINID — the ACCREDITED claim is signed at ' +
      '`/api/admin/onboarding/prepare` and submitted by the investor from their own wallet. ' +
      'Granting here is what unlocks that step.\n\n' +
      'Requires approved KYC, and refuses anyone blocked by AML screening.',
  })
  @ApiParam({ name: 'accountId', description: 'Account id of the person' })
  @ApiNotFound('Account')
  @ApiConflict('KYC must be approved before granting accreditation.', 'KYC_NOT_APPROVED')
  @ApiConflict('This person is blocked by AML screening.', 'AML_BLOCKED')
  @HttpCode(200)
  @Post(':accountId/approve')
  approve(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('accountId') accountId: string,
    @Body() dto: AccreditationDecisionDto,
  ) {
    return this.accreditation.decide(principal, tenant, accountId, true, dto.note);
  }

  @ApiOperation({
    summary: 'Revoke / reject accreditation',
    description:
      'ON-CHAIN, immediately. Revocation calls `ClaimIssuer.revokeClaimBySignature`, which ' +
      'the platform CAN do because it is revoking its own attestation — no cooperation ' +
      'from the investor is needed, so a privilege cannot be retained by declining to ' +
      'sign.\n\nBest-effort on-chain: a chain failure does not roll back the recorded ' +
      'decision, and the outcome is returned in `onchain` and audited so it is visible ' +
      'and re-runnable.',
  })
  @ApiParam({ name: 'accountId', description: 'Account id of the person' })
  @ApiValidationError()
  @ApiNotFound('Account')
  @HttpCode(200)
  @Post(':accountId/reject')
  reject(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('accountId') accountId: string,
    @Body() dto: AccreditationRejectDto,
  ) {
    return this.accreditation.decide(principal, tenant, accountId, false, dto.note);
  }
}
