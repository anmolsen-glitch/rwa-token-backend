/**
 *   issuer_admin|manager: POST /api/admin/tokens/:symbol/distributions
 *   issuer staff:         GET  /api/admin/distributions
 *   investor:             GET  /api/investor/claims
 *                         POST /api/investor/claims/claim
 *
 * Declaring is a sub-resource of the TOKEN (`/tokens/:symbol/distributions`)
 * rather than the verb `/tokens/:symbol/distribute` it was on Express — the
 * thing being created is a distribution.
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, Session, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { DistributionsService } from './distributions.service';
import { DeclareDistributionDto } from './dto/distribution.dto';

@ApiTags('Distributions')
@ApiAuthErrors()
@Controller('admin')
export class DistributionsController {
  constructor(private readonly distributions: DistributionsService) {}

  @ApiOperation({
    summary: 'Past distributions for your assets',
    description: 'Scoped through the token to your issuer.',
  })
  @Get('distributions')
  list(@Tenant() t: TenantContext) {
    return this.distributions.list(t);
  }

  @ApiOperation({
    summary: 'Declare an income payout',
    description:
      'Snapshots the cap table and allocates the total pro-rata to every holder, using ' +
      'the largest-remainder method in integer paise so the shares sum to the declared ' +
      'total EXACTLY. The snapshot is the rule: selling afterwards does not change what ' +
      'you were owed for the period covered. A `manager` may declare only for the ' +
      'properties they operate; an issuer_admin for any of its own.',
  })
  @ApiParam({ name: 'symbol' })
  @ApiValidationError()
  @ApiNotFound('Token')
  @ApiConflict('That asset has no holders to distribute to.', 'NO_HOLDERS')
  @Roles('issuer_admin', 'manager')
  @HttpCode(201)
  @Post('tokens/:symbol/distributions')
  declare(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('symbol') symbol: string,
    @Body() dto: DeclareDistributionDto,
  ) {
    return this.distributions.declare(p, t, symbol, dto);
  }
}

@ApiTags('Investor')
@ApiAuthErrors()
@Session('investor')
@Controller('investor/claims')
export class InvestorClaimsController {
  constructor(private readonly distributions: DistributionsService) {}

  private static walletOf(p: Principal): string {
    if (!p.wallet) throw AppError.forbidden('Connect a wallet first.');
    return p.wallet;
  }

  @ApiOperation({
    summary: 'Your distribution claims',
    description:
      'Summed across EVERY wallet you have linked — one person is owed the total, however ' +
      'many addresses they held the asset across.',
  })
  @Get()
  mine(@CurrentUser() p: Principal) {
    return this.distributions.forInvestor(InvestorClaimsController.walletOf(p));
  }

  @ApiOperation({
    summary: 'Claim everything claimable',
    description:
      'The claimable→claimed transition is a single UPDATE with the status in its WHERE ' +
      'clause, so two concurrent claims cannot both collect the same rows. NOT CUSTODIAL: ' +
      'this marks the ledger paid — a production deployment settles to a bank or ' +
      'stablecoin and reconciles against that.',
  })
  @ApiConflict('Nothing to claim.', 'NOTHING_TO_CLAIM')
  @HttpCode(200)
  @Post('claim')
  claim(@CurrentUser() p: Principal) {
    return this.distributions.claim(p, InvestorClaimsController.walletOf(p));
  }
}
