/**
 *   GET  /api/kyc/pending                     review queue
 *   POST /api/kyc/:wallet/start-verifying     'applied' -> 'verifying'
 *   POST /api/kyc/:wallet/approve             -> 'completed', bumps kyc_version
 *   POST /api/kyc/:wallet/reject              -> 'rejected' (reason required)
 *
 * PLATFORM-ONLY, by design. Verification is performed once by the platform and
 * relied upon by every issuer (TENANCY_MODEL.md §D2) — letting one issuer's
 * compliance officer approve would have them verifying an investor on behalf of
 * their competitors. Issuers decide ACCEPTANCE instead:
 * PUT /api/admin/investors/:wallet/acceptance.
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { KycService } from './kyc.service';
import { KycDecisionDto, KycRejectDto } from './dto/decision.dto';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiConflict, ApiNotFound, ApiValidationError } from '@shared/openapi/api-error.decorator';

@ApiTags('KYC')
@ApiAuthErrors()
@Controller('admin/kyc')
@Roles('platform_admin')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @ApiOperation({
    summary: 'Review queue',
    description:
      'Submissions in `applied` or `verifying`. PLATFORM-ONLY: verification is performed ' +
      'once and relied upon by every issuer, so an issuer\'s officer approving would be ' +
      'verifying an investor on behalf of their competitors. Issuers record ACCEPTANCE ' +
      'instead (`PUT /api/admin/investors/{wallet}/acceptance`). The queue exposes PII, so the ' +
      'read is audited.\n\n' +
      'Entries may have `walletCount: 0` — that is normal. The flow is sign up -> KYC -> ' +
      'connect wallet, so a person is reviewed BEFORE they have a wallet.',
  })
  @Get('pending')
  pending(@CurrentUser() principal: Principal, @Tenant() tenant: TenantContext) {
    return this.kyc.pending(principal, tenant);
  }

  @ApiOperation({ summary: "Claim a submission for review ('applied' -> 'verifying')" })
  @ApiParam({
    name: 'subject',
    description:
      'Account id, OR a wallet address which is resolved through to its account. ' +
      'KYC is a property of the PERSON, so the account is the real subject.',
  })
  @ApiNotFound('KYC submission')
  @ApiConflict('KYC is not awaiting review.', 'KYC_NOT_AWAITING_REVIEW')
  @Post(':subject/start-verifying')
  @HttpCode(200)
  startVerifying(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('subject') subject: string,
  ) {
    return this.kyc.startVerifying(principal, tenant, subject);
  }

  @ApiOperation({
    summary: 'Approve KYC',
    description:
      'Sets `completed` and BUMPS `kyc_version`. The bump supersedes every issuer\'s prior ' +
      'reliance, so their acceptance shows `stale: true` until re-confirmed. Re-approving ' +
      'an already-approved investor is a no-op — a spurious bump would stale every ' +
      'acceptance for nothing.\n\n' +
      'NO CHAIN WRITE HAPPENS HERE: under the non-custodial model the claim is signed ' +
      'later at `/api/admin/onboarding/prepare` and submitted by the investor. Approval is what ' +
      'makes that step permissible.',
  })
  @ApiParam({
    name: 'subject',
    description:
      'Account id, OR a wallet address which is resolved through to its account. ' +
      'KYC is a property of the PERSON, so the account is the real subject.',
  })
  @ApiNotFound('KYC submission')
  @Post(':subject/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('subject') subject: string,
    @Body() dto: KycDecisionDto,
  ) {
    return this.kyc.decide(principal, tenant, subject, true, dto.note);
  }

  @ApiOperation({
    summary: 'Reject KYC',
    description:
      'Sets `rejected`, records the reason, and stamps the re-apply cooldown. Does NOT ' +
      'bump `kyc_version` — no new verification happened, so nothing an issuer relied on ' +
      'changed. A reason is required: a rejection without one is useless to the investor ' +
      'and to an auditor.',
  })
  @ApiParam({
    name: 'subject',
    description:
      'Account id, OR a wallet address which is resolved through to its account. ' +
      'KYC is a property of the PERSON, so the account is the real subject.',
  })
  @ApiValidationError()
  @ApiNotFound('KYC submission')
  @Post(':subject/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('subject') subject: string,
    @Body() dto: KycRejectDto,
  ) {
    return this.kyc.decide(principal, tenant, subject, false, dto.note);
  }
}
