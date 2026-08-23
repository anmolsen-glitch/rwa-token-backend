/**
 * PORTED VERBATIM from ../rwa-token-backend/src/lib/money.ts, with its test.
 * This is the code that decides whether a minimum raise was met and how a payout
 * splits; it must not drift by a rounding mode during a migration.
 *
 * Integer-paise money helpers. Fiat amounts are stored as NUMERIC in Postgres but
 * arrive as strings/numbers; doing comparisons and sums in floating point lets
 * rounding error creep into money decisions (e.g. "did we hit the minimum raise").
 * Convert to integer minor units (paise = 1/100 rupee) and compare/sum as BigInt.
 */

/** Rupees (string | number) → integer paise. Rounds to the nearest paise. */
export function toPaise(amount: string | number): bigint {
  return BigInt(Math.round(Number(amount) * 100));
}

/** Integer paise → rupees as a number (2 dp). For display / storage of derived values. */
export function fromPaise(paise: bigint): number {
  return Number(paise) / 100;
}

/** Sum a list of rupee amounts exactly, in paise. */
export function sumPaise(amounts: (string | number)[]): bigint {
  return amounts.reduce<bigint>((s, a) => s + toPaise(a), 0n);
}

/**
 * Split `totalAmount` (rupees) across holders pro-rata to balance using the
 * largest-remainder method in integer paise, so the per-holder amounts sum to the
 * declared total EXACTLY — no dropped or duplicated pennies. Balances are whole
 * tokens (decimals === 0 is enforced at asset creation).
 */
export function allocatePayout(
  totalAmount: number,
  holders: { address: string; balance: string | number }[],
): { wallet: string; amount: number }[] {
  const bal = holders.map((h) => BigInt(Math.round(Number(h.balance))));
  const supply = bal.reduce((a, b) => a + b, 0n);
  if (supply <= 0n) return [];
  const totalPaise = toPaise(totalAmount);

  const alloc = holders.map((h, i) => {
    const numerator = totalPaise * bal[i];
    const paise = numerator / supply;              // BigInt floor
    return { wallet: h.address, paise, rem: numerator - paise * supply };
  });

  // Hand out the leftover paise one at a time to the largest fractional remainders.
  const distributed = alloc.reduce((s, a) => s + a.paise, 0n);
  const leftover = Number(totalPaise - distributed);
  [...alloc].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0))
    .slice(0, leftover)
    .forEach((a) => { a.paise += 1n; });

  return alloc.map((a) => ({ wallet: a.wallet, amount: fromPaise(a.paise) }));
}
