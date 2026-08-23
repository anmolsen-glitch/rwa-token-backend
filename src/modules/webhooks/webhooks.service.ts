import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '@shared/config/app-config.service';
import { AppError } from '@shared/errors/app-error';
import { verifyPayload } from '@shared/webhooks/webhook-signature';
import { KycService } from '@modules/kyc/kyc.service';
import {
  PAYMENT_PROVIDER_TOKEN,
  type PaymentProvider,
} from '@shared/payments/payment.provider';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import { Inject } from '@nestjs/common';
import { WebhooksRepository } from './webhooks.repository';

export interface KycWebhookEvent {
  eventId: string;
  checkRef: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly repo: WebhooksRepository,
    private readonly config: AppConfig,
    private readonly kyc: KycService,
    private readonly subscriptions: SubscriptionsService,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly payments: PaymentProvider,
  ) {}

  /**
   * Payment provider webhook.
   *
   * Now safe to serve here because the handler exists. Until subscriptions were
   * ported this route deliberately stayed on Express: accepting an event
   * CONSUMES its id in the shared webhook_events table, so acking one we could
   * not apply would make Express treat the retry as a duplicate and a paid order
   * would silently never settle.
   *
   * Signature verification lives in the provider seam, so a real vendor's SDK
   * verifier can replace it without touching this method.
   */
  async handlePayment(raw: Buffer, signature?: string) {
    const event = this.payments.verifyWebhook(raw, signature);
    if (!event) {
      /* The only 400: bad signature, stale timestamp, or unparseable body. The
         freshness window is what stops a captured payload being replayed later. */
      throw new AppError('INVALID_SIGNATURE', 400, 'Invalid webhook signature or payload.');
    }

    if (!(await this.repo.claim(event.eventId, 'payments'))) {
      return { received: true, duplicate: true };
    }

    const result = await this.subscriptions.handlePaymentEvent(event);
    if (!result.ok) {
      /* Still 2xx — the event was genuine and is recorded, so the provider must
         stop retrying. An unmatched reference is our data problem. */
      this.logger.warn(
        { eventId: event.eventId, paymentRef: event.paymentRef, reason: result.reason },
        'payment webhook: signed event could not be matched to an order',
      );
    }
    return { received: true, ...result };
  }

  async handleKyc(raw: Buffer, signature?: string) {
    if (!verifyPayload(raw, signature, this.config.get('WEBHOOK_SECRET'))) {
      /* The ONLY 400 path. Everything past this point is a genuine, signed
         event and must be acked so the provider stops retrying. */
      throw new AppError('INVALID_SIGNATURE', 400, 'Invalid webhook signature.');
    }

    let event: KycWebhookEvent;
    try {
      event = JSON.parse(raw.toString('utf8')) as KycWebhookEvent;
    } catch {
      throw new AppError('INVALID_PAYLOAD', 400, 'Webhook body is not valid JSON.');
    }
    if (!event.eventId || !event.checkRef) {
      throw new AppError('INVALID_PAYLOAD', 400, 'Webhook is missing eventId or checkRef.');
    }

    /*
     * Replay protection. Claiming the id is what makes this exactly-once — and
     * it is claimed ONLY because this app can actually apply the event. Burning
     * an id we cannot act on would make Express treat the provider's retry as a
     * duplicate and drop it silently.
     */
    if (!(await this.repo.claim(event.eventId, 'kyc'))) {
      return { received: true, duplicate: true };
    }

    const result = await this.kyc.applyProviderDecision(
      event.checkRef,
      event.decision,
      event.reason,
    );

    if (!result.ok) {
      /* Still a 2xx: the event was genuine and is now recorded, so the provider
         must stop retrying. An unknown reference is our data problem, not
         theirs — logged loudly for a human. */
      this.logger.warn(
        { eventId: event.eventId, checkRef: event.checkRef, reason: result.reason },
        'kyc webhook: signed event could not be matched to a person',
      );
    }
    return { received: true, ...result };
  }
}
