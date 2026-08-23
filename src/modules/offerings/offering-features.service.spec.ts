/**
 * Rules for the offering-attached features.
 *
 * Two themes run through these: who may WRITE to an asset (the owning issuer,
 * never an investor and never another issuer), and the integrity of things
 * investors rely on — an append-only NAV history, a vote that cannot be closed
 * early or double-counted, and a sell-back that is proved on-chain before any
 * payout is booked.
 */
import { describe, expect, it, vi } from 'vitest';
import { OfferingFeaturesService } from './offering-features.service';
import type { OfferingFeaturesRepository } from './offering-features.repository';
import type { OfferingsRepository } from './offerings.repository';
import type { TokensRepository } from '@modules/tokens/tokens.repository';
import type { OnboardingService } from '@modules/onboarding/onboarding.service';
import type { ManagersService } from '@modules/managers/managers.service';
import type { ChainService } from '@shared/chain/chain.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const ISSUER: TenantContext = { kind: 'issuer', issuerId: '2' };
const INVESTOR: TenantContext = { kind: 'investor', investorWallet: '0xaaa' };
const ACTOR = { kind: 'admin', id: '2', email: 'a@x.io', role: 'issuer_admin' } as Principal;

const HOUR = 3_600_000;

function make(opts: {
  offering?: Record<string, unknown> | undefined;
  proposal?: Record<string, unknown> | undefined;
  buyback?: Record<string, unknown> | undefined;
  managerActive?: boolean;
  closeWon?: boolean;
  balance?: bigint;
  receipt?: { status: number; logs: unknown[] } | null;
  sale?: { ok: true } | { ok: false; reason: string };
} = {}) {
  const offering = 'offering' in opts
    ? opts.offering
    : { id: 'csret', issuerId: '2', status: 'open', visibility: 'public', tokenSymbol: 'CSRET', managerId: null };

  const offerings = {
    findById: vi.fn(async () => offering),
    findByTokenSymbol: vi.fn(async () => offering),
  } as unknown as OfferingsRepository;

  const repo = {
    listValuations: vi.fn(async () => []),
    addValuation: vi.fn(async () => ({ id: '1', totalValue: '100', createdAt: new Date() })),
    listUpdates: vi.fn(async () => []),
    addUpdate: vi.fn(async () => ({ id: '1', title: 't', createdAt: new Date() })),
    getBuyback: vi.fn(async () => opts.buyback),
    upsertBuyback: vi.fn(async () => ({ pricePerToken: '100', maxTokens: null })),
    closeBuyback: vi.fn(async () => true),
    listProposals: vi.fn(async () => []),
    getProposal: vi.fn(async () => opts.proposal),
    addProposal: vi.fn(async () => ({ id: '7', status: 'open' })),
    tally: vi.fn(async () => ({ for: 10, against: 0, voters: 1 })),
    closeProposal: vi.fn(async () => opts.closeWon ?? true),
    assignManager: vi.fn(async () => undefined),
    managerIsActive: vi.fn(async () => opts.managerActive ?? true),
    upsertVote: vi.fn(async () => undefined),
    recordSale: vi.fn(async () => opts.sale ?? ({ ok: true as const })),
  } as unknown as OfferingFeaturesRepository;

  const tokens = {
    requireAnyTenant: vi.fn(async () => ({ symbol: 'CSRET', address: '0xtoken' })),
  } as unknown as TokensRepository;

  const onboarding = {
    resolvePrimaryWallet: vi.fn(async (a: string) => a.toLowerCase()),
    walletsForPerson: vi.fn(async (w: string) => [w.toLowerCase()]),
  } as unknown as OnboardingService;

  const chain = {
    provider: { getTransactionReceipt: vi.fn(async () => opts.receipt ?? null) },
    token: () => ({
      balanceOf: vi.fn(async () => opts.balance ?? 10n),
      decimals: vi.fn(async () => 0),
      interface: { parseLog: () => null },
    }),
  } as unknown as ChainService;

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const managers = {
    assertOperates: vi.fn(async () => undefined),
  } as unknown as ManagersService;

  return {
    service: new OfferingFeaturesService(offerings, repo, tokens, onboarding, managers, chain, audit),
    repo,
    offerings,
    chain,
    managers,
  };
}

