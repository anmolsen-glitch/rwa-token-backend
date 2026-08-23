/**
 * Investor PII rules. These encode compliance obligations, not preferences:
 *   §5.2 — every issuer-side PII read is audited;
 *   §5.3 — an acceptance resting on a superseded KYC must show as stale;
 *   §4.3 — acceptance is a decision about a PERSON (accounts.id), not a wallet.
 */
import { describe, expect, it, vi } from 'vitest';
import { InvestorsService } from './investors.service';
import type { InvestorsRepository } from './investors.repository';
import type { AuditService } from '@shared/audit/audit.service';
import type { Investor, Acceptance } from '@shared/db/schema';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';

const D = new Date('2026-01-01T00:00:00Z');

const investor = (over: Partial<Investor> = {}): Investor =>
  ({
    wallet: '0xabc',
    accountId: '7',
    onchainid: null,
    country: 356,
    name: 'Real Person',
    email: 'person@example.com',
    kycStatus: 'completed',
    kycNote: null,
    kycProvider: null,
    kycRef: null,
    kycDetails: {},
    kycSubmittedAt: D,
    kycRejectedAt: null,
    kycVersion: '1',
    verified: true,
    createdAt: D,
    updatedAt: D,
    ...over,
  }) as Investor;

const acceptance = (over: Partial<Acceptance> = {}): Acceptance =>
  ({
    issuerId: '2',
    investorId: '7',
    status: 'accepted',
    kycVersion: '1',
    decidedBy: '4',
    decidedAt: D,
    note: null,
    ...over,
  }) as Acceptance;

function make(
  opts: {
    investor?: Investor | undefined;
    acceptance?: Acceptance;
    /** The PERSON's current KYC version (accounts.kyc_version, migration 045). */
    personKycVersion?: string;
  } = {},
) {
  const repo = {
    list: vi.fn(async () => [investor()]),
    findByWallet: vi.fn(async () => ('investor' in opts ? opts.investor : investor())),
    subscriptionsFor: vi.fn(async () => []),
    acceptanceFor: vi.fn(async () => opts.acceptance),
    accountKycVersion: vi.fn(async () => opts.personKycVersion ?? '1'),
    upsertAcceptance: vi.fn(async (_t: unknown, r: { status: string; kycVersion: string }) =>
      acceptance({ status: r.status, kycVersion: r.kycVersion }),
    ),
  } as unknown as InvestorsRepository;

  const audit = {
    record: vi.fn(async () => undefined),
    recordPiiAccess: vi.fn(async () => undefined),
  } as unknown as AuditService;

  return { service: new InvestorsService(repo, audit), repo, audit };
}

const ISSUER: TenantContext = { kind: 'issuer', issuerId: '2' };
const PLATFORM: TenantContext = { kind: 'platform' };
const SELF: TenantContext = { kind: 'investor', investorWallet: '0xabc' };
const ADMIN: Principal = { kind: 'admin', id: '4', email: 'c@x.io', role: 'compliance' };

describe('PII access is audited', () => {
  it('writes an audit row when an issuer reads investor detail', async () => {
    const { service, audit } = make();
    await service.detail(ADMIN, ISSUER, '0xabc');
    expect(audit.recordPiiAccess).toHaveBeenCalledOnce();
    expect(vi.mocked(audit.recordPiiAccess).mock.calls[0][2]).toBe('0xabc');
  });

  it('audits platform reads too — that role crosses tenants by design', async () => {
    const { service, audit } = make();
    await service.detail(ADMIN, PLATFORM, '0xabc');
    expect(audit.recordPiiAccess).toHaveBeenCalledOnce();
  });

  it('does NOT audit an investor reading their own record', async () => {
    const { service, audit } = make();
    const self: Principal = { kind: 'investor', id: '0xabc', wallet: '0xabc' };
    await service.detail(self, SELF, '0xabc');
    /* Auditing self-reads would bury the entries that actually matter. */
    expect(audit.recordPiiAccess).not.toHaveBeenCalled();
  });

  it('list() returns no PII, so it does not audit', async () => {
    const { service, audit } = make();
    const res = await service.list(ISSUER);
    expect(audit.recordPiiAccess).not.toHaveBeenCalled();
    expect(res.items[0]).not.toHaveProperty('name');
    expect(res.items[0]).not.toHaveProperty('email');
  });

  it('404s a wallet the caller cannot see, without auditing a non-access', async () => {
    const { service, audit } = make({ investor: undefined });
    await expect(service.detail(ADMIN, ISSUER, '0xzzz')).rejects.toMatchObject({ status: 404 });
    expect(audit.recordPiiAccess).not.toHaveBeenCalled();
  });
});

