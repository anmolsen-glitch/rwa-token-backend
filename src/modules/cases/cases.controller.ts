/**
 *   GET  /api/admin/cases            list, optionally ?status=open
 *   POST /api/admin/cases            open a case
 *   GET  /api/admin/cases/:id        the case and its full action trail
 *   POST /api/admin/cases/:id/close  close it
 *   POST /api/admin/cases/:id/recover  guided lost-key recovery
 *
 * `compliance` throughout. These describe why someone else's tokens were
 * touched, so they sit with the role that answers for it.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { NumericIdPipe } from '@shared/pipes/numeric-id.pipe';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { CasesService } from './cases.service';
import { OpenCaseDto, RecoverDto } from './dto/case.dto';

@ApiTags('Cases')
@ApiAuthErrors()
@ApiNotFound('Case')
@Roles('compliance')
@Controller('admin/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @ApiOperation({ summary: 'Legal cases for your issuer' })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'closed'] })
  @Get()
  list(@Tenant() t: TenantContext, @Query('status') status?: string) {
    return this.cases.list(t, status ?? null);
  }

  @ApiOperation({
    summary: 'Open a case',
    description:
      'The off-chain order behind a privileged action. References are unique within your ' +
      'issuer, not globally — two companies can receive orders numbered the same way.',
  })
  @ApiValidationError()
  @ApiConflict('A case with that reference already exists.', 'REFERENCE_TAKEN')
  @HttpCode(201)
  @Post()
  open(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Body() dto: OpenCaseDto) {
    return this.cases.open(p, t, dto);
  }

  @ApiOperation({
    summary: 'A case and its full action trail',
    description:
      'Every approval request and audit row tagged with this case — who did what, why, ' +
      'and the resulting transaction.',
  })
  @ApiParam({ name: 'id' })
  @Get(':id')
  detail(@Tenant() t: TenantContext, @Param('id', NumericIdPipe) id: string) {
    return this.cases.detail(t, id);
  }

  @ApiOperation({
    summary: 'Close a case',
    description:
      'Records that the matter is done. Does NOT undo what the case authorised — a freeze ' +
      'stays frozen; unfreezing is its own decision.',
  })
  @ApiParam({ name: 'id' })
  @ApiConflict('Case is already closed.', 'NOT_OPEN')
  @HttpCode(200)
  @Post(':id/close')
  close(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Param('id', NumericIdPipe) id: string) {
    return this.cases.close(p, t, id);
  }

  @ApiOperation({
    summary: 'Guided lost-key recovery',
    description:
      'Links the new wallet to the same person (admin override — the premise is that the ' +
      'investor CANNOT sign), registers it for the asset reusing their ONCHAINID, freezes ' +
      'the old wallet, then SUBMITS a force-transfer of the full balance FOR APPROVAL. ' +
      'The transfer is never executed here: moving an entire holding without four-eyes ' +
      'would make "I lost my key" the easiest way to steal a position.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @ApiConflict('Case is closed.', 'CASE_CLOSED')
  @ApiConflict('That wallet already belongs to someone.', 'WALLET_LINKED')
  @HttpCode(200)
  @Post(':id/recover')
  recover(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id', NumericIdPipe) id: string,
    @Body() dto: RecoverDto,
  ) {
    return this.cases.recover(p, t, id, dto);
  }
}
