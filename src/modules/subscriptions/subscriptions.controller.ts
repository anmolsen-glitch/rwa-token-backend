/**
 *   POST /api/investor/orders            reserve an allocation + open a payment
 *   GET  /api/investor/orders            your orders
 *   POST /api/investor/orders/:ref/pay   capture, then settle (mint)
 *
 *   GET  /api/admin/subscriptions        back-office order reconciliation
 *
 * Investor session. The wallet comes from the verified token, never the body —
 * otherwise anyone could place an order against someone else's wallet.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, Session, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';
import {
  ApiAuthErrors,
  ApiConflict,
  ApiNotFound,
  ApiValidationError,
} from '@shared/openapi/api-error.decorator';
import { SubscriptionsService } from './subscriptions.service';
import { CreateOrderDto, PayCryptoDto } from './dto/order.dto';

@ApiTags('Investor')
@ApiAuthErrors()
@Session('investor')
@Controller('investor/orders')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  private static walletOf(principal: Principal): string {
    if (!principal.wallet) {
      throw AppError.forbidden('Connect a wallet before investing.');
    }
    return principal.wallet;
  }

  @ApiOperation({
    summary: 'Reserve an allocation and open a payment',
    description:
      'The allocation is reserved ATOMICALLY under an offering row lock, so two ' +
      'investors cannot both take the last tokens. Requires on-chain verification for ' +
      'that asset — checked before any money is taken. The payment provider is called ' +
      'after the lock is released; if it fails the reservation is cancelled rather than ' +
      'holding supply.',
  })
  @ApiValidationError()
  @ApiNotFound('Offering')
  @ApiConflict('Not enough supply remaining.', 'INSUFFICIENT_SUPPLY')
  @ApiConflict('Exceeds your per-investor limit.', 'PER_INVESTOR_LIMIT')
  @HttpCode(201)
  @Post()
  create(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Body() dto: CreateOrderDto,
  ) {
    return this.subs.createOrder(p, t, SubscriptionsController.walletOf(p), dto.offeringId, dto.amount);
  }

  @ApiOperation({ summary: 'Your orders' })
  @Get()
  list(@CurrentUser() p: Principal, @Tenant() t: TenantContext) {
    return this.subs.list(t, SubscriptionsController.walletOf(p));
  }

  @ApiOperation({
    summary: 'Pay for an order, then settle',
    description:
      'Captures the payment and mints. Settlement is claimed ATOMICALLY (paid -> ' +
      'settling) because the provider webhook can arrive at the same moment — both ' +
      'minting would double-issue. A settlement failure returns the order to `paid`, ' +
      'never `failed`: the money was taken, so it must stay retryable and visible.',
  })
  @ApiParam({ name: 'reference', description: 'Order reference' })
  @ApiNotFound('Order')
  @ApiConflict('Order is not awaiting payment.', 'ORDER_NOT_PAYABLE')
  @HttpCode(200)
  @Post(':reference/pay')
  pay(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('reference') reference: string,
  ) {
    return this.subs.pay(p, t, SubscriptionsController.walletOf(p), reference);
  }

  @ApiOperation({
    summary: 'Pay an order in crypto',
    description:
      'Send the payment from your own wallet FIRST, then submit the hash. Every field is ' +
      'verified against the chain — sender, recipient, amount and success — because a ' +
      'hash is an unverified claim from the payer until the receipt is read. One ' +
      'transaction may settle at most one order.',
  })
  @ApiParam({ name: 'reference' })
  @ApiValidationError()
  @ApiNotFound('Order')
  @ApiConflict("That payment isn't confirmed on-chain yet.", 'TX_NOT_CONFIRMED')
  @ApiConflict('That transaction was already used for another order.', 'TX_ALREADY_USED')
  @HttpCode(200)
  @Post(':reference/pay-crypto')
  payCrypto(
    @CurrentUser() p: Principal,
    @Tenant() t: TenantContext,
    @Param('reference') reference: string,
    @Body() dto: PayCryptoDto,
  ) {
    return this.subs.payWithCrypto(
      p,
      t,
      SubscriptionsController.walletOf(p),
      reference,
      dto.txHash,
    );
  }
}

@ApiTags('Cap Table')
@ApiAuthErrors()
@Controller('admin/subscriptions')
export class AdminSubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @ApiOperation({
    summary: 'Order reconciliation list',
    description:
      'Every order your tenancy can see, newest first — fiat ↔ tokens ↔ tx. An issuer ' +
      'sees orders on its own offerings (RLS, not a WHERE clause); the platform operator ' +
      'sees all of them.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows (default 200, cap 500)' })
  @Roles('issuer_admin', 'compliance', 'agent')
  @Get()
  list(@Tenant() t: TenantContext, @Query('limit') limit?: string) {
    return this.subs.listAll(t, Number(limit) || 200);
  }
}
