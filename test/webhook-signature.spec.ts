import { describe, it, expect } from "vitest";
import { signPayload, verifyPayload } from '../src/shared/webhooks/webhook-signature';

describe("webhook HMAC signatures", () => {
  const secret = "test-secret";

  it("verifies a signature it produced", () => {
    const body = JSON.stringify({ paymentRef: "abc", type: "captured" });
    expect(verifyPayload(body, signPayload(body, secret), secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signPayload('{"amount":100}', secret);
    expect(verifyPayload('{"amount":999}', sig, secret)).toBe(false);
  });

  it("rejects a wrong signature", () => {
    expect(verifyPayload("body", "deadbeef", secret)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyPayload("body", undefined, secret)).toBe(false);
    expect(verifyPayload("body", null, secret)).toBe(false);
  });

  it("rejects a non-hex signature without throwing", () => {
    expect(verifyPayload("body", "not-hex-!!", secret)).toBe(false);
  });

  it("round-trips with any secret (the default now comes from config, not a module global)", () => {
    const body = "hello";
    expect(verifyPayload(body, signPayload(body, secret), secret)).toBe(true);
  });
});
