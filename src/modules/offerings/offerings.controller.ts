/**
 *   GET /api/offerings          tenant-scoped list (issuer sees only its own)
 *   GET /api/offerings/public   open marketplace listing, no session required
 *   GET /api/offerings/:id      one offering, tenant-scoped
 */
import { Body, Controller, Delete, forwardRef, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, Public, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { ApiConflict, ApiUnprocessable, ApiValidationError } from '@shared/openapi/api-error.decorator';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import { OfferingsService } from './offerings.service';
import {
  CreateOfferingDto,
  DeployTokenDto,
  StatusDto,
  UpdateOfferingDto,
} from './dto/offering.dto';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiNotFound } from '@shared/openapi/api-error.decorator';

@ApiTags('Offerings')
@Controller('admin/offerings')
export class OfferingsController {
  constructor(
    private readonly offerings: OfferingsService,
    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /* Declared BEFORE :id — otherwise "public" is captured as an id. */
  @ApiOperation({
    summary: 'List offerings (tenant-scoped)',
    description:
      'An issuer_admin sees only its own offerings; platform_admin sees all. Enforced ' +
      'twice — by the repository predicate and by a Postgres RLS policy.',
  })
  @ApiAuthErrors()
  @Get()
  list(@Tenant() tenant: TenantContext) {
    return this.offerings.list(tenant);
  }

  @ApiOperation({ summary: 'Get one offering (tenant-scoped)' })
  @ApiParam({ name: 'id', description: 'Offering id, e.g. `csret`' })
  @ApiAuthErrors()
  @ApiNotFound('Offering')
  @Get(':id')
  findOne(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.offerings.findById(tenant, id);
  }
  @ApiOperation({
    summary: 'Create an offering',
    description:
      'The issuer comes from your TENANT, never the body — the RLS WITH CHECK enforces ' +
      'the same, so a bug here still cannot list an asset under another issuer. Requires ' +
      'APPROVED KYB: an unverified entity must not be able to list a security. Starts as ' +
      '`coming_soon`.',
  })
  @ApiValidationError()
  @ApiConflict('Your KYB is not approved.', 'KYB_NOT_APPROVED')
  @ApiConflict('An offering with that id already exists.', 'OFFERING_EXISTS')
  @Roles('issuer_admin')
  @HttpCode(201)
  @Post()
  create(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Body() dto: CreateOfferingDto) {
    return this.offerings.create(p, t, dto);
  }

  @ApiOperation({ summary: 'Update an offering' })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Offering')
  @Roles('issuer_admin')
  @Patch(':id')
  update(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateOfferingDto,
  ) {
    return this.offerings.update(p, t, id, dto);
  }

  @ApiOperation({
    summary: 'Delete an offering',
    description:
      'Refused once a token is deployed: the asset exists on-chain and may have holders, ' +
      'so removing the row would orphan real holdings. Close it instead.',
  })
  @ApiParam({ name: 'id' })
  @ApiNotFound('Offering')
  @ApiConflict('A token is deployed for this offering.', 'TOKEN_DEPLOYED')
  @Roles('issuer_admin')
  @Delete(':id')
  remove(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.offerings.remove(p, t, id);
  }

  @ApiOperation({
    summary: 'Set status (open / coming_soon / funded)',
    description:
      'Opening for investment requires a deployed token — otherwise the platform would ' +
      'take money for an asset it cannot mint.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Offering')
  @ApiConflict('Deploy the token before opening.', 'NO_TOKEN')
  @Roles('issuer_admin')
  @HttpCode(200)
  @Post(':id/status')
  setStatus(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: StatusDto,
  ) {
    return this.offerings.setStatus(p, t, id, dto.status);
  }

  @ApiOperation({
    summary: 'Deploy the T-REX token suite',
    description:
      'One factory call deploys Token + IdentityRegistry + ModularCompliance. The token ' +
      'OWNER is the ISSUER\'s wallet; the platform AGENT key operates it (compliance, not ' +
      'custody). An accredited-only offering binds BOTH claim topics, so isVerified — and ' +
      'therefore any mint or transfer — passes only for accredited holders.\n\n' +
      'Idempotent-ish: a suite the factory already knows is ADOPTED rather than ' +
      'redeployed, but only after proving the on-chain owner matches this issuer.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Offering')
  @ApiConflict('This offering already has a token.', 'ALREADY_DEPLOYED')
  @ApiConflict('That symbol is deployed and owned by someone else.', 'SYMBOL_OWNED_ELSEWHERE')
  @ApiUnprocessable('Set the issuer owner wallet first.', 'NO_OWNER_WALLET')
  @Roles('issuer_admin')
  @HttpCode(201)
  @Post(':id/deploy-token')
  deployToken(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: DeployTokenDto,
  ) {
    return this.offerings.deployToken(p, t, id, dto);
  }

  @ApiOperation({
    summary: 'Close an escrowed raise',
    description:
      'Settles every paid order if the escrowed total meets the minimum raise, otherwise ' +
      'refunds them all. The outcome is committed ATOMICALLY FIRST — one close decides, ' +
      'and from that moment new orders are rejected and late payments auto-refund. ' +
      'RE-RUNNABLE: leftovers from a failed refund stay `paid` and a re-run follows the ' +
      'outcome already recorded rather than re-deciding. Only for offerings that HAVE a ' +
      'minimum raise; without one, orders settle on payment and there is nothing to close.',
  })
  @ApiParam({ name: 'id' })
  @ApiConflict('Already closed with nothing left to process.', 'ALREADY_CLOSED')
  @ApiConflict('Another request is closing this offering.', 'CLOSE_IN_PROGRESS')
  @Roles('issuer_admin')
  @HttpCode(200)
  @Post(':id/close')
  close(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.subscriptions.closeOffering(p, t, id);
  }
}

/**
 * The public marketplace — deliberately a SEPARATE controller, not a @Public()
 * route hiding inside the admin one.
 *
 * Different audience, different path prefix, and no session at all. Keeping it
 * here means `grep '@Controller(.admin'` is an accurate list of the back-office
 * surface, and nobody has to notice one decorator to know this is world-readable.
 */
@ApiTags('Offerings')
@Controller('offerings')
export class PublicOfferingsController {
  constructor(private readonly offerings: OfferingsService) {}

  @Public()
  @ApiOperation({
    summary: 'Public marketplace listing',
    description:
      'Open and coming-soon offerings across ALL issuers. No session required — browsing ' +
      'is cross-issuer by design.',
  })
  @Get('public')
  listPublic() {
    return this.offerings.listPublic();
  }
}
