/**
 * Webhook signature verification.
 *
 * Every payment/KYC vendor signs its webhooks so you can prove the call really
 * came from them (and wasn't forged by anyone who learned your URL). The schemes
 * differ per vendor — Stripe uses `t=...,v1=HMAC`, others a plain header — but the
 * shape is always "HMAC the raw body with a shared secret and compare". We model
 * that here; a real provider's verifyWebhook() can reuse `verifyPayload` or swap
 * in the vendor SDK's verifier.
 *
 * Always verify against the RAW request bytes, never the re-serialized JSON —
 * re-encoding can reorder keys or change spacing and break the signature.
 */
import crypto from "crypto";

/*
 * PORTED VERBATIM from ../rwa-token-backend/src/lib/webhookSig.ts, apart from
 * the secret: there it came from a module-level config import; here it is an
 * explicit parameter so the function stays pure and injectable. The HMAC and
 * the constant-time comparison are byte-for-byte unchanged — this is the code
 * that decides whether a payment event is genuine, and it must not "improve"
 * during a migration.
 *
 * Its test (test/webhook-signature.spec.ts) is the original, unedited apart
 * from the import path and the default-secret case.
 */

/** HMAC-SHA256 the payload, hex-encoded. */
export function signPayload(raw: Buffer | string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

/** Constant-time check that `signature` is a valid HMAC of `raw`. */
export function verifyPayload(
  raw: Buffer | string,
  signature: string | undefined | null,
  secret: string
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signPayload(raw, secret), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
