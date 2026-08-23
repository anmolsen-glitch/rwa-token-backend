/**
 * The asset page, for callers with no session, and the two actions an investor
 * takes against it.
 *
 *   public:    GET  /api/offerings/:id/valuations | updates | buyback | proposals
 *   investor:  POST /api/investor/proposals/:id/vote
 *              POST /api/investor/buyback/sell
 *
 * These reads exist ALONGSIDE the /api/admin ones rather than replacing them,
 * and the difference is not cosmetic: the admin route resolves the offering
 * through the caller's tenant and so shows an issuer its own DRAFT asset, while
 * this one is gated on public visibility and never will. Same data, two
 * different questions about who may see it.
 */
import { Body, Controller, HttpCode, Param, Post, Get } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, Session } from '@shared/auth/decorators';
import type { Principal } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { OfferingFeaturesService } from './offering-features.service';
import { SellBackDto, VoteDto } from './dto/features.dto';

@ApiTags('Offerings')
@ApiNotFound('Offering')
@Public()
@Controller('offerings/:id')
export class PublicOfferingFeaturesController {
  constructor(private readonly features: OfferingFeaturesService) {}

  @ApiOperation({
    summary: 'Valuation history (public)',
    description: 'Appraisal history for a listed asset. Draft offerings 404 — not yet an offer.',
  })
  @ApiParam({ name: 'id' })
  @Get('valuations')
  valuations(@Param('id') id: string) {
    return this.features.publicValuations(id);
  }

  @ApiOperation({ summary: 'Manager updates (public)' })
  @ApiParam({ name: 'id' })
  @Get('updates')
  updates(@Param('id') id: string) {
    return this.features.publicUpdates(id);
  }

  @ApiOperation({
    summary: 'The standing buy-back bid (public)',
    description: 'What a holder could sell back for today, and how much budget is left.',
  })
  @ApiParam({ name: 'id' })
  @Get('buyback')
  buyback(@Param('id') id: string) {
    return this.features.publicBuyback(id);
  }

  @ApiOperation({
    summary: 'Manager-change proposals with live tallies (public)',
    description: 'A governance vote nobody can read is not governance.',
  })
  @ApiParam({ name: 'id' })
  @Get('proposals')
  proposals(@Param('id') id: string) {
    return this.features.publicProposals(id);
  }
}

@ApiTags('Investor')
@ApiAuthErrors()
@Session('investor')
@Controller('investor')
export class InvestorFeaturesController {
  constructor(private readonly features: OfferingFeaturesService) {}

  private static walletOf(p: Principal): string {
    if (!p.wallet) throw AppError.forbidden('Connect a wallet first.');
    return p.wallet;
  }

  @ApiOperation({
    summary: 'Vote on a manager-change proposal',
    description:
      'Weight is your ON-CHAIN balance summed across every wallet you have linked, ' +
      'captured at vote time — so selling later does not rewrite a tally already cast, ' +
      'and a non-holder is refused outright. Re-voting before the window closes replaces ' +
      'your previous vote rather than adding to it.',
  })
  @ApiParam({ name: 'id' })
  @ApiValidationError()
  @ApiNotFound('Proposal')
  @ApiConflict('Voting has ended.', 'VOTING_ENDED')
  @HttpCode(200)
  @Post('proposals/:id/vote')
  vote(@CurrentUser() p: Principal, @Param('id') id: string, @Body() dto: VoteDto) {
    return this.features.vote(InvestorFeaturesController.walletOf(p), id, dto.choice);
  }

  @ApiOperation({
    summary: 'Record a sell-back against the standing bid',
    description:
      'NON-CUSTODIAL: transfer the tokens from your own wallet to the buyer FIRST, then ' +
      'submit the hash here. The receipt is verified on-chain — sender, recipient and ' +
      'exact amount must match a Transfer log emitted by the token itself — before any ' +
      'payout is booked, and each hash may back at most one sale.',
  })
  @ApiValidationError()
  @ApiNotFound('Offering for token')
  @ApiConflict('No open buy-back for this asset.', 'NO_OPEN_BUYBACK')
  @ApiConflict('Transaction is not confirmed yet.', 'TX_NOT_CONFIRMED')
  @ApiConflict('Rejected: duplicate hash, or over the remaining budget.', 'SELLBACK_REJECTED')
  @HttpCode(201)
  @Post('buyback/sell')
  sell(@CurrentUser() p: Principal, @Body() dto: SellBackDto) {
    return this.features.sellBack(InvestorFeaturesController.walletOf(p), dto);
  }
}
