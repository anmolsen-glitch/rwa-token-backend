/**
 *   GET   /api/admin/team        the issuer's back-office staff
 *   POST  /api/admin/team        add a colleague
 *   PATCH /api/admin/team/:id    change their role, or disable/re-enable them
 *
 * Named `team` rather than `admins` because `/api/admin/admins` reads as a typo,
 * and because this is scoped to ONE issuer's staff — not the platform's admin
 * table. Was /api/auth/admins on Express.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
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
import { TeamService } from './team.service';
import { CreateTeamMemberDto, UpdateTeamMemberDto } from './dto/team.dto';

@ApiTags('Team')
@ApiAuthErrors()
@Roles('issuer_admin')
@Controller('admin/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @ApiOperation({
    summary: "Your issuer's staff",
    description:
      'Scoped to your own issuer by RLS. Rows carrying a `managerId` are property ' +
      'managers\' portal logins — they are listed so the roster is complete, but they are ' +
      'edited on the manager, not here.',
  })
  @Get()
  list(@Tenant() t: TenantContext) {
    return this.team.list(t);
  }

  @ApiOperation({
    summary: 'Add a colleague',
    description:
      'Assignable roles are issuer_admin, compliance, agent and spv_manager. NOT ' +
      'platform_admin — a tenant must not mint a superuser, refused here AND by the ' +
      'database. NOT manager either: a manager login only makes sense alongside a manager ' +
      'profile, so create it with the manager.',
  })
  @ApiValidationError()
  @ApiConflict('An account with that email already exists.', 'EMAIL_TAKEN')
  @HttpCode(201)
  @Post()
  create(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Body() dto: CreateTeamMemberDto,
  ) {
    return this.team.create(p, t, dto);
  }

  @ApiOperation({
    summary: 'Change a role, or disable/re-enable an account',
    description:
      'Disabling takes effect on the NEXT REQUEST — the admin row is re-read on every ' +
      'call, not trusted from the token. Two guardrails against locking your issuer out ' +
      'of its own tenant: you cannot disable or demote yourself, and you cannot disable ' +
      'or demote the last active issuer_admin (counted per issuer).',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Team member')
  @ApiConflict('This login belongs to a property manager.', 'MANAGED_ELSEWHERE')
  @Patch(':id')
  update(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id', NumericIdPipe) id: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    return this.team.update(p, t, id, dto);
  }
}
