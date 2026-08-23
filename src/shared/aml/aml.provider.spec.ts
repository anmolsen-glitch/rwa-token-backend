/**
 * AML decision bands and aggregation.
 *
 * `worse()` is the load-bearing function: it decides whether a person with one
 * clean wallet and one sanctioned wallet is clear or blocked. Getting it
 * backwards is how a flagged address gets laundered behind a fresh one.
 */
import { describe, expect, it } from 'vitest';
import { decisionFor, levelFor, worse, type AmlStatus } from './aml.provider';
import { MockAmlProvider } from './mock.aml.provider';

describe('decision bands', () => {
  it('clears a low score', () => {
    expect(decisionFor(0, false)).toBe('clear');
    expect(decisionFor(39, false)).toBe('clear');
  });

  it('sends a mid score to manual review', () => {
    expect(decisionFor(40, false)).toBe('review');
    expect(decisionFor(69, false)).toBe('review');
  });

  it('blocks a high score', () => {
    expect(decisionFor(70, false)).toBe('blocked');
  });

  it('BLOCKS a sanctions match regardless of score', () => {
    /* A listed address is a hard stop; the score is irrelevant. */
    expect(decisionFor(0, true)).toBe('blocked');
  });

  it('maps scores to levels', () => {
    expect(levelFor(10)).toBe('low');
    expect(levelFor(50)).toBe('medium');
    expect(levelFor(75)).toBe('high');
    expect(levelFor(95)).toBe('severe');
  });
});

describe('aggregation is pessimistic', () => {
  const cases: Array<[AmlStatus, AmlStatus, AmlStatus]> = [
    ['clear', 'blocked', 'blocked'],
    ['blocked', 'clear', 'blocked'],
    ['clear', 'review', 'review'],
    ['review', 'blocked', 'blocked'],
    ['unscreened', 'clear', 'clear'],
    ['unscreened', 'unscreened', 'unscreened'],
    ['clear', 'clear', 'clear'],
  ];

  for (const [a, b, expected] of cases) {
    it(`${a} + ${b} -> ${expected}`, () => {
      expect(worse(a, b)).toBe(expected);
      /* Order must not matter, or the result would depend on wallet ordering. */
      expect(worse(b, a)).toBe(expected);
    });
  }

  it('one sanctioned wallet blocks the whole person', () => {
    /* The case the whole design exists for. */
    const wallets: AmlStatus[] = ['clear', 'clear', 'blocked', 'clear'];
    expect(wallets.reduce(worse, 'unscreened' as AmlStatus)).toBe('blocked');
  });
});

describe('mock provider', () => {
  const sanctioned = '0x1111111111111111111111111111111111111111';
  const review = '0x2222222222222222222222222222222222222222';
  const provider = new MockAmlProvider(new Set([sanctioned]), new Set([review]));

  it('blocks a listed address with the sanctions category', async () => {
    const r = await provider.screenAddress(sanctioned);
    expect(r.decision).toBe('blocked');
    expect(r.sanctioned).toBe(true);
    expect(r.categories).toContain('sanctions');
  });

  it('sends a watchlisted address to review, not a block', async () => {
    const r = await provider.screenAddress(review);
    expect(r.decision).toBe('review');
    expect(r.sanctioned).toBe(false);
  });

  it('clears an ordinary address', async () => {
    const r = await provider.screenAddress('0x9999999999999999999999999999999999999999');
    expect(r.decision).toBe('clear');
    expect(r.riskScore).toBeLessThan(40);
  });

  it('is deterministic — the same address always screens the same', async () => {
    const addr = '0x8888888888888888888888888888888888888888';
    const a = await provider.screenAddress(addr);
    const b = await provider.screenAddress(addr);
    expect(a.riskScore).toBe(b.riskScore);
    expect(a.decision).toBe(b.decision);
  });

  it('is case-insensitive about the address', async () => {
    const lower = await provider.screenAddress(sanctioned);
    const upper = await provider.screenAddress(sanctioned.toUpperCase().replace('0X', '0x'));
    expect(upper.decision).toBe(lower.decision);
  });
});
