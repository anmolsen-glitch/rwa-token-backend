/**
 *   GET /api/issuers      platform: all; issuer_admin: just its own
 *   GET /api/issuers/:id  scoped; 404 (not 403) when it belongs to someone else
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, Public, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { ApiConflict, ApiValidationError } from '@shared/openapi/api-error.decorator';
import { IssuersService, SPV_TYPES } from './issuers.service';
import {
  ApplyDto,
  CreateIssuerDto,
  KybDecisionDto,
  KybRejectDto,
  UpdateIssuerDto,
} from './dto/issuer.dto';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiNotFound } from '@shared/openapi/api-error.decorator';

@ApiTags('Issuers')
@ApiAuthErrors()
@Controller('admin/issuers')
export class IssuersController {
  constructor(private readonly issuers: IssuersService) {}

  @ApiOperation({
    summary: 'The closed list of SPV legal forms',
    description:
      'A fixed vocabulary, not free text: `spvType` feeds reporting and per-jurisdiction ' +
      'rules, and typo variants of "Private Limited" would fragment both. Declared BEFORE ' +
      "/:id so it cannot be matched as an issuer id.",
  })
  @Get('spv-types')
  spvTypes() {
    return { types: SPV_TYPES };
  }

  @ApiOperation({
    summary: 'List issuers',
    description:
      'platform_admin sees every issuer. An issuer_admin sees a ONE-element list ' +
      'containing only itself — the roster of issuers is the platform\'s book of business. ' +
      'Investors are refused.',
  })
  @Get()
  list(@Tenant() tenant: TenantContext) {
    return this.issuers.list(tenant);
  }

  @ApiOperation({
    summary: 'Full SPV detail',
    description:
      'The issuer plus its assets, its SPV managers (each with the property managers ' +
      'reporting to it), and any managers not yet under an SPV manager.',
  })
  @ApiParam({ name: 'id', description: 'Issuer id' })
  @ApiNotFound('Issuer')
  @Get(':id')
  findOne(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.issuers.detail(tenant, id);
  }

  @ApiOperation({
    summary: 'Create an issuer (PLATFORM ONLY)',
    description:
      'Creating an issuer creates a TENANT, so only the platform may do it — one tenant ' +
      'minting another is the boundary this model exists to draw. Always lands ' +
      '`pending_review`; KYB status is not settable here.',
  })
  @ApiValidationError()
  @Roles('platform_admin')
  @HttpCode(201)
  @Post()
  create(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Body() dto: CreateIssuerDto) {
    return this.issuers.create(p, t, dto);
  }

  @ApiOperation({
    summary: 'Update issuer details',
    description:
      'An issuer_admin may edit its OWN record; the platform may edit any. `kybStatus` ' +
      'is not patchable — it moves only through the KYB endpoints.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Patch(':id')
  update(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateIssuerDto,
  ) {
    return this.issuers.update(p, t, id, dto);
  }

  @ApiOperation({ summary: 'KYB review queue (PLATFORM ONLY)' })
  @Roles('platform_admin')
  @Get('kyb/pending')
  pendingKyb(@Tenant() t: TenantContext) {
    return this.issuers.pendingKyb(t);
  }

  @ApiOperation({
    summary: 'Approve KYB (PLATFORM ONLY)',
    description:
      'KYB is the platform\'s determination that this legal entity may issue securities ' +
      'here. An issuer deciding its own would be self-certification. Idempotent.',
  })
  @ApiParam({ name: 'id' })
  @Roles('platform_admin')
  @HttpCode(200)
  @Post(':id/approve-kyb')
  approveKyb(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: KybDecisionDto,
  ) {
    return this.issuers.decideKyb(p, t, id, true, dto.note);
  }

  @ApiOperation({ summary: 'Reject KYB (PLATFORM ONLY) — a reason is required' })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Roles('platform_admin')
  @HttpCode(200)
  @Post(':id/reject-kyb')
  rejectKyb(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: KybRejectDto,
  ) {
    return this.issuers.decideKyb(p, t, id, false, dto.note);
  }
}

/**
 * Public issuer application — no session, because an applicant has no tenant by
 * definition: they are asking to become one.
 */
@ApiTags('Issuers')
@Controller('issuers')
export class PublicIssuersController {
  constructor(private readonly issuers: IssuersService) {}

  @Public()
  @ApiOperation({
    summary: 'Apply to become an issuer',
    description:
      'Lands as `pending_review` and can do nothing until a platform admin approves it. ' +
      'Returns only an acknowledgement — never the created row, so an unauthenticated ' +
      'caller cannot learn internal ids or probe whether a company is already registered.',
  })
  @ApiValidationError()
  @ApiConflict('An application for that entity already exists.', 'ALREADY_APPLIED')
  @HttpCode(202)
  @Post('apply')
  apply(@Body() dto: ApplyDto) {
    return this.issuers.apply(dto);
  }
}