describe('acceptance decisions', () => {
  it('records the decision against the issuer from the TOKEN, not the request', async () => {
    const { service, repo } = make();
    await service.decideAcceptance(ADMIN, ISSUER, '0xabc', 'accepted');
    expect(vi.mocked(repo.upsertAcceptance).mock.calls[0][1]).toMatchObject({
      issuerId: '2',
      investorId: '7',
      decidedBy: '4',
    });
  });

  it('pins the PERSON\'s kyc_version, not the wallet row\'s', async () => {
    /* The wallet row says 9; the person says 3. Acceptance is keyed on
       accounts.id, so pinning the wallet's version would compare two different
       subjects when staleness is evaluated (migration 045). */
    const { service, repo } = make({
      investor: investor({ kycVersion: '9' }),
      personKycVersion: '3',
    });
    await service.decideAcceptance(ADMIN, ISSUER, '0xabc', 'accepted');
    expect(vi.mocked(repo.upsertAcceptance).mock.calls[0][1].kycVersion).toBe('3');
  });

  it('refuses a wallet with no linked account — acceptance is about a person', async () => {
    const { service } = make({ investor: investor({ accountId: null }) });
    await expect(service.decideAcceptance(ADMIN, ISSUER, '0xabc', 'accepted')).rejects.toMatchObject({
      code: 'INVESTOR_HAS_NO_ACCOUNT',
    });
  });

  it('refuses a platform caller — acceptance belongs to an issuer', async () => {
    const { service } = make();
    await expect(
      service.decideAcceptance(ADMIN, PLATFORM, '0xabc', 'accepted'),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('audits the decision', async () => {
    const { service, audit } = make();
    await service.decideAcceptance(ADMIN, ISSUER, '0xabc', 'rejected', 'sanctions concern');
    expect(vi.mocked(audit.record).mock.calls[0][2]).toMatchObject({
      action: 'investor.acceptance_decided',
      target: '0xabc',
    });
  });
});

describe('acceptance staleness (§5.3)', () => {
  it('is fresh when the relied-upon version matches the person\'s', async () => {
    const { service } = make({
      acceptance: acceptance({ kycVersion: '1' }),
      personKycVersion: '1',
    });
    const res = await service.detail(ADMIN, ISSUER, '0xabc');
    expect(res.acceptance?.stale).toBe(false);
  });

  it('is STALE when the PERSON\'s KYC has been re-run since the decision', async () => {
    const { service } = make({
      acceptance: acceptance({ kycVersion: '2' }),
      personKycVersion: '4',
    });
    const res = await service.detail(ADMIN, ISSUER, '0xabc');
    /* The issuer's reliance rests on a verification that no longer stands. */
    expect(res.acceptance?.stale).toBe(true);
  });

  it('ignores the wallet row\'s version entirely', async () => {
    /* Wallet says 7 (stale-looking) but the person is still at 2, matching the
       acceptance — so this must read as FRESH. */
    const { service } = make({
      investor: investor({ kycVersion: '7' }),
      acceptance: acceptance({ kycVersion: '2' }),
      personKycVersion: '2',
    });
    const res = await service.detail(ADMIN, ISSUER, '0xabc');
    expect(res.acceptance?.stale).toBe(false);
  });

  it('omits acceptance entirely for a platform caller', async () => {
    const { service } = make({ acceptance: acceptance() });
    const res = await service.detail(ADMIN, PLATFORM, '0xabc');
    expect(res.acceptance).toBeNull();
  });
});
