/**
 * previewTransfer collects EVERY failure reason instead of stopping at the
 * first — the UI shows them all before the investor spends gas.
 */
import { describe, expect, it } from 'vitest';
import { PortfolioService } from './portfolio.service';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

interface ChainState {
  paused: boolean;
  senderFrozen: boolean;
  recipientFrozen: boolean;
  balance: bigint;
  frozenTokens: bigint;
  recipientVerified: boolean;
}

function serviceWith(state: ChainState): PortfolioService {
  const token = {
    decimals: async () => 0n,
    paused: async () => state.paused,
    isFrozen: async (w: string) =>
      w === SENDER ? state.senderFrozen : state.recipientFrozen,
    balanceOf: async () => state.balance,
    getFrozenTokens: async () => state.frozenTokens,
    identityRegistry: async () => '0x' + '1'.repeat(40),
    compliance: async () => '0x' + '2'.repeat(40),
  };
  const registry = { isVerified: async () => state.recipientVerified };
  const chain = {
    provider: { getCode: async () => '0x6001' },
    token: () => token,
    identityRegistry: () => registry,
  };
  const tokens = {
    require: async () => ({ symbol: 'DEMO', address: '0x' + '3'.repeat(40) }),
  };
  /* No lockup module configured — that branch needs a live contract. */
  const config = { get: () => undefined };

  return new PortfolioService(
    tokens as never,
    undefined as never, // offerings
    undefined as never, // onboarding
    undefined as never, // aml
    undefined as never, // siwe
    chain as never,
    undefined as never, // audit
    config as never,
  );
}

const HEALTHY: ChainState = {
  paused: false,
  senderFrozen: false,
  recipientFrozen: false,
  balance: 100n,
  frozenTokens: 0n,
  recipientVerified: true,
};

describe('PortfolioService.previewTransfer', () => {
  it('approves a clean transfer and reports the available balance', async () => {
    const out = await serviceWith(HEALTHY).previewTransfer(SENDER, 'DEMO', RECIPIENT, 10);
    expect(out).toMatchObject({ ok: true, reasons: [], symbol: 'DEMO', amount: 10, available: 100 });
  });

  it('collects every failure reason, not just the first', async () => {
    const out = await serviceWith({
      paused: true,
      senderFrozen: true,
      recipientFrozen: true,
      balance: 5n,
      frozenTokens: 2n,
      recipientVerified: false,
    }).previewTransfer(SENDER, 'DEMO', RECIPIENT, 10);
    expect(out.ok).toBe(false);
    expect(out.reasons).toHaveLength(5);
    expect(out.available).toBe(3); // balance minus frozen
  });

  it('rejects an invalid recipient address', async () => {
    await expect(
      serviceWith(HEALTHY).previewTransfer(SENDER, 'DEMO', 'not-an-address', 1),
    ).rejects.toMatchObject({ code: 'INVALID_RECIPIENT', status: 400 });
  });

  it('rejects sending to the sending wallet itself', async () => {
    await expect(
      serviceWith(HEALTHY).previewTransfer(SENDER, 'DEMO', SENDER, 1),
    ).rejects.toMatchObject({ code: 'SELF_TRANSFER', status: 400 });
  });

  it('503s when the token record has no contract on this chain', async () => {
    const svc = serviceWith(HEALTHY);
    (svc as unknown as { chain: { provider: { getCode: () => Promise<string> } } }).chain.provider.getCode =
      async () => '0x';
    await expect(svc.previewTransfer(SENDER, 'DEMO', RECIPIENT, 1)).rejects.toMatchObject({
      code: 'TOKEN_NOT_DEPLOYED',
      status: 503,
    });
  });
});
