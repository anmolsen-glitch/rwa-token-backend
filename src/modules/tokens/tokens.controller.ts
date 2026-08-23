/**
 *   GET  /api/admin/tokens                        list (tenant-scoped)
 *   GET  /api/admin/tokens/:symbol                on-chain detail
 *   GET  /api/admin/tokens/:symbol/cap-table      holders, from the index
 *   GET  /api/admin/tokens/:symbol/holder/:addr   one holder
 *   GET  /api/admin/tokens/:symbol/transfers      recent transfers
 *
 *   POST /api/admin/tokens/:symbol/{mint,burn,force-transfer,pause}
 *        -> go through the APPROVAL queue (maker-checker)
 *   POST /api/admin/tokens/:symbol/{freeze,freeze-partial}
 *        -> execute immediately: freezing is a containment action, and a
 *           second signature while funds are moving defeats the purpose.
 *
 * Every symbol is resolved tenant-scoped, so an issuer can only ever reach its
 * own tokens; another issuer's symbol 404s.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { ApprovalsService } from '@modules/operations/approvals.service';
import { TokensService } from './tokens.service';
import { TokenOperationsService } from './token-operations.service';
import {
  BurnDto,
  ForceTransferDto,
  FreezeDto,
  FreezePartialDto,
  MintDto,
  PauseDto,
} from './dto/token-ops.dto';

@ApiTags('Tokens')
@ApiAuthErrors()
@Controller('admin/tokens')
export class TokensController {
  constructor(
    private readonly tokens: TokensService,
    private readonly ops: TokenOperationsService,
    private readonly approvals: ApprovalsService,
  ) {}

  @ApiOperation({
    summary: 'List your tokens',
    description:
      'Tenant-scoped. On-chain detail degrades to `onChain: false` if the RPC is ' +
      'unreachable rather than failing the whole list — you still need to see your ' +
      'assets when the chain is down.',
  })
  @Get()
  list(@Tenant() tenant: TenantContext) {
    return this.tokens.list(tenant);
  }

  @ApiOperation({ summary: 'Token detail (on-chain)' })
  @ApiParam({ name: 'symbol', description: 'Token symbol, e.g. `MBWT`' })
  @ApiNotFound('Token')
  @Get(':symbol')
  get(@Tenant() tenant: TenantContext, @Param('symbol') symbol: string) {
    return this.tokens.get(tenant, symbol);
  }

  @ApiOperation({
    summary: 'Cap table',
    description:
      'Served from the INDEXED balances, not the chain — per-holder on-chain reads ' +
      'would be one RPC call each. Freshness therefore follows the indexer cursor.',
  })
  @ApiParam({ name: 'symbol' })
  @ApiNotFound('Token')
  @Get(':symbol/cap-table')
  capTable(@Tenant() tenant: TenantContext, @Param('symbol') symbol: string) {
    return this.tokens.capTable(tenant, symbol);
  }

  @ApiOperation({ summary: 'One holder: balance, frozen status, frozen amount' })
  @ApiParam({ name: 'symbol' })
  @ApiParam({ name: 'address' })
  @ApiNotFound('Token')
  @Get(':symbol/holder/:address')
  holder(
    @Tenant() tenant: TenantContext,
    @Param('symbol') symbol: string,
    @Param('address') address: string,
  ) {
    return this.tokens.holder(tenant, symbol, address);
  }

  @ApiOperation({ summary: 'Recent transfers (from the index)' })
  @ApiParam({ name: 'symbol' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiNotFound('Token')
  @Get(':symbol/transfers')
  transfers(
    @Tenant() tenant: TenantContext,
    @Param('symbol') symbol: string,
    @Query('limit') limit?: string,
  ) {
    return this.tokens.transfers(tenant, symbol, Math.min(Number(limit) || 100, 500));
  }

  /* ---- approval-gated writes ------------------------------------------- */

  @ApiOperation({
    summary: 'Mint (approval-gated)',
    description:
      'Submits to the maker-checker queue. Executes immediately only when the threshold ' +
      'is 0. Pre-flight: refuses if the recipient is not a verified investor, because ' +
      'T-REX would revert and burn gas.',
  })
  @ApiParam({ name: 'symbol' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @ApiConflict('Investor is not verified for this asset.', 'INVESTOR_NOT_VERIFIED')
  @Roles('agent', 'issuer_admin')
  @HttpCode(200)
  @Post(':symbol/mint')
  mint(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('symbol') symbol: string,
    @Body() dto: MintDto,
  ) {
    return this.approvals.submit(p, t, 'mint', symbol, { ...dto });
  }

  @ApiOperation({ summary: 'Burn (approval-gated)' })
  @ApiParam({ name: 'symbol' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @Roles('agent', 'issuer_admin')
  @HttpCode(200)
  @Post(':symbol/burn')
  burn(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('symbol') symbol: string,
    @Body() dto: BurnDto,
  ) {
    return this.approvals.submit(p, t, 'burn', symbol, { ...dto });
  }

  @ApiOperation({
    summary: 'Forced transfer (approval-gated, threshold 2 by default)',
    description:
      'The court-order power: moves someone else\'s holdings without their consent. ' +
      'Defaults to TWO checkers. Bypasses compliance rules, but T-REX still requires a ' +
      'verified recipient — checked before the request enters the queue.',
  })
  @ApiParam({ name: 'symbol' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @Roles('agent', 'issuer_admin')
  @HttpCode(200)
  @Post(':symbol/force-transfer')
  forceTransfer(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('symbol') symbol: string,
    @Body() dto: ForceTransferDto,
  ) {
    const { caseId, ...params } = dto;
    return this.approvals.submit(p, t, 'force-transfer', symbol, params, caseId);
  }

  @ApiOperation({ summary: 'Pause / unpause the token (approval-gated)' })
  @ApiParam({ name: 'symbol' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @Roles('issuer_admin')
  @HttpCode(200)
  @Post(':symbol/pause')
  pause(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('symbol') symbol: string,
    @Body() dto: PauseDto,
  ) {
    return this.approvals.submit(p, t, 'pause', symbol, { ...dto });
  }

  /* ---- immediate writes ------------------------------------------------ */

  @ApiOperation({
    summary: 'Freeze / unfreeze a wallet (IMMEDIATE)',
    description:
      'Deliberately NOT approval-gated. Freezing is a containment action — usually a ' +
      'sanctions hit or suspected compromise — and waiting for a second signature while ' +
      'funds are moving defeats the purpose. It is fully reversible, and audited.',
  })
  @ApiParam({ name: 'symbol' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @Roles('compliance', 'agent', 'issuer_admin')
  @HttpCode(200)
  @Post(':symbol/freeze')
  freeze(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('symbol') symbol: string,
    @Body() dto: FreezeDto,
  ) {
    return this.ops.setAddressFrozen(p, t, symbol, dto.wallet, dto.frozen);
  }

  @ApiOperation({ summary: 'Freeze / unfreeze part of a balance (IMMEDIATE)' })
  @ApiParam({ name: 'symbol' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @Roles('compliance', 'agent', 'issuer_admin')
  @HttpCode(200)
  @Post(':symbol/freeze-partial')
  freezePartial(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('symbol') symbol: string,
    @Body() dto: FreezePartialDto,
  ) {
    return this.ops.freezePartial(p, t, symbol, dto.wallet, dto.amount, dto.freeze);
  }
}
