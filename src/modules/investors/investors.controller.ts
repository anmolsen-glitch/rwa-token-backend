/**
 *   GET  /api/investors                      cap-table-scoped list (no PII)
 *   GET  /api/investors/:wallet              full record incl. PII — AUDITED
 *   PUT  /api/admin/investors/:wallet/acceptance   this issuer's reliance decision
 *
 * Note there is no "list every investor" route for issuers: RLS restricts the
 * list above to the caller's own cap table (TENANCY_MODEL.md §5.1).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { CurrentUser, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { InvestorsService } from './investors.service';
import { AcceptanceDecisionDto } from './dto/acceptance.dto';
import { RevokeClaimDto } from './dto/revoke-claim.dto';
import { TokenOperationsService } from '@modules/tokens/token-operations.service';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiConflict, ApiNotFound, ApiUnprocessable, ApiValidationError } from '@shared/openapi/api-error.decorator';

@ApiTags('Cap Table')
@ApiAuthErrors()
@Controller('admin/investors')
export class InvestorsController {
  constructor(
    private readonly investors: InvestorsService,
    private readonly operations: TokenOperationsService,
  ) {}

  @ApiOperation({
    summary: 'List investors on your cap table',
    description:
      'An issuer sees only investors holding or subscribed to ITS assets — never the ' +
      'platform\'s whole investor base. Returns summaries with NO PII, so browsing does ' +
      'not flood the audit trail and bury the reads that matter.',
  })
  @Get()
  list(@Tenant() tenant: TenantContext) {
    return this.investors.list(tenant);
  }

  @ApiOperation({
    summary: 'Full investor record (AUDITED)',
    description:
      'Includes PII (name, email) and this issuer\'s acceptance decision. EVERY ' +
      'non-self read writes an `investor.pii_read` audit row: who looked, at whose ' +
      'record, when, under which tenant. `acceptance.stale` is true when KYC has been ' +
      're-run since the decision — re-confirm before relying on it.',
  })
  @ApiParam({ name: 'wallet', description: 'Investor wallet address' })
  @ApiNotFound('Investor')
  @Get(':wallet')
  detail(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('wallet') wallet: string,
  ) {
    return this.investors.adminPanel(principal, tenant, wallet);
  }

  /* PUT, not POST: the decision is idempotent per (issuer, investor) — the same
     call twice must not create two decisions. */
  @ApiOperation({
    summary: 'Record this issuer\'s reliance decision',
    description:
      'Verify once (platform), accept per issuer. The issuer is taken from the verified ' +
      'token, never the request, so an issuer can only decide for itself — enforced again ' +
      'by an RLS WITH CHECK. Idempotent per (issuer, investor), hence PUT. Pins the ' +
      '`kyc_version` relied upon.',
  })
  @ApiParam({ name: 'wallet', description: 'Investor wallet address' })
  @ApiValidationError()
  @ApiNotFound('Investor')
  @ApiUnprocessable(
    'The wallet is not linked to an investor account. Acceptance is a decision about a PERSON, not an address.',
    'INVESTOR_HAS_NO_ACCOUNT',
  )
  @Put(':wallet/acceptance')
  @Roles('compliance', 'issuer_admin')
  decide(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('wallet') wallet: string,
    @Body() dto: AcceptanceDecisionDto,
  ) {
    return this.investors.decideAcceptance(principal, tenant, wallet, dto.status, dto.note);
  }

  @ApiOperation({
    summary: "Revoke an investor's KYC claim",
    description:
      'IDENTITY-LEVEL: this blocks the investor on EVERY asset at once, not one token. ' +
      'Done issuer-side (ClaimIssuer.revokeClaimBySignature) so it needs no investor key ' +
      'and works under KMS and the non-custodial model. Pass `caseId` to tie it to the ' +
      'legal case that authorises it — a revocation with no recorded justification is ' +
      'exactly what an audit will ask about.',
  })
  @ApiParam({ name: 'wallet' })
  @ApiNotFound('ONCHAINID for wallet')
  @ApiConflict('No KYC claim present to revoke.', 'NO_CLAIM')
  @Roles('compliance')
  @HttpCode(200)
  @Post(':wallet/revoke-claim')
  revokeClaim(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('wallet') wallet: string,
    @Body() dto: RevokeClaimDto,
  ) {
    return this.operations.revokeKyc(p, t, wallet, dto.caseId ?? undefined);
  }
}
