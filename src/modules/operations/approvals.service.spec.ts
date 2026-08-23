/**
 * Maker-checker rules.
 *
 * These are the guards on the most dangerous writes in the system. Every test
 * here corresponds to a way someone could move investors' tokens without a
 * genuine second signature.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApprovalsService } from './approvals.service';
import type { OperationsRepository } from './operations.repository';
import type { TokensRepository } from '@modules/tokens/tokens.repository';
import type { TokenOperationsService } from '@modules/tokens/token-operations.service';
import type { ChainService } from '@shared/chain/chain.service';
import type { AppConfig } from '@shared/config/app-config.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { OperationRequest } from '@shared/db/schema';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const D = new Date('2026-01-01T00:00:00Z');
const ISSUER: TenantContext = { kind: 'issuer', issuerId: '2' };

const admin = (id: string, role: string): Principal =>
  ({ kind: 'admin', id, email: `${id}@x.io`, role }) as Principal;

const request = (over: Partial<OperationRequest> = {}): OperationRequest =>
  ({
    id: '10',
    action: 'mint',
    tokenSymbol: 'DVVRE',
    params: { investor: '0xabc', amount: '5' },
    requiredRole: 'agent',
    approvalsRequired: 1,
    status: 'pending',
    requestedBy: '2',
    requestedByEmail: 'a@x.io',
    txHash: null,
    error: null,
    decidedNote: null,
    caseId: null,
    createdAt: D,
    updatedAt: D,
    ...over,
  }) as OperationRequest;

function make(opts: { req?: OperationRequest; threshold?: number; approvals?: number; claim?: boolean } = {}) {
  const repo = {
    create: vi.fn(async () => request()),
    byId: vi.fn(async () => opts.req),
    list: vi.fn(async () => []),
    addApproval: vi.fn(async () => true),
    countApprovals: vi.fn(async () => opts.approvals ?? 1),
    listApprovals: vi.fn(async () => []),
    claimForExecution: vi.fn(async () => opts.claim ?? true),
    setOutcome: vi.fn(async () => undefined),
  } as unknown as OperationsRepository;

  const tokensRepo = { require: vi.fn(async () => ({ symbol: 'DVVRE', address: '0xtok', issuerId: '2' })) } as unknown as TokensRepository;
  const ops = {
    mint: vi.fn(async () => ({ ok: true, action: 'mint', tx: { hash: '0xdead' } })),
    burn: vi.fn(async () => ({ ok: true })),
    forcedTransfer: vi.fn(async () => ({ ok: true })),
    setPaused: vi.fn(async () => ({ ok: true })),
  } as unknown as TokenOperationsService;
  const chain = {
    token: () => ({ identityRegistry: async () => '0xir' }),
    identityRegistry: () => ({ isVerified: async () => true }),
  } as unknown as ChainService;
  const config = {
    get: () => opts.threshold ?? 1,
    approvalThresholds: { 'force-transfer': 2 },
  } as unknown as AppConfig;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;

  return { service: new ApprovalsService(repo, tokensRepo, ops, chain, config, audit), repo, ops, tokensRepo };
}

describe('submit', () => {
  it('queues instead of executing when a threshold is set', async () => {
    const { service, ops } = make({ threshold: 1 });
    const res = await service.submit(admin('2', 'agent'), ISSUER, 'mint', 'DVVRE', { investor: '0xa', amount: '1' });
    expect(res.status).toBe('pending');
    expect(ops.mint).not.toHaveBeenCalled();
  });

  it('executes immediately when the threshold is 0', async () => {
    const { service, ops } = make({ threshold: 0 });
    const res = await service.submit(admin('2', 'agent'), ISSUER, 'mint', 'DVVRE', { investor: '0xa', amount: '1' });
    expect(res.status).toBe('executed');
    expect(ops.mint).toHaveBeenCalled();
  });

  it('resolves the token FIRST — that is the tenant check', async () => {
    const { service, tokensRepo } = make();
    await service.submit(admin('2', 'agent'), ISSUER, 'mint', 'DVVRE', { investor: '0xa', amount: '1' });
    /* A symbol belonging to another issuer must 404 here rather than entering
       their approval queue. */
    expect(tokensRepo.require).toHaveBeenCalledWith(ISSUER, 'DVVRE');
  });

  it('refuses an actor without the required role', async () => {
    const { service } = make();
    await expect(
      service.submit(admin('4', 'compliance'), ISSUER, 'mint', 'DVVRE', { investor: '0xa', amount: '1' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects an unknown action', async () => {
    const { service } = make();
    await expect(
      service.submit(admin('2', 'agent'), ISSUER, 'teleport', 'DVVRE', {}),
    ).rejects.toMatchObject({ code: 'NOT_APPROVABLE' });
  });
});

describe('approve — four-eyes', () => {
  it('REFUSES the requester approving their own request', async () => {
    const { service, repo } = make({ req: request({ requestedBy: '2' }) });
    await expect(service.approve(admin('2', 'agent'), ISSUER, '10')).rejects.toMatchObject({
      status: 403,
    });
    /* The whole point: no approval is recorded either. */
    expect(repo.addApproval).not.toHaveBeenCalled();
  });

  it('refuses an approver without the required role', async () => {
    const { service } = make({ req: request({ requiredRole: 'agent' }) });
    await expect(service.approve(admin('4', 'compliance'), ISSUER, '10')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('refuses a second approval from the same admin', async () => {
    const { service, repo } = make({ req: request() });
    vi.mocked(repo.addApproval).mockResolvedValueOnce(false);
    await expect(service.approve(admin('9', 'agent'), ISSUER, '10')).rejects.toMatchObject({
      code: 'ALREADY_APPROVED',
    });
  });

  it('stays pending until the threshold is met', async () => {
    const { service, ops } = make({ req: request({ approvalsRequired: 2 }), approvals: 1 });
    const res = await service.approve(admin('9', 'agent'), ISSUER, '10');
    expect(res.status).toBe('pending');
    expect(ops.mint).not.toHaveBeenCalled();
  });

  it('executes once the threshold is met', async () => {
    const { service, ops, repo } = make({ req: request({ approvalsRequired: 1 }), approvals: 1 });
    const res = await service.approve(admin('9', 'agent'), ISSUER, '10');
    expect(res.status).toBe('executed');
    expect(ops.mint).toHaveBeenCalled();
    expect(vi.mocked(repo.setOutcome).mock.calls[0][2]).toBe('executed');
  });

  it('does NOT execute when it loses the atomic claim', async () => {
    /* Concurrent approvals both see "threshold met"; only the one that wins the
       claim may run the chain write. Otherwise: double mint. */
    const { service, ops } = make({ req: request(), approvals: 1, claim: false });
    const res = await service.approve(admin('9', 'agent'), ISSUER, '10');
    expect(ops.mint).not.toHaveBeenCalled();
    expect(res.status).not.toBe('executed');
  });

  it('records the REAL failure reason, not a generic wrapper', async () => {
    const { service, ops, repo } = make({ req: request(), approvals: 1 });
    const err = Object.assign(new Error('Mint failed.'), {
      code: 'CHAIN_CALL_FAILED',
      details: { detail: 'execution reverted: Transfer not possible' },
    });
    vi.mocked(ops.mint).mockRejectedValueOnce(err);

    await expect(service.approve(admin('9', 'agent'), ISSUER, '10')).rejects.toBeTruthy();
    const [, , status, extra] = vi.mocked(repo.setOutcome).mock.calls[0];
    expect(status).toBe('failed');
    /* A queue full of "mint failed" with no detail is unusable to whoever retries. */
    expect(extra?.error).toContain('Transfer not possible');
  });

  it('refuses a request that is no longer pending', async () => {
    const { service } = make({ req: request({ status: 'executed' }) });
    await expect(service.approve(admin('9', 'agent'), ISSUER, '10')).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });
  });

  it('404s a request the caller cannot see (another tenant)', async () => {
    const { service } = make({ req: undefined });
    await expect(service.approve(admin('9', 'agent'), ISSUER, '10')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('reject', () => {
  it('lets the requester cancel their own request', async () => {
    const { service } = make({ req: request({ requestedBy: '2', requiredRole: 'agent' }) });
    /* Requester holds 'compliance' here — allowed anyway, because cancelling
       your own request needs no privilege. */
    await expect(service.reject(admin('2', 'compliance'), ISSUER, '10', 'oops')).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('refuses a stranger without the required role', async () => {
    const { service } = make({ req: request({ requestedBy: '2' }) });
    await expect(service.reject(admin('4', 'compliance'), ISSUER, '10', 'no')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('thresholds', () => {
  it('force-transfer overrides the base threshold', () => {
    const { service } = make({ threshold: 1 });
    /* The court-order power moves someone else's holdings without consent, so
       it defaults to TWO checkers rather than one. */
    expect(service.thresholdFor('force-transfer')).toBe(2);
    expect(service.thresholdFor('mint')).toBe(1);
  });
});
