/**
 *   GET/POST   /api/admin/offerings/:id/valuations
 *   GET/POST   /api/admin/offerings/:id/updates
 *   GET/POST/DELETE /api/admin/offerings/:id/buyback
 *   GET/POST   /api/admin/offerings/:id/proposals
 *   POST       /api/admin/offerings/:id/manager
 *   POST       /api/admin/proposals/:id/close
 *
 * Reads are open to investors (via RLS) because valuations, updates, the
 * standing bid and governance are the asset's public face. Writes belong to the
 * owning issuer.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { OfferingFeaturesService } from './offering-features.service';
import {
  AssignManagerDto,
  BuybackDto,
  ProposeManagerDto,
  UpdatePostDto,
  ValuationDto,
} from './dto/features.dto';

@ApiTags('Offerings')
@ApiAuthErrors()
@ApiNotFound('Offering')
@Controller('admin/offerings/:id')
export class OfferingFeaturesController {
  constructor(private readonly features: OfferingFeaturesService) {}

  @ApiOperation({ summary: 'Valuation history (NAV)' })
  @ApiParam({ name: 'id' })
  @Get('valuations')
  valuations(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.features.listValuations(t, id);
  }

  @ApiOperation({
    summary: 'Record an appraisal',
    description:
      'APPEND-ONLY. A valuation is a point-in-time statement and the history is what an ' +
      'investor judges performance by, so there is no edit path — only a newer entry.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Roles('issuer_admin')
  @HttpCode(201)
  @Post('valuations')
  addValuation(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: ValuationDto,
  ) {
    return this.features.addValuation(p, t, id, dto);
  }

  @ApiOperation({ summary: 'Manager updates shown on the asset page' })
  @ApiParam({ name: 'id' })
  @Get('updates')
  updates(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.features.listUpdates(t, id);
  }

  @ApiOperation({ summary: 'Post a manager update' })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Roles('issuer_admin', 'manager')
  @HttpCode(201)
  @Post('updates')
  addUpdate(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.features.addUpdate(p, t, id, dto);
  }

  @ApiOperation({ summary: 'The standing buy-back bid, if any' })
  @ApiParam({ name: 'id' })
  @Get('buyback')
  buyback(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.features.getBuyback(t, id);
  }

  @ApiOperation({
    summary: 'Open (or replace) the buy-back bid',
    description:
      'NON-CUSTODIAL: this publishes TERMS only. The investor still transfers their tokens ' +
      'from their own wallet to accept — the platform cannot pull them. One bid per ' +
      'offering, so this replaces any existing one; two live bids would be ambiguous.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiConflict('Deploy the token first.', 'NO_TOKEN')
  @Roles('issuer_admin')
  @HttpCode(200)
  @Post('buyback')
  openBuyback(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: BuybackDto,
  ) {
    return this.features.openBuyback(p, t, id, dto);
  }

  @ApiOperation({
    summary: 'Close the buy-back bid',
    description:
      'Marks it closed; never deletes. Past sales reference the terms they executed under.',
  })
  @ApiParam({ name: 'id' })
  @ApiConflict('No open buy-back.', 'NO_OPEN_BUYBACK')
  @Roles('issuer_admin')
  @Delete('buyback')
  closeBuyback(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.features.closeBuyback(p, t, id);
  }

  @ApiOperation({ summary: 'Manager-change proposals, with live tallies' })
  @ApiParam({ name: 'id' })
  @Get('proposals')
  proposals(@Tenant() t: TenantContext, @Param('id') id: string) {
    return this.features.listProposals(t, id);
  }

  @ApiOperation({
    summary: 'Propose a manager change',
    description:
      'Opens a holder vote weighted by on-chain balance. The window is bounded (3-90 ' +
      'days): a one-day vote is not a vote, and an open-ended one never resolves.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Roles('issuer_admin')
  @HttpCode(201)
  @Post('proposals')
  propose(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: ProposeManagerDto,
  ) {
    return this.features.proposeManager(p, t, id, dto);
  }

  @ApiOperation({ summary: 'Assign or clear the property manager directly' })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @Roles('issuer_admin')
  @HttpCode(200)
  @Post('manager')
  assignManager(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() dto: AssignManagerDto,
  ) {
    return this.features.assignManager(p, t, id, dto.managerId);
  }
}

@ApiTags('Offerings')
@ApiAuthErrors()
@Controller('admin/proposals')
export class ProposalsController {
  constructor(private readonly features: OfferingFeaturesService) {}

  @ApiOperation({
    summary: 'Close a vote and apply the outcome',
    description:
      'Refused before `closesAt` — closing early would let whoever holds the button pick ' +
      'the moment the tally happens to favour them. A pass swaps the manager. The claim ' +
      'is atomic, so two concurrent closes cannot both decide.',
  })
  @ApiParam({ name: 'id' })
  @ApiNotFound('Proposal')
  @ApiConflict('Voting has not closed yet.', 'VOTING_OPEN')
  @ApiConflict('Proposal is not open.', 'NOT_OPEN')
  @Roles('issuer_admin')
  @HttpCode(200)
  @Post(':id/close')
  close(@CurrentUser() p: Principal, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.features.closeProposal(p, t, id);
  }
}
