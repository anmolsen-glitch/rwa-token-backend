/**
 *   GET/POST /api/admin/issuers/:issuerId/spv-managers   an SPV's management layer
 *   GET      /api/admin/spv-managers/:id                 one, with its reports
 *   PATCH    /api/admin/spv-managers/:id                 edit / suspend
 *   GET      /api/admin/spv-managers/:id/managers        who could report to it
 *   POST     /api/admin/spv-managers/:id/managers        create one under it
 *   POST     /api/admin/spv-managers/:id/managers/:mId   place an existing one under it
 *   DELETE   /api/admin/spv-managers/:id/managers/:mId   release it
 *
 * Attach and detach are POST and DELETE on the same sub-resource rather than
 * one endpoint taking an `attach` flag — a boolean in the body that flips the
 * meaning of a call is the kind of thing that gets inverted in a refactor.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { NumericIdPipe } from '@shared/pipes/numeric-id.pipe';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { SpvManagersService } from './spv-managers.service';
import {
  CreateReportDto,
  CreateSpvManagerDto,
  UpdateSpvManagerDto,
} from './dto/spv-manager.dto';

@ApiTags('SPV managers')
@ApiAuthErrors()
@ApiNotFound('Issuer')
@Roles('issuer_admin')
@Controller('admin/issuers/:issuerId/spv-managers')
export class IssuerSpvManagersController {
  constructor(private readonly spv: SpvManagersService) {}

  @ApiOperation({
    summary: "An SPV's management layer",
    description:
      'The issuer in the path is a FILTER, not authority: an issuer caller may only name ' +
      'its own id (any other 404s), and only the platform operator may name an arbitrary ' +
      'one — which writes an audit row like every platform action.',
  })
  @ApiParam({ name: 'issuerId' })
  @Get()
  list(@Tenant() t: TenantContext, @Param('issuerId', NumericIdPipe) issuerId: string) {
    return this.spv.list(t, issuerId);
  }

  @ApiOperation({ summary: 'Add an SPV manager' })
  @ApiParam({ name: 'issuerId' })
  @ApiValidationError()
  @HttpCode(201)
  @Post()
  create(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('issuerId', NumericIdPipe) issuerId: string,
    @Body() dto: CreateSpvManagerDto,
  ) {
    return this.spv.create(p, t, issuerId, dto);
  }
}

@ApiTags('SPV managers')
@ApiAuthErrors()
@ApiNotFound('SPV manager')
@Roles('issuer_admin')
@Controller('admin/spv-managers/:id')
export class SpvManagersController {
  constructor(private readonly spv: SpvManagersService) {}

  @ApiOperation({ summary: 'One SPV manager and the property managers reporting to it' })
  @ApiParam({ name: 'id' })
  @Get()
  get(@Tenant() t: TenantContext, @Param('id', NumericIdPipe) id: string) {
    return this.spv.get(t, id);
  }

  @ApiOperation({
    summary: 'Edit, suspend, or reactivate an SPV manager',
    description:
      'A suspended SPV manager keeps its existing reports but can take on no new ones — ' +
      'suspension freezes the layer rather than orphaning the managers underneath it.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Patch()
  update(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id', NumericIdPipe) id: string,
    @Body() dto: UpdateSpvManagerDto,
  ) {
    return this.spv.update(p, t, id, dto);
  }

  @ApiOperation({
    summary: 'Property managers that could report to this SPV manager',
    description:
      "The issuer's own managers that are unattached, plus the ones already reporting " +
      'here (flagged). Another issuer\'s managers are not listed and cannot be attached.',
  })
  @ApiParam({ name: 'id' })
  @Get('managers')
  eligible(@Tenant() t: TenantContext, @Param('id', NumericIdPipe) id: string) {
    return this.spv.eligible(t, id);
  }

  @ApiOperation({
    summary: 'Create a property manager under this SPV manager',
    description:
      'Delegates to the same code path as POST /api/admin/managers — including the login ' +
      'rules — then places the new manager under this one. One implementation of what a ' +
      'manager is, so the two cannot drift.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiConflict('That SPV manager is suspended.', 'SPV_MANAGER_SUSPENDED')
  @ApiConflict('That email already has a login.', 'EMAIL_TAKEN')
  @HttpCode(201)
  @Post('managers')
  createReport(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id', NumericIdPipe) id: string,
    @Body() dto: CreateReportDto,
  ) {
    return this.spv.createManager(p, t, id, dto);
  }

  @ApiOperation({
    summary: 'Place an existing property manager under this SPV manager',
    description:
      "Only the issuer's OWN managers — otherwise an SPV manager could adopt, and then " +
      'suspend, a rival SPV\'s operator. Re-parenting is refused: release from the current ' +
      'SPV manager first, so the move is visible to both.',
  })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'managerId' })
  @ApiNotFound('Property manager')
  @ApiConflict('Already reports to another SPV manager.', 'ALREADY_REPORTS')
  @HttpCode(200)
  @Post('managers/:managerId')
  attach(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id', NumericIdPipe) id: string,
    @Param('managerId', NumericIdPipe) managerId: string,
  ) {
    return this.spv.setReportsTo(p, t, id, managerId, true);
  }

  @ApiOperation({
    summary: 'Release a property manager from this SPV manager',
    description:
      'The manager keeps its profile, its properties and its login — only the reporting ' +
      'line is removed. Releasing must never be a way to delete an operator.',
  })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'managerId' })
  @ApiNotFound('Property manager')
  @ApiConflict("Doesn't report to this SPV manager.", 'NOT_REPORTING')
  @Delete('managers/:managerId')
  detach(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id', NumericIdPipe) id: string,
    @Param('managerId', NumericIdPipe) managerId: string,
  ) {
    return this.spv.setReportsTo(p, t, id, managerId, false);
  }
}
