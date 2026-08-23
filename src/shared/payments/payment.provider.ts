/**
 * Payment provider abstraction — the same idea as the signer abstraction.
 *
 * The rest of the code asks for a `PaymentProvider` and calls createCheckout /
 * capture; it doesn't care whether the money moves through a mock, Stripe, or a
 * stablecoin settler. Dev uses `mock` (instant capture, no real funds). Going
 * live is an env change + one new class — not a rewrite of the invest flow.
 *
 *   PAYMENT_PROVIDER=mock        -> instant success (DEV)
 *   PAYMENT_PROVIDER=stripe      -> implement StripeProvider (prod)
 *   PAYMENT_PROVIDER=stablecoin  -> implement on-chain settlement (prod)
 */
import { verifyPayload } from "../webhooks/webhook-signature";

/*
 * PORTED from ../rwa-token-backend/src/lib/payments.ts. The freshness window and
 * the webhook parsing are unchanged — they are what stop a captured payload
 * being replayed later. Provider selection moves to payments.module.ts (a Nest
 * factory) instead of a module-level singleton.
 */

export interface CheckoutInput {
  reference: string;
  amountFiat: number;
  currency: string;
  wallet: string;
  description: string;
}

/** A verified payment-provider webhook, normalised across vendors. */
export interface PaymentEvent {
  /** Provider's unique event id — the replay-protection key (webhook_events). */
  eventId: string;
  paymentRef: string;
  type: "captured" | "failed" | "refunded";
}

/** Reject webhooks older than this — a captured payload must not replay later. */
export const WEBHOOK_MAX_AGE_SECONDS = 300;

/** Is the event's issued-at timestamp (epoch seconds) within tolerance of now? */
export function webhookTimestampFresh(ts: unknown): boolean {
  if (typeof ts !== "number" || !isFinite(ts)) return false;
  return Math.abs(Date.now() / 1000 - ts) <= WEBHOOK_MAX_AGE_SECONDS;
}

export interface PaymentProvider {
  readonly name: string;
  /** Create a payment intent/checkout for an order. Returns the provider's ref. */
  createCheckout(input: CheckoutInput): Promise<{ paymentRef: string; checkoutUrl: string | null }>;
  /** Capture/confirm the payment. In production this is usually driven by a webhook. */
  capture(paymentRef: string): Promise<{ ok: boolean; error?: string }>;
  /** Refund a captured payment (escrow returned to the investor when a raise fails). */
  refund(paymentRef: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Verify + parse an inbound webhook. Returns the normalised event, or null if
   * the signature is invalid / the body unparseable (caller responds 400).
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null;
}

/** Dev provider: no real money. Checkout/capture/refund succeed instantly. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  /* The webhook secret is injected rather than read from a module-level config
     import, so the class stays pure and testable. */
  constructor(private readonly secret: string) {}
  async createCheckout(input: CheckoutInput) {
    return { paymentRef: `mock_${input.reference}`, checkoutUrl: null };
  }
  async capture(_paymentRef: string) {
    return { ok: true as const };
  }
  async refund(_paymentRef: string) {
    return { ok: true as const };
  }
  verifyWebhook(rawBody: Buffer, signature: string | undefined): PaymentEvent | null {
    if (!verifyPayload(rawBody, signature, this.secret)) return null;
    try {
      const body = JSON.parse(rawBody.toString("utf8"));
      if (typeof body.paymentRef !== "string") return null;
      if (!["captured", "failed", "refunded"].includes(body.type)) return null;
      // Replay protection: a unique event id (deduped in webhook_events) and a
      // fresh issued-at timestamp (`ts`, epoch seconds) are both required —
      // matching what real providers (e.g. Stripe) put in their signed payloads.
      if (typeof body.eventId !== "string" || body.eventId === "") return null;
      if (!webhookTimestampFresh(body.ts)) return null;
      return { eventId: body.eventId, paymentRef: body.paymentRef, type: body.type };
    } catch {
      return null;
    }
  }
}

/** Injection token — see payments.module.ts. */
export const PAYMENT_PROVIDER_TOKEN = Symbol("PAYMENT_PROVIDER");
