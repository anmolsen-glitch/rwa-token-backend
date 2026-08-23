/**
 *   issuer_admin: GET  /api/admin/managers            the issuer's roster
 *                 POST /api/admin/managers            create (optionally with a login)
 *                 GET  /api/admin/managers/:id
 *                 PATCH /api/admin/managers/:id       edit, or suspend/reactivate
 *   manager:      GET  /api/admin/managers/me/offerings   the manager portal
 *   public:       GET  /api/managers/:id              profile + its properties
 *
 * Assignment lives at POST /api/admin/offerings/:id/manager — it belongs to the
 * OFFERING, not to the manager, and putting it in one place keeps a single
 * implementation of the same write.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { NumericIdPipe } from '@shared/pipes/numeric-id.pipe';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { ManagersService } from './managers.service';
import { CreateManagerDto, UpdateManagerDto } from './dto/manager.dto';

@ApiTags('Managers')
@ApiAuthErrors()
@ApiNotFound('Manager')
@Controller('admin/managers')
export class ManagersController {
  constructor(private readonly managers: ManagersService) {}

  /**
   * NOTE this is declared BEFORE :id — Fastify matches static segments first,
   * but keeping the order explicit means a future reorder cannot silently make
   * "me" resolve as a manager id.
   */
  @ApiOperation({
    summary: 'The properties you operate (manager portal)',
    description:
      'A manager sees ONLY the offerings assigned to them. This is the whole point of ' +
      'the role: delegated day-to-day operations without issuer_admin powers.',
  })
  @Roles('manager')
  @Get('me/offerings')
  myProperties(@CurrentUser() p: Principal, @Tenant() t: TenantContext) {
    return this.managers.myProperties(p, t);
  }

  @ApiOperation({ summary: "This issuer's manager roster" })
  @Roles('issuer_admin')
  @Get()
  list(@Tenant() t: TenantContext) {
    return this.managers.list(t);
  }

  @ApiOperation({ summary: 'One manager' })
  @ApiParam({ name: 'id' })
  @Roles('issuer_admin')
  @Get(':id')
  get(@Tenant() t: TenantContext, @Param('id', NumericIdPipe) id: string) {
    return this.managers.findById(t, id);
  }

  @ApiOperation({
    summary: 'Create a manager',
    description:
      'Supply loginEmail + loginPassword to also create a scoped portal login (an admin ' +
      "with role 'manager' carrying THIS issuer's id, so it is never platform-wide). " +
      'Omit them for a profile-only manager, which is how most start.',
  })
  @ApiValidationError()
  @ApiConflict('That email already has a login.', 'EMAIL_TAKEN')
  @Roles('issuer_admin')
  @HttpCode(201)
  @Post()
  create(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Body() dto: CreateManagerDto) {
    return this.managers.create(p, t, dto);
  }

  @ApiOperation({
    summary: 'Edit, suspend, or reactivate a manager',
    description:
      'SUSPENDING ALSO DISABLES THE PORTAL LOGIN (and reactivating restores it). Without ' +
      'that, a suspended manager keeps posting updates and declaring distributions, and ' +
      '"suspended" would be a label rather than a control.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Roles('issuer_admin')
  @Patch(':id')
  update(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id', NumericIdPipe) id: string,
    @Body() dto: UpdateManagerDto,
  ) {
    return this.managers.update(p, t, id, dto);
  }
}

/**
 * The public manager profile — a separate controller, like the public
 * marketplace, so `grep "@Controller('admin"` stays an accurate list of the
 * back-office surface.
 */
@ApiTags('Managers')
@ApiNotFound('Manager')
@Public()
@Controller('managers')
export class PublicManagersController {
  constructor(private readonly managers: ManagersService) {}

  @ApiOperation({
    summary: 'Public manager profile and its properties',
    description:
      'Who operates the building an investor is considering. Suspended managers 404: the ' +
      'profile is marketing surface, and showing a suspended operator alongside live ' +
      'assets misrepresents who is running them. Only publicly-visible properties listed.',
  })
  @ApiParam({ name: 'id' })
  @Get(':id')
  profile(@Param('id', NumericIdPipe) id: string) {
    return this.managers.publicProfile(id);
  }
}
