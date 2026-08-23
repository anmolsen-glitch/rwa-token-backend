/**
 * PORTED VERBATIM from ../rwa-token-backend/src/lib/limits.ts, with its test.
 *
 * Kept a PURE function on purpose: this arithmetic decides whether an investor
 * may buy, and it is evaluated INSIDE the offering row lock (see
 * SubscriptionsRepository.createOrderAtomic). Pure means it stays unit-testable
 * without a database — which is why its test survives the port unchanged.
 */
/**
 * Pure investment-limit math, extracted so it can be unit-tested without a DB or
 * chain. The *enforcement* (reading the contended values under a row lock) lives
 * in db.createOrderAtomic; this module only decides, given a consistent snapshot,
 * whether an order fits the supply cap and the per-investor cap.
 *
 * All amounts are whole tokens (these are 0-decimal security tokens).
 */
export interface LimitInputs {
  /** Tokens this order wants to reserve. */
  tokensWanted: number;
  /** Total tokens the offering will ever issue (target raise / price). */
  tokensTotal: number;
  /** Tokens already minted on-chain (from the indexer). */
  tokensIssued: number;
  /** Tokens reserved by every not-yet-settled order on this offering. */
  reservedAll: number;
  /** Per-investor cap in tokens, or null for no cap. */
  maxTokensPerInvestor: number | null;
  /** Tokens this person already holds, across all their wallets. */
  heldByPerson: number;
  /** Tokens this person has reserved (unsettled), across all their wallets. */
  reservedByPerson: number;
}

export type LimitResult =
  | { ok: true }
  | { ok: false; reason: "supply"; remaining: number }
  | { ok: false; reason: "investor"; youCanBuy: number };

/**
 * Decide whether an order fits. Supply is checked first (the whole raise), then
 * the per-investor cap (aggregated across the person's wallets). `remaining` /
 * `youCanBuy` are clamped at 0 so callers can show a friendly "you can buy N".
 */
export function checkOrderLimits(i: LimitInputs): LimitResult {
  const remaining = i.tokensTotal - i.tokensIssued - i.reservedAll;
  if (i.tokensWanted > remaining) {
    return { ok: false, reason: "supply", remaining: Math.max(remaining, 0) };
  }
  if (i.maxTokensPerInvestor !== null) {
    const committed = i.heldByPerson + i.reservedByPerson;
    if (committed + i.tokensWanted > i.maxTokensPerInvestor) {
      return { ok: false, reason: "investor", youCanBuy: Math.max(i.maxTokensPerInvestor - committed, 0) };
    }
  }
  return { ok: true };
}
