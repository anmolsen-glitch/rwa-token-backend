/**
 *   GET  /api/investor/portfolio      holdings across every asset and wallet
 *   GET  /api/investor/offerings      assets this investor may see
 *   GET  /api/investor/wallets        their linked wallets
 *   POST /api/investor/wallets/link   link another, proving control
 *
 * Investor session. Everything is keyed on the PERSON behind the connected
 * wallet, never the wallet alone.
 */
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Session, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { PortfolioService } from './portfolio.service';
import { LinkWalletDto } from './dto/link-wallet.dto';

@ApiTags('Investor')
@ApiAuthErrors()
@Session('investor')
@Controller('investor')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  private static walletOf(p: Principal): string {
    if (!p.wallet) throw AppError.forbidden('Connect a wallet first.');
    return p.wallet;
  }

  @ApiOperation({
    summary: 'Your holdings',
    description:
      'Summed across every wallet you have linked, and read from the CHAIN rather than ' +
      'the indexer — a lagging indexer must not be able to tell you your tokens are gone. ' +
      'If an asset cannot be read it comes back with `unavailable: true` rather than a ' +
      'zero balance, because "you hold nothing" and "we could not check" must not look ' +
      'the same.',
  })
  @Get('portfolio')
  mine(@CurrentUser() p: Principal) {
    return this.portfolio.portfolio(PortfolioController.walletOf(p));
  }

  @ApiOperation({
    summary: 'Assets you can see',
    description:
      'Every public offering, plus private placements if you are accredited. Eligibility ' +
      'comes from your own record, never from the request.',
  })
  @Get('offerings')
  offerings(@CurrentUser() p: Principal) {
    return this.portfolio.offeringsFor(PortfolioController.walletOf(p));
  }

  @ApiOperation({ summary: 'Your linked wallets' })
  @Get('wallets')
  wallets(@CurrentUser() p: Principal) {
    return this.portfolio.wallets(PortfolioController.walletOf(p));
  }

  @ApiOperation({
    summary: 'Link another wallet',
    description:
      'The new wallet must SIGN, proving control — otherwise anyone could attach an ' +
      'address they merely know of. Get the message from POST /api/investor/wallet/nonce ' +
      'first; the nonce is burned on use, so a captured signature cannot be replayed. The ' +
      'wallet is AML-screened before linking, because it inherits your KYC and ONCHAINID ' +
      'and does not repeat either.',
  })
  @ApiValidationError()
  @ApiConflict('Already linked to your account.', 'ALREADY_LINKED')
  @ApiConflict('That wallet already belongs to someone else.', 'WALLET_LINKED')
  @HttpCode(201)
  @Post('wallets/link')
  link(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Body() dto: LinkWalletDto,
  ) {
    return this.portfolio.linkWallet(
      p,
      t,
      PortfolioController.walletOf(p),
      dto.address,
      dto.signature,
    );
  }
}
