import { describe, it, expect } from "vitest";
import { checkOrderLimits } from '../src/shared/money/order-limits';

const base = {
  tokensWanted: 10,
  tokensTotal: 100,
  tokensIssued: 0,
  reservedAll: 0,
  maxTokensPerInvestor: null as number | null,
  heldByPerson: 0,
  reservedByPerson: 0,
};

describe("checkOrderLimits", () => {
  it("allows an order that fits both caps", () => {
    expect(checkOrderLimits(base)).toEqual({ ok: true });
  });

  it("rejects on supply, reporting what's left", () => {
    const r = checkOrderLimits({ ...base, tokensWanted: 30, tokensIssued: 50, reservedAll: 40 });
    expect(r).toEqual({ ok: false, reason: "supply", remaining: 10 });
  });

  it("counts issued + reserved against supply", () => {
    // 100 total, 60 issued, 35 reserved → 5 left; asking 5 is the exact boundary.
    expect(checkOrderLimits({ ...base, tokensWanted: 5, tokensIssued: 60, reservedAll: 35 })).toEqual({ ok: true });
    expect(checkOrderLimits({ ...base, tokensWanted: 6, tokensIssued: 60, reservedAll: 35 })).toMatchObject({
      ok: false,
      reason: "supply",
    });
  });

  it("clamps remaining at 0 when oversold", () => {
    const r = checkOrderLimits({ ...base, tokensWanted: 1, tokensIssued: 90, reservedAll: 30 });
    expect(r).toEqual({ ok: false, reason: "supply", remaining: 0 });
  });

  it("enforces the per-investor cap across held + reserved", () => {
    // cap 50, already holds 30 + reserved 15 = 45 → can buy 5 more.
    const r = checkOrderLimits({ ...base, maxTokensPerInvestor: 50, heldByPerson: 30, reservedByPerson: 15, tokensWanted: 6 });
    expect(r).toEqual({ ok: false, reason: "investor", youCanBuy: 5 });
    expect(
      checkOrderLimits({ ...base, maxTokensPerInvestor: 50, heldByPerson: 30, reservedByPerson: 15, tokensWanted: 5 })
    ).toEqual({ ok: true });
  });

  it("ignores the per-investor cap when null", () => {
    expect(checkOrderLimits({ ...base, maxTokensPerInvestor: null, heldByPerson: 999, tokensWanted: 10 })).toEqual({
      ok: true,
    });
  });

  it("checks supply before the per-investor cap", () => {
    // Over both: supply is reported first.
    const r = checkOrderLimits({
      ...base,
      tokensWanted: 200,
      maxTokensPerInvestor: 5,
      heldByPerson: 100,
    });
    expect(r).toMatchObject({ ok: false, reason: "supply" });
  });
});
