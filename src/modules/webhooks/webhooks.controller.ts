/**
 * Inbound provider webhooks.
 *
 * PUBLIC endpoints — the provider calls them, not a logged-in user — so they
 * are authenticated by the provider's HMAC over the RAW body, never by a
 * session. Always verify the raw bytes: re-serialising the JSON can reorder
 * keys or change spacing and break the signature.
 *
 * BOTH webhooks are now served here. The payment one was deliberately held back
 * until subscriptions were ported: accepting a signed event CONSUMES its id in
 * the shared `webhook_events` table, so acking one this app could not apply
 * would have made Express treat the provider's retry as a duplicate — a paid
 * order would never settle, and nothing would look broken.
 */
import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '@shared/auth/decorators';
import { AppError } from '@shared/errors/app-error';
import { ApiValidationError } from '@shared/openapi/api-error.decorator';
import { WebhooksService } from './webhooks.service';

@ApiTags('Webhooks')
@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @ApiOperation({
    summary: 'KYC provider decision webhook',
    description:
      'Authenticated by an HMAC over the RAW body (`x-webhook-signature`), not by a ' +
      'session. Idempotent: providers retry, so the same event may arrive more than ' +
      'once — a duplicate is acked but never re-applied.\\n\\n' +
      'Answers 2xx once a SIGNED event is accepted, even for an unknown reference, so ' +
      'the provider stops retrying. Only a bad signature or unparseable body is a 400.',
  })
  @ApiValidationError()
  @ApiOperation({
    summary: 'Payment provider webhook',
    description:
      'Captures, failures and refunds. Replay-protected twice: a unique provider event ' +
      'id (deduped in `webhook_events`) AND a freshness window on the signed timestamp, ' +
      'so a captured payload cannot be replayed later.\n\n' +
      'A capture settles the order — minting is claimed atomically, so this arriving at ' +
      'the same moment as the investor\'s own pay call cannot double-issue.',
  })
  @ApiValidationError()
  @HttpCode(200)
  @Post('payments')
  async payments(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Headers('x-webhook-signature') sig1?: string,
    @Headers('x-signature') sig2?: string,
    @Headers('stripe-signature') sig3?: string,
  ) {
    const raw = WebhooksController.rawBody(req, body);
    return this.webhooks.handlePayment(raw, sig1 ?? sig2 ?? sig3);
  }

  @HttpCode(200)
  @Post('kyc')
  async kyc(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Headers('x-webhook-signature') sig1?: string,
    @Headers('x-signature') sig2?: string,
    @Headers('stripe-signature') sig3?: string,
  ) {
    const raw = WebhooksController.rawBody(req, body);
    return this.webhooks.handleKyc(raw, sig1 ?? sig2 ?? sig3);
  }

  /**
   * The raw bytes exactly as received.
   *
   * Fastify parses JSON before the handler, so `body` is already an object.
   * `rawBody` is captured by the addContentTypeParser hook in main.ts — falling
   * back to re-stringifying would silently break every signature the moment a
   * provider emits keys in a different order.
   */
  private static rawBody(req: FastifyRequest, _body: unknown): Buffer {
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(raw)) {
      throw new AppError('MISSING_RAW_BODY', 400, 'Missing raw request body.');
    }
    return raw;
  }
}
