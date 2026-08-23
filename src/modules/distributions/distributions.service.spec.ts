/**
 * Distribution rules.
 *
 * This module decides what each holder is OWED, so the tests fall into two
 * groups: who may declare a payout (and against which asset), and whether the
 * money arithmetic and the claim transition can lose or duplicate anything.
 */
import { describe, expect, it, vi } from 'vitest';
import { DistributionsService } from './distributions.service';
import type { DistributionsRepository } from './distributions.repository';
import type { TokensRepository } from '@modules/tokens/tokens.repository';
import type { OfferingsRepository } from '@modules/offerings/offerings.repository';
import type { ManagersService } from '@modules/managers/managers.service';
import type { OnboardingService } from '@modules/onboarding/onboarding.service';
import type { AuditService } from '@shared/audit/audit.service';
import { AppError } from '@shared/errors/app-error';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const ISSUER: TenantContext = { kind: 'issuer', issuerId: '2' };
const ACTOR = { kind: 'admin', id: '9', email: 'a@x.io', role: 'issuer_admin' } as Principal;

function make(opts: {
  holders?: { address: string; balance: string }[];
  claims?: { id: string; amount: string; status: string; claimedAt: Date | null; tokenSymbol: string; currency: string; note: string | null; declaredAt: Date }[];
  claimed?: { count: number; total: number };
  offering?: { id: string; managerId: string | null } | undefined;
  wallets?: string[];
} = {}) {
  const repo = {
    holders: vi.fn(async () => opts.holders ?? [
      { address: '0xa', balance: '50' },
      { address: '0xb', balance: '190' },
      { address: '0xc', balance: '60' },
    ]),
    list: vi.fn(async () => []),
    declare: vi.fn(async () => ({
      id: '1',
      tokenSymbol: 'MBWT',
      totalAmount: '1000',
      currency: 'INR',
      note: null,
      declaredByEmail: 'a@x.io',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })),
    claimsForWallets: vi.fn(async () => opts.claims ?? []),
    claimAll: vi.fn(async () => opts.claimed ?? { count: 1, total: 200 }),
  } as unknown as DistributionsRepository;

  const tokens = {
    require: vi.fn(async () => ({ symbol: 'MBWT', address: '0xtoken', issuerId: '2' })),
  } as unknown as TokensRepository;

  const offerings = {
    findByTokenSymbol: vi.fn(async () =>
      'offering' in opts ? opts.offering : { id: 'bandra', managerId: '5' },
    ),
  } as unknown as OfferingsRepository;

  const managers = { assertOperates: vi.fn(async () => undefined) } as unknown as ManagersService;

  const onboarding = {
    resolvePrimaryWallet: vi.fn(async (w: string) => w.toLowerCase()),
    walletsForPerson: vi.fn(async (w: string) => opts.wallets ?? [w.toLowerCase()]),
  } as unknown as OnboardingService;

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;

  return {
    service: new DistributionsService(repo, tokens, offerings, managers, onboarding, audit),
    repo,
    tokens,
    managers,
    onboarding,
    audit,
  };
}

describe('who may declare', () => {
  it('resolves the token FIRST — that is the tenant check', async () => {
    const { service, tokens } = make();
    await service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' });
    /* Another issuer's symbol 404s here rather than allocating their cap
       table's money. */
    expect(tokens.require).toHaveBeenCalledWith(ISSUER, 'MBWT');
  });

  it('narrows further for a manager — only assets they operate', async () => {
    const { service, managers } = make();
    await service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' });
    expect(managers.assertOperates).toHaveBeenCalledWith(ACTOR, ISSUER, {
      id: 'bandra',
      managerId: '5',
    });
  });

  it('declares NOTHING when that check refuses', async () => {
    const { service, repo, managers } = make();
    vi.mocked(managers.assertOperates).mockRejectedValueOnce(
      AppError.forbidden('You do not manage this property.'),
    );
    await expect(
      service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.declare).not.toHaveBeenCalled();
  });

  it('treats a token with no offering as manager-operated by nobody', async () => {
    const { service, managers } = make({ offering: undefined });
    await service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' });
    /* managerId null means a 'manager' principal is refused and an
       issuer_admin is unaffected — the safe direction. */
    expect(vi.mocked(managers.assertOperates).mock.calls[0][2].managerId).toBeNull();
  });
});

