import { describe, it, expect } from "vitest";
import { toPaise, fromPaise, sumPaise, allocatePayout } from '../src/shared/money/money';

describe("money (integer paise)", () => {
  it("converts rupees ↔ paise without float drift", () => {
    expect(toPaise("100.10")).toBe(10010n);
    expect(toPaise(0.1) + toPaise(0.2)).toBe(30n); // 0.1 + 0.2 as floats would not equal 0.3
    expect(fromPaise(30n)).toBe(0.3);
  });

  it("sums a list of amounts exactly", () => {
    // 0.1 + 0.2 + 0.3 in floats = 0.6000000000000001; in paise it's exact.
    expect(sumPaise(["0.1", "0.2", "0.3"])).toBe(60n);
    expect(fromPaise(sumPaise(["0.1", 0.2, "0.3"]))).toBe(0.6);
  });
});

describe("allocatePayout (largest-remainder)", () => {
  const sum = (cs: { amount: number }[]) => cs.reduce((s, c) => s + Math.round(c.amount * 100), 0);

  it("splits an evenly-divisible payout exactly", () => {
    const cs = allocatePayout(100, [
      { address: "0xa", balance: 1 },
      { address: "0xb", balance: 1 },
    ]);
    expect(cs.map((c) => c.amount)).toEqual([50, 50]);
  });

  it("distributes leftover paise to the largest remainders so the total is exact", () => {
    // 100 rupees across 3 equal holders = 33.3333… each. Independent rounding would
    // give 33.33 × 3 = 99.99 (a penny short); largest-remainder must sum to 100.00.
    const cs = allocatePayout(100, [
      { address: "0xa", balance: 1 },
      { address: "0xb", balance: 1 },
      { address: "0xc", balance: 1 },
    ]);
    expect(sum(cs)).toBe(10000); // exactly ₹100.00 in paise
    // amounts are 33.34, 33.33, 33.33 in some order
    expect(cs.map((c) => c.amount).sort()).toEqual([33.33, 33.33, 33.34]);
  });

  it("weights by balance and still sums exactly", () => {
    const cs = allocatePayout(1000, [
      { address: "0xa", balance: 700 },
      { address: "0xb", balance: 200 },
      { address: "0xc", balance: 100 },
    ]);
    expect(sum(cs)).toBe(100000); // ₹1000.00
    const byWallet = Object.fromEntries(cs.map((c) => [c.wallet, c.amount]));
    expect(byWallet["0xa"]).toBe(700);
    expect(byWallet["0xb"]).toBe(200);
    expect(byWallet["0xc"]).toBe(100);
  });

  it("returns nothing when there is no supply", () => {
    expect(allocatePayout(100, [])).toEqual([]);
    expect(allocatePayout(100, [{ address: "0xa", balance: 0 }])).toEqual([]);
  });
});
