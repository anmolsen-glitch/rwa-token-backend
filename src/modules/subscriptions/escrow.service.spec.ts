/**
 * Escrow: closing a raise, and the sweepers that clean up after it.
 *
 * This is the code that decides whether investors get tokens or their money
 * back, so the tests are about ORDER and IDEMPOTENCE rather than shape: the
 * outcome must be committed before any money moves, a re-run must follow the
 * outcome already recorded, and nothing may double-mint or double-refund.
 */
import { describe, expect, it, vi } from 'vitest';
import { SubscriptionsService } from './subscriptions.service';
import type { SubscriptionsRepository } from './subscriptions.repository';
import type { OfferingsRepository } from '@modules/offerings/offerings.repository';
import type { TokensRepository } from '@modules/tokens/tokens.repository';
import type { ChainService } from '@shared/chain/chain.service';
import type { SignerService } from '@shared/chain/signer.service';
import type { TxService } from '@shared/chain/tx.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { AppConfig } from '@shared/config/app-config.service';
import type { PaymentProvider } from '@shared/payments/payment.provider';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const ISSUER: TenantContext = { kind: 'issuer', issuerId: '2' };
const ACTOR = { kind: 'admin', id: '9', email: 'a@x.io', role: 'issuer_admin' } as Principal;

