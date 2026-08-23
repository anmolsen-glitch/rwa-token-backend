/**
 *   GET  /api/admin/operations             the approval queue (tenant-scoped)
 *   GET  /api/admin/operations/:id         one request + who approved it
 *   POST /api/admin/operations/:id/approve
 *   POST /api/admin/operations/:id/reject
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { ApprovalsService } from './approvals.service';
import { ApprovalNoteDto, RejectDto } from './dto/decision.dto';

@ApiTags('Operations')
@ApiAuthErrors()
@Controller('admin/operations')
export class OperationsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @ApiOperation({
    summary: 'The approval queue',
    description:
      'Tenant-scoped: you see only requests for YOUR tokens. A pending force-transfer ' +
      'names a wallet and an amount, which is cap-table intelligence about a competitor.',
  })
  @ApiQuery({ name: 'status', required: false, description: 'pending | executed | failed | rejected' })
  @ApiQuery({ name: 'limit', required: false })
  @Get()
  list(
    @Tenant() tenant: TenantContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.approvals.list(tenant, status ?? null, Math.min(Number(limit) || 50, 200));
  }

  @ApiOperation({ summary: 'One request, with its approvals' })
  @ApiParam({ name: 'id' })
  @ApiNotFound('Operation request')
  @Get(':id')
  get(@Tenant() tenant: TenantContext, @Param('id') id: string) {
    return this.approvals.get(tenant, id);
  }

  @ApiOperation({
    summary: 'Approve — may trigger execution',
    description:
      'You cannot approve your own request (four-eyes), you must hold the role the ' +
      'action requires, and you may approve any request only once. When the threshold ' +
      'is reached the request is claimed ATOMICALLY for execution, so concurrent ' +
      'approvals cannot both run it — that would be a double mint.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Operation request')
  @ApiConflict('Request is no longer pending.', 'NOT_PENDING')
  @ApiConflict('You have already approved this request.', 'ALREADY_APPROVED')
  @HttpCode(200)
  @Post(':id/approve')
  approve(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: ApprovalNoteDto,
  ) {
    return this.approvals.approve(p, t, id, dto.note);
  }

  @ApiOperation({
    summary: 'Reject / cancel',
    description:
      'The requester may always cancel their own request; otherwise you need the role ' +
      'the action requires. A reason is mandatory.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Operation request')
  @ApiConflict('Request is no longer pending.', 'NOT_PENDING')
  @HttpCode(200)
  @Post(':id/reject')
  reject(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: RejectDto,
  ) {
    return this.approvals.reject(p, t, id, dto.note);
  }
}
