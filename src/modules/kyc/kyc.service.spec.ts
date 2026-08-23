/**
 * KYC decision rules.
 *
 * The kyc_version behaviour is the subtle part: it is the pivot the whole
 * reliance model turns on (TENANCY_MODEL.md §5.3). Bump it when you should not,
 * and every issuer's acceptance goes stale for no reason; fail to bump it when
 * you should, and issuers keep relying on a verification that has been redone.
 */
import { describe, expect, it, vi } from 'vitest';
import { KycService } from './kyc.service';
import type { KycRepository } from './kyc.repository';
import type { AuditService } from '@shared/audit/audit.service';
import type { Account } from '@shared/db/schema';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const D = new Date('2026-01-01T00:00:00Z');

/** The subject of KYC is the PERSON (accounts), not a wallet — migration 045. */
const person = (over: Partial<Account> = {}): Account =>
  ({
    id: '7',
    email: 'a@b.c',
    passwordHash: 'x',
    name: 'Applicant',
    emailVerified: true,
    kycStatus: 'applied',
    kycNote: null,
    kycSubmittedAt: D,
    kycRejectedAt: null,
    kycVersion: '1',
    country: 356,
    createdAt: D,
    updatedAt: D,
    ...over,
  }) as Account;

function make(first?: Account, after?: Account) {
  const seq = [first, after ?? first];
  let call = 0;
  const repo = {
    resolveSubject: vi.fn(async () => seq[0]),
    getByAccountId: vi.fn(async () => seq[Math.min(++call, seq.length - 1)]),
    listPending: vi.fn(async () => [person()]),
    walletCount: vi.fn(async () => 0),
    setDecision: vi.fn(async () => undefined),
  } as unknown as KycRepository;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return { service: new KycService(repo, audit), repo, audit };
}

const ADMIN: Principal = { kind: 'admin', id: '1', email: 'p@x.io', role: 'platform_admin' };
const PLATFORM: TenantContext = { kind: 'platform' };

describe('approve', () => {
  it('sets completed and BUMPS kyc_version', async () => {
    const { service, repo } = make(person(), person({ kycStatus: 'completed', kycVersion: '2' }));
    const res = await service.decide(ADMIN, PLATFORM, '0xABC', true);
    expect(res.kycStatus).toBe('completed');
    /* bumpVersion = true — a fresh verification supersedes prior reliance. */
    expect(vi.mocked(repo.setDecision).mock.calls[0]).toEqual(['7', 'completed', null, true]);
    expect(res.kycVersion).toBe('2');
  });

  it('is idempotent — re-approving does NOT bump the version', async () => {
    const already = person({ kycStatus: 'completed', kycVersion: '3' });
    const { service, repo } = make(already);
    const res = await service.decide(ADMIN, PLATFORM, '0xabc', true);
    /* Bumping here would mark every issuer's acceptance stale for nothing. */
    expect(repo.setDecision).not.toHaveBeenCalled();
    expect(res.kycVersion).toBe('3');
  });

  it('audits the transition with from/to', async () => {
    const { service, audit } = make(person(), person({ kycStatus: 'completed', kycVersion: '2' }));
    await service.decide(ADMIN, PLATFORM, '0xabc', true, 'docs verified');
    expect(vi.mocked(audit.record).mock.calls[0][2]).toMatchObject({
      action: 'kyc.approve',
      target: '7',
      params: { from: 'applied', to: 'completed', note: 'docs verified' },
    });
  });
});

describe('reject', () => {
  it('sets rejected WITHOUT bumping the version', async () => {
    const { service, repo } = make(person(), person({ kycStatus: 'rejected' }));
    await service.decide(ADMIN, PLATFORM, '0xabc', false, 'blurry document');
    /* No new verification happened, so nothing an issuer relied on changed. */
    expect(vi.mocked(repo.setDecision).mock.calls[0]).toEqual([
      '7',
      'rejected',
      'blurry document',
      false,
    ]);
  });

  it('audits as kyc.reject', async () => {
    const { service, audit } = make(person(), person({ kycStatus: 'rejected' }));
    await service.decide(ADMIN, PLATFORM, '0xabc', false, 'mismatch');
    expect(vi.mocked(audit.record).mock.calls[0][2]).toMatchObject({ action: 'kyc.reject' });
  });
});

describe('guards against attesting to nothing', () => {
  it('404s a subject that never submitted', async () => {
    const { service, repo } = make(undefined);
    /* The Express version created a row here. Approving a non-existent
       submission means attesting to documents that do not exist. */
    await expect(service.decide(ADMIN, PLATFORM, '0xnope', true)).rejects.toMatchObject({
      status: 404,
    });
    expect(repo.setDecision).not.toHaveBeenCalled();
  });
});

describe('startVerifying', () => {
  it("moves 'applied' to 'verifying'", async () => {
    const { service, repo } = make(person({ kycStatus: 'applied' }));
    const res = await service.startVerifying(ADMIN, PLATFORM, '0xabc');
    expect(res.kycStatus).toBe('verifying');
    expect(vi.mocked(repo.setDecision).mock.calls[0][3]).toBe(false);
  });

  it('refuses when KYC is not awaiting review', async () => {
    const { service } = make(person({ kycStatus: 'completed' }));
    await expect(service.startVerifying(ADMIN, PLATFORM, '0xabc')).rejects.toMatchObject({
      code: 'KYC_NOT_AWAITING_REVIEW',
      status: 409,
    });
  });
});

describe('review queue', () => {
  it('audits the read — the queue exposes PII', async () => {
    const { service, audit } = make(person());
    const res = await service.pending(ADMIN, PLATFORM);
    expect(res.items).toHaveLength(1);
    expect(vi.mocked(audit.record).mock.calls[0][2]).toMatchObject({ action: 'kyc.queue_read' });
  });
});