const order = (over: Record<string, unknown> = {}) => ({
  id: '1',
  reference: 'ord_a',
  wallet: '0xaaa',
  offeringId: 'csret',
  tokenSymbol: 'CSRET',
  amountFiat: '40000',
  currency: 'INR',
  tokens: 26,
  status: 'paid',
  paymentRef: 'mock_a',
  txHash: null,
  error: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

function make(opts: {
  offering?: Record<string, unknown> | undefined;
  escrowed?: ReturnType<typeof order>[];
  claimClose?: boolean;
  claimRefund?: boolean;
  refundOk?: boolean;
} = {}) {
  const repo = {
    byOfferingStatus: vi.fn(async () => opts.escrowed ?? [order()]),
    claimOfferingClosed: vi.fn(async () => opts.claimClose ?? true),
    claimForRefund: vi.fn(async () => opts.claimRefund ?? true),
    claimForSettlement: vi.fn(async () => true),
    byId: vi.fn(async () => order()),
    update: vi.fn(async () => undefined),
    stalePendingPayment: vi.fn(async () => []),
    staleSettling: vi.fn(async () => []),
    expirePendingPayment: vi.fn(async () => true),
  } as unknown as SubscriptionsRepository;

  const offerings = {
    findById: vi.fn(async () =>
      'offering' in opts
        ? opts.offering
        : { id: 'csret', status: 'open', minimumRaise: '100000', sellerWallet: null },
    ),
  } as unknown as OfferingsRepository;

  const payments = {
    refund: vi.fn(async () => ({ ok: opts.refundOk ?? true })),
    capture: vi.fn(async () => ({ ok: true })),
  } as unknown as PaymentProvider;

  const tokens = { requireAnyTenant: vi.fn(async () => ({ symbol: 'CSRET', address: '0xtok' })) } as unknown as TokensRepository;
  const chain = {
    provider: { getTransactionReceipt: vi.fn(async () => null), getTransaction: vi.fn(async () => null) },
    token: () => ({ decimals: vi.fn(async () => 0), mint: vi.fn() }),
  } as unknown as ChainService;
  const signers = { get: () => ({}) } as unknown as SignerService;
  const tx = { submit: vi.fn(async () => ({ hash: '0xdead' })) } as unknown as TxService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const config = { get: () => '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' } as unknown as AppConfig;

  const service = new SubscriptionsService(
    repo, offerings, config, tokens, chain, signers, tx, audit, payments,
  );
  return { service, repo, offerings, payments, audit };
}

describe('closing an escrowed raise', () => {
  it('refuses an offering with NO minimum raise', async () => {
    const { service, repo } = make({
      offering: { id: 'csret', status: 'open', minimumRaise: null },
    });
    /* Those orders settled on payment; there is nothing held to decide. */
    await expect(service.closeOffering(ACTOR, ISSUER, 'csret')).rejects.toMatchObject({
      code: 'NOT_ESCROWED',
    });
    expect(repo.claimOfferingClosed).not.toHaveBeenCalled();
  });

  it("404s another issuer's offering", async () => {
    const { service } = make({ offering: undefined });
    await expect(service.closeOffering(ACTOR, ISSUER, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('COMMITS THE OUTCOME BEFORE MOVING MONEY', async () => {
    const { service, repo } = make();
    const calls: string[] = [];
    vi.mocked(repo.claimOfferingClosed).mockImplementation(async () => {
      calls.push('outcome');
      return true;
    });
    vi.mocked(repo.claimForRefund).mockImplementation(async () => {
      calls.push('refund');
      return true;
    });
    await service.closeOffering(ACTOR, ISSUER, 'csret');
    /* The reverse order would let a concurrent close settle what this one is
       refunding — the outcome has to be decided exactly once, first. */
    expect(calls[0]).toBe('outcome');
  });

  it('cancels and refunds everyone when the raise falls short', async () => {
    const { service, repo, payments } = make({
      escrowed: [order(), order({ id: '2', reference: 'ord_b', amountFiat: '20000' })],
    });
    const res = await service.closeOffering(ACTOR, ISSUER, 'csret');
    /* 40000 + 20000 = 60000 < 100000 */
    expect(res.outcome).toBe('cancelled');
    expect(res.refunded).toEqual(['ord_a', 'ord_b']);
    expect(res.settled).toEqual([]);
    expect(vi.mocked(repo.claimOfferingClosed).mock.calls[0][1]).toBe('cancelled');
    expect(payments.refund).toHaveBeenCalledTimes(2);
  });

  it('funds and settles when the minimum is met', async () => {
    const { service, repo } = make({
      escrowed: [order({ amountFiat: '150000' })],
    });
    const res = await service.closeOffering(ACTOR, ISSUER, 'csret');
    expect(res.outcome).toBe('funded');
    expect(vi.mocked(repo.claimOfferingClosed).mock.calls[0][1]).toBe('funded');
  });

  it('decides in integer paise, so a fractional total cannot flip it', async () => {
    const { service } = make({
      offering: { id: 'csret', status: 'open', minimumRaise: '0.30' },
      escrowed: [order({ amountFiat: '0.10' }), order({ id: '2', amountFiat: '0.20' })],
    });
    /* 0.1 + 0.2 as floats is 0.30000000000000004 — and in the other direction a
       float sum can land just BELOW a minimum that was exactly met. */
    expect((await service.closeOffering(ACTOR, ISSUER, 'csret')).outcome).toBe('funded');
  });

  it('REFUNDS an order whose mint is blocked, rather than stranding it', async () => {
    const { service, repo, payments } = make({ escrowed: [order({ amountFiat: '150000' })] });
    vi.mocked(repo.claimForSettlement).mockResolvedValueOnce(false);
    const res = await service.closeOffering(ACTOR, ISSUER, 'csret');
    /* The raise succeeded but this investor cannot receive tokens (lost
       verification, say). Their money must come back. */
    expect(res.outcome).toBe('funded');
    expect(res.refunded).toEqual(['ord_a']);
    expect(payments.refund).toHaveBeenCalled();
  });

  it('loses gracefully when another close already claimed the outcome', async () => {
    const { service, payments } = make({ claimClose: false });
    await expect(service.closeOffering(ACTOR, ISSUER, 'csret')).rejects.toMatchObject({
      code: 'CLOSE_IN_PROGRESS',
    });
    /* And touches no money on the way out. */
    expect(payments.refund).not.toHaveBeenCalled();
  });

  it('refuses a re-run with nothing left to process', async () => {
    const { service } = make({
      offering: { id: 'csret', status: 'cancelled', minimumRaise: '100000' },
      escrowed: [],
    });
    await expect(service.closeOffering(ACTOR, ISSUER, 'csret')).rejects.toMatchObject({
      code: 'ALREADY_CLOSED',
    });
  });

  it('a re-run FOLLOWS the recorded outcome instead of re-deciding', async () => {
    const { service, repo } = make({
      /* Recorded `funded`, but the leftover order alone is under the minimum —
         re-deciding from it would reverse the verdict and refund people who
         were already told they were in. */
      offering: { id: 'csret', status: 'funded', minimumRaise: '100000' },
      escrowed: [order({ amountFiat: '10' })],
    });
    const res = await service.closeOffering(ACTOR, ISSUER, 'csret');
    expect(res.outcome).toBe('funded');
    expect(repo.claimOfferingClosed).not.toHaveBeenCalled();
  });

  it('reports failed refunds instead of dropping them', async () => {
    const { service } = make({ refundOk: false });
    const res = await service.closeOffering(ACTOR, ISSUER, 'csret');
    /* Silently swallowing these would report money as returned when it was
       not. They stay `paid` and a re-run retries them. */
    expect(res.failedRefunds).toEqual(['ord_a']);
    expect(res.refunded).toEqual([]);
  });

  it('does not call the provider twice for one order', async () => {
    const { service, payments } = make({ claimRefund: false });
    await service.closeOffering(ACTOR, ISSUER, 'csret');
    /* The claim is the guard: losing it means someone else owns the refund. */
    expect(payments.refund).not.toHaveBeenCalled();
  });
});

describe('the reservation sweeper', () => {
  it('releases only what the conditional UPDATE actually claimed', async () => {
    const { service, repo } = make();
    vi.mocked(repo.stalePendingPayment).mockResolvedValueOnce([
      order({ id: '1' }),
      order({ id: '2' }),
    ] as never);
    vi.mocked(repo.expirePendingPayment)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false); // paid mid-scan — the payment wins

    const res = await service.expireStaleReservations(60);
    expect(res).toEqual({ scanned: 2, released: 1 });
  });
});

describe('settlement recovery', () => {
  const settling = (over = {}) => order({ status: 'settling', txHash: '0xdead', ...over });

  it('marks settled when the receipt says the mint landed', async () => {
    const { service, repo } = make();
    vi.mocked(repo.staleSettling).mockResolvedValueOnce([settling()] as never);
    const chain = (service as unknown as { chain: { provider: { getTransactionReceipt: ReturnType<typeof vi.fn> } } }).chain;
    chain.provider.getTransactionReceipt = vi.fn(async () => ({ status: 1 }));

    const res = await service.recoverStaleSettlements(10);
    expect(res.settled).toBe(1);
    expect(vi.mocked(repo.update).mock.calls[0][1]).toMatchObject({ status: 'settled' });
  });

  it('LEAVES a transaction still in the mempool alone', async () => {
    const { service, repo } = make();
    vi.mocked(repo.staleSettling).mockResolvedValueOnce([settling()] as never);
    const chain = (service as unknown as { chain: { provider: Record<string, unknown> } }).chain;
    chain.provider.getTransactionReceipt = vi.fn(async () => null);
    chain.provider.getTransaction = vi.fn(async () => ({ hash: '0xdead' }));

    const res = await service.recoverStaleSettlements(10);
    /* Requeueing a mint that is about to land would issue tokens twice. */
    expect(res).toMatchObject({ pending: 1, settled: 0, requeued: 0 });
  });

  it('requeues a transaction the chain has never heard of', async () => {
    const { service, repo } = make();
    vi.mocked(repo.staleSettling).mockResolvedValueOnce([settling()] as never);
    const chain = (service as unknown as { chain: { provider: Record<string, unknown> } }).chain;
    chain.provider.getTransactionReceipt = vi.fn(async () => null);
    chain.provider.getTransaction = vi.fn(async () => null);

    expect((await service.recoverStaleSettlements(10)).requeued).toBe(1);
  });

  it('does NOT guess when the RPC itself fails', async () => {
    const { service, repo } = make();
    vi.mocked(repo.staleSettling).mockResolvedValueOnce([settling()] as never);
    const chain = (service as unknown as { chain: { provider: Record<string, unknown> } }).chain;
    chain.provider.getTransactionReceipt = vi.fn(async () => {
      throw new Error('RPC down');
    });
    /* Guessing either way is worse than waiting: settled invents tokens,
       requeued issues them twice. */
    expect((await service.recoverStaleSettlements(10))).toMatchObject({ pending: 1, requeued: 0 });
    expect(repo.update).not.toHaveBeenCalled();
  });
});