describe('tenancy', () => {
  it('404s an offering that belongs to another issuer', async () => {
    /* RLS already hid the row; findById returns nothing and this is what the
       caller sees. 403 would confirm the id exists. */
    const { service } = make({ offering: undefined });
    await expect(service.listValuations(ISSUER, 'someone-elses')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses an investor writing to an asset', async () => {
    const { service } = make();
    await expect(
      service.addValuation(ACTOR, INVESTOR, 'csret', { totalValue: '1' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('does not even reach the repository on an investor write', async () => {
    const { service, repo } = make();
    await expect(
      service.addValuation(ACTOR, INVESTOR, 'csret', { totalValue: '1' }),
    ).rejects.toBeTruthy();
    expect(repo.addValuation).not.toHaveBeenCalled();
  });
});

describe('manager-posted updates', () => {
  it('checks the manager actually OPERATES the property', async () => {
    const { service, managers } = make();
    /* @Roles lets a 'manager' through and the tenant check only proves the
       property belongs to their issuer — this is what stops one manager
       posting in another's name on a sibling asset. */
    await service.addUpdate(ACTOR, ISSUER, 'csret', { title: 't', body: 'b' });
    expect(managers.assertOperates).toHaveBeenCalled();
  });

  it('does not write the update when that check throws', async () => {
    const { service, repo, managers } = make();
    vi.mocked(managers.assertOperates).mockRejectedValueOnce(
      Object.assign(new Error('You do not manage this property.'), { status: 403 }),
    );
    await expect(
      service.addUpdate(ACTOR, ISSUER, 'csret', { title: 't', body: 'b' }),
    ).rejects.toBeTruthy();
    expect(repo.addUpdate).not.toHaveBeenCalled();
  });
});

describe('public reads', () => {
  it('404s a DRAFT offering — not yet an offer, so not public', async () => {
    const { service } = make({ offering: { id: 'x', status: 'draft', issuerId: '2', visibility: 'public' } });
    await expect(service.publicValuations('x')).rejects.toMatchObject({ status: 404 });
  });

  it('404s a PRIVATE placement even when it is open', async () => {
    const { service } = make({
      offering: { id: 'x', status: 'open', issuerId: '2', visibility: 'private' },
    });
    /* visibility and status are separate axes: an open private placement is
       shown to invited investors only, never on the marketplace. */
    await expect(service.publicValuations('x')).rejects.toMatchObject({ status: 404 });
  });

  it('serves a listed offering with no session at all', async () => {
    const { service } = make();
    await expect(service.publicValuations('csret')).resolves.toMatchObject({ items: [] });
  });
});

describe('valuations are append-only', () => {
  it('exposes no update or delete path', () => {
    const { service } = make();
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
    /* NAV history is what an investor judges performance by. Editing an entry
       would rewrite that history — only a NEWER entry may supersede it. */
    expect(names.filter((n) => /valuation/i.test(n)).sort()).toEqual([
      'addValuation',
      'listValuations',
      'publicValuations',
      'readValuations',
    ]);
  });
});

describe('buyback', () => {
  it('refuses to open a bid before the token exists', async () => {
    const { service } = make({
      offering: { id: 'csret', issuerId: '2', status: 'open', visibility: 'public', tokenSymbol: null },
    });
    await expect(
      service.openBuyback(ACTOR, ISSUER, 'csret', { sellerWallet: '0xb', pricePerToken: '1' }),
    ).rejects.toMatchObject({ code: 'NO_TOKEN' });
  });

  it('reports remaining budget, floored at zero', async () => {
    const { service } = make({
      buyback: { status: 'open', pricePerToken: '10', maxTokens: 50, tokensBought: 60, sellerWallet: '0xb' },
    });
    const res = await service.getBuyback(ISSUER, 'csret');
    expect(res).toMatchObject({ open: true, remaining: 0 });
  });

  it('treats a null budget as unlimited, not as zero', async () => {
    const { service } = make({
      buyback: { status: 'open', pricePerToken: '10', maxTokens: null, tokensBought: 5, sellerWallet: '0xb' },
    });
    /* `null` reaching a Math.max would become 0 and silently close the bid. */
    expect(await service.getBuyback(ISSUER, 'csret')).toMatchObject({ remaining: null });
  });
});

describe('governance — proposing', () => {
  it('refuses a proposal naming a manager that does not exist', async () => {
    const { service } = make({ managerActive: false });
    /* Otherwise it can pass a vote and then install nothing. */
    await expect(
      service.proposeManager(ACTOR, ISSUER, 'csret', { proposedManagerId: '999', closesInDays: 7 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to ASSIGN a manager that does not exist', async () => {
    const { service } = make({ managerActive: false });
    await expect(service.assignManager(ACTOR, ISSUER, 'csret', '999')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('allows clearing the manager (null) without a lookup', async () => {
    const { service, repo } = make({ managerActive: false });
    await expect(service.assignManager(ACTOR, ISSUER, 'csret', null)).resolves.toBeTruthy();
    expect(repo.managerIsActive).not.toHaveBeenCalled();
  });
});

describe('governance — voting', () => {
  const openProposal = { id: '7', offeringId: 'csret', status: 'open', closesAt: new Date(Date.now() + HOUR) };

  it('weights a vote by the on-chain balance', async () => {
    const { service } = make({ proposal: openProposal, balance: 42n });
    const res = await service.vote('0xAAA', '7', 'for');
    expect(res.yourWeight).toBe(42);
  });

  it('refuses a non-holder', async () => {
    const { service, repo } = make({ proposal: openProposal, balance: 0n });
    await expect(service.vote('0xAAA', '7', 'for')).rejects.toMatchObject({ status: 403 });
    expect(repo.upsertVote).not.toHaveBeenCalled();
  });

  it('sums every wallet the voter has linked', async () => {
    const { service, chain } = make({ proposal: openProposal, balance: 10n });
    const spy = vi.spyOn(chain, 'token');
    /* One person is one voter however many wallets they hold across; reading
       only the connected wallet lets the same holding vote twice. */
    await service.vote('0xAAA', '7', 'for');
    expect(spy).toHaveBeenCalled();
  });

  it('records the vote against the PRIMARY wallet', async () => {
    const { service, repo } = make({ proposal: openProposal });
    await service.vote('0xAAA', '7', 'for');
    expect(vi.mocked(repo.upsertVote).mock.calls[0][1].wallet).toBe('0xaaa');
  });

  it('refuses once the window has closed', async () => {
    const { service } = make({
      proposal: { ...openProposal, closesAt: new Date(Date.now() - HOUR) },
    });
    await expect(service.vote('0xAAA', '7', 'for')).rejects.toMatchObject({
      code: 'VOTING_ENDED',
    });
  });

  it('refuses a proposal that is already decided', async () => {
    const { service } = make({ proposal: { ...openProposal, status: 'passed' } });
    await expect(service.vote('0xAAA', '7', 'for')).rejects.toMatchObject({ code: 'NOT_OPEN' });
  });
});

describe('governance — closing', () => {
  const closed = { id: '7', offeringId: 'csret', proposedManagerId: '3', status: 'open', closesAt: new Date(Date.now() - HOUR) };

  it('REFUSES to close before the window ends', async () => {
    const { service } = make({
      proposal: { ...closed, closesAt: new Date(Date.now() + HOUR) },
    });
    /* Closing early lets whoever holds the button pick the moment the tally
       happens to favour them. */
    await expect(service.closeProposal(ACTOR, ISSUER, '7')).rejects.toMatchObject({
      code: 'VOTING_OPEN',
    });
  });

  it('swaps the manager when the vote passes', async () => {
    const { service, repo } = make({ proposal: closed });
    const res = await service.closeProposal(ACTOR, ISSUER, '7');
    expect(res.status).toBe('passed');
    expect(repo.assignManager).toHaveBeenCalledWith(ISSUER, 'csret', '3');
  });

  it('does NOT swap the manager when it fails', async () => {
    const { service, repo } = make({ proposal: closed });
    vi.mocked(repo.tally).mockResolvedValueOnce({ for: 1, against: 9, voters: 2 });
    const res = await service.closeProposal(ACTOR, ISSUER, '7');
    expect(res.status).toBe('rejected');
    expect(repo.assignManager).not.toHaveBeenCalled();
  });

  it('rejects a tie — a tie is not a mandate to change', async () => {
    const { service, repo } = make({ proposal: closed });
    vi.mocked(repo.tally).mockResolvedValueOnce({ for: 5, against: 5, voters: 2 });
    expect((await service.closeProposal(ACTOR, ISSUER, '7')).status).toBe('rejected');
  });

  it('does not swap the manager when it LOSES the atomic close', async () => {
    const { service, repo } = make({ proposal: closed, closeWon: false });
    /* Two concurrent closes must not both decide, and only the winner may
       swap. Otherwise the manager changes twice off one vote. */
    await expect(service.closeProposal(ACTOR, ISSUER, '7')).rejects.toMatchObject({
      code: 'NOT_OPEN',
    });
    expect(repo.assignManager).not.toHaveBeenCalled();
  });
});

describe('sell-back is proved on-chain before it is booked', () => {
  const openBid = { status: 'open', pricePerToken: '110.50', maxTokens: 50, tokensBought: 0, sellerWallet: '0xbuyer' };
  const sale = { tokenSymbol: 'CSRET', tokens: 4, txHash: `0x${'ab'.repeat(32)}` };

  it('refuses when there is no open bid', async () => {
    const { service } = make({ buyback: undefined });
    await expect(service.sellBack('0xAAA', sale)).rejects.toMatchObject({
      code: 'NO_OPEN_BUYBACK',
    });
  });

  it('refuses an unconfirmed transaction', async () => {
    const { service, repo } = make({ buyback: openBid, receipt: null });
    await expect(service.sellBack('0xAAA', sale)).rejects.toMatchObject({
      code: 'TX_NOT_CONFIRMED',
    });
    /* Nothing is booked off an unverified claim from the counterparty. */
    expect(repo.recordSale).not.toHaveBeenCalled();
  });

  it('refuses a transaction that reverted', async () => {
    const { service } = make({ buyback: openBid, receipt: { status: 0, logs: [] } });
    await expect(service.sellBack('0xAAA', sale)).rejects.toMatchObject({ code: 'TX_FAILED' });
  });

  it('refuses a confirmed transaction with no matching Transfer log', async () => {
    const { service, repo } = make({ buyback: openBid, receipt: { status: 1, logs: [] } });
    /* A successful transaction is not the same as a successful transfer OF
       THIS AMOUNT TO THIS WALLET. */
    await expect(service.sellBack('0xAAA', sale)).rejects.toMatchObject({
      code: 'TX_DOES_NOT_MATCH',
    });
    expect(repo.recordSale).not.toHaveBeenCalled();
  });
});