describe('amount and cap table', () => {
  it('refuses a zero amount', async () => {
    const { service, repo } = make();
    await expect(service.declare(ACTOR, ISSUER, 'MBWT', { amount: '0' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(repo.declare).not.toHaveBeenCalled();
  });

  it('refuses an asset with NO holders', async () => {
    const { service, repo } = make({ holders: [] });
    /* A payout with no claimants is money declared and owed to nobody. */
    await expect(service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' })).rejects.toMatchObject({
      code: 'NO_HOLDERS',
    });
    expect(repo.declare).not.toHaveBeenCalled();
  });

  it('refuses when every holder balance is zero', async () => {
    const { service } = make({ holders: [{ address: '0xa', balance: '0' }] });
    await expect(service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' })).rejects.toMatchObject({
      code: 'NO_HOLDERS',
    });
  });
});

describe('the allocation', () => {
  it('sums to the declared total EXACTLY, in paise', async () => {
    const { service, repo } = make();
    await service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' });
    const allocation = vi.mocked(repo.declare).mock.calls[0][2];
    const paise = allocation.reduce((s, a) => s + Math.round(a.amount * 100), 0);
    /* 50/190/60 of 1000 does not divide evenly. Independent rounding would
       leave the issuer short or over on every payout — a reconciliation
       problem forever after. */
    expect(paise).toBe(100_000);
  });

  it('weights strictly by balance', async () => {
    const { service, repo } = make();
    await service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' });
    const byWallet = Object.fromEntries(
      vi.mocked(repo.declare).mock.calls[0][2].map((a) => [a.wallet, a.amount]),
    );
    expect(byWallet['0xb']).toBeGreaterThan(byWallet['0xc']);
    expect(byWallet['0xc']).toBeGreaterThan(byWallet['0xa']);
  });

  it('allocates one row per holder — a SNAPSHOT of the cap table', async () => {
    const { service, repo } = make();
    await service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' });
    /* Selling afterwards must not change what you were owed for the period
       covered, which is why the shares are written now and not computed later. */
    expect(vi.mocked(repo.declare).mock.calls[0][2]).toHaveLength(3);
  });

  it('records the holder count in the audit trail', async () => {
    const { service, audit } = make();
    await service.declare(ACTOR, ISSUER, 'MBWT', { amount: '1000' });
    expect(vi.mocked(audit.record).mock.calls[0][2]).toMatchObject({
      params: expect.objectContaining({ holders: 3, totalAmount: '1000' }),
    });
  });
});

describe('claiming', () => {
  const claim = (over = {}) => ({
    id: '1',
    amount: '200',
    status: 'claimable',
    claimedAt: null,
    tokenSymbol: 'MBWT',
    currency: 'INR',
    note: null,
    declaredAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  it('sums across EVERY wallet the person has linked', async () => {
    const { service, repo, onboarding } = make({ wallets: ['0xa', '0xb'] });
    await service.forInvestor('0xA');
    /* One person is owed the total, however many addresses they held it
       across — reading only the connected wallet under-pays them. */
    expect(onboarding.walletsForPerson).toHaveBeenCalled();
    expect(vi.mocked(repo.claimsForWallets).mock.calls[0][1]).toEqual(['0xa', '0xb']);
  });

  it('totals only the CLAIMABLE rows, not the already-claimed', async () => {
    const { service } = make({
      claims: [claim(), claim({ id: '2', amount: '500', status: 'claimed' })],
    });
    const res = await service.forInvestor('0xA');
    expect(res.claimableTotal).toBe(200);
    /* History still shows both — an investor needs to see what they were paid. */
    expect(res.items).toHaveLength(2);
  });

  it('refuses when there is nothing claimable', async () => {
    const { service } = make({ claimed: { count: 0, total: 0 } });
    await expect(service.claim(ACTOR, '0xA')).rejects.toMatchObject({
      code: 'NOTHING_TO_CLAIM',
    });
  });

  it('does not write an audit row for an empty claim', async () => {
    const { service, audit } = make({ claimed: { count: 0, total: 0 } });
    await expect(service.claim(ACTOR, '0xA')).rejects.toBeTruthy();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns what was actually collected, from the UPDATE itself', async () => {
    const { service } = make({ claimed: { count: 2, total: 733.33 } });
    /* The count comes from RETURNING on the conditional UPDATE, so a concurrent
       claim that already took the rows yields 0 here rather than paying twice. */
    await expect(service.claim(ACTOR, '0xA')).resolves.toMatchObject({
      claims: 2,
      total: 733.33,
    });
  });

  it('claims against the PRIMARY wallet identity', async () => {
    const { service, onboarding } = make();
    await service.claim(ACTOR, '0xABC');
    expect(onboarding.resolvePrimaryWallet).toHaveBeenCalledWith('0xABC');
  });
});
