/**
 * Team-management rules.
 *
 * Two failure modes this module has to be judged against: PRIVILEGE ESCALATION
 * (a tenant minting a superuser, or reaching another issuer's staff) and
 * LOCKOUT (an issuer removing its own last way in, which needs the platform
 * operator to undo).
 */
import { describe, expect, it, vi } from 'vitest';
import { TeamService } from './team.service';
import type { TeamRepository, TeamRow } from './team.repository';
import type { AuditService } from '@shared/audit/audit.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const ISSUER_2: TenantContext = { kind: 'issuer', issuerId: '2' };
const PLATFORM: TenantContext = { kind: 'platform' };
const INVESTOR: TenantContext = { kind: 'investor', investorWallet: '0xaaa' };

const actor = (id: string): Principal =>
  ({ kind: 'admin', id, email: 'me@x.io', role: 'issuer_admin' }) as Principal;

const member = (over: Partial<TeamRow> = {}): TeamRow =>
  ({
    id: '20',
    email: 'colleague@x.io',
    passwordHash: '$2a$12$notarealhash',
    name: 'Colleague',
    role: 'compliance',
    issuerId: '2',
    disabled: false,
    managerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }) as TeamRow;

function make(opts: { row?: TeamRow | undefined; others?: number; taken?: boolean } = {}) {
  const repo = {
    list: vi.fn(async () => [member()]),
    findById: vi.fn(async () => ('row' in opts ? opts.row : member())),
    emailTaken: vi.fn(async () => opts.taken ?? false),
    create: vi.fn(async (_t, issuerId: string, input: Record<string, unknown>) =>
      member({ issuerId, email: input.email as string, role: input.role as string }),
    ),
    update: vi.fn(async (_t, _id, fields: Record<string, unknown>) => member(fields)),
    countOtherActiveIssuerAdmins: vi.fn(async () => opts.others ?? 1),
  } as unknown as TeamRepository;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return { service: new TeamService(repo, audit), repo, audit };
}

describe('privilege escalation', () => {
  it('REFUSES an issuer creating a platform_admin', async () => {
    const { service, repo } = make();
    /* A tenant minting a superuser is the escalation this module exists to
       prevent. Migration 054 refuses it in the database too. */
    await expect(
      service.create(actor('1'), ISSUER_2, {
        email: 'super@evil.io',
        password: 'a-long-enough-pw',
        role: 'platform_admin',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses PROMOTING a colleague to platform_admin', async () => {
    const { service, repo } = make();
    await expect(
      service.update(actor('1'), ISSUER_2, '20', { role: 'platform_admin' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("refuses creating a bare 'manager' login", async () => {
    const { service } = make();
    /* A manager login with no profile resolves managerId to undefined, and
       every manager route then refuses it — an account that exists and works
       nowhere. Managers are created with their profile. */
    await expect(
      service.create(actor('1'), ISSUER_2, {
        email: 'm@x.io',
        password: 'a-long-enough-pw',
        role: 'manager',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('takes the issuer from the TENANT, never the body', async () => {
    const { service, repo } = make();
    await service.create(actor('1'), ISSUER_2, {
      email: 'x@y.io',
      password: 'a-long-enough-pw',
      role: 'agent',
      issuerId: '5',
    } as never);
    expect(vi.mocked(repo.create).mock.calls[0][1]).toBe('2');
  });

  it('refuses an investor entirely', async () => {
    const { service } = make();
    await expect(service.list(INVESTOR)).rejects.toMatchObject({ status: 403 });
  });

  it("404s another issuer's staff rather than 403", async () => {
    const { service } = make({ row: undefined });
    /* RLS hid the row; confirming it exists would disclose a competitor's
       headcount. */
    await expect(service.update(actor('1'), ISSUER_2, '99', { disabled: true })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('lockout guardrails', () => {
  it('refuses disabling your OWN account', async () => {
    const { service, repo } = make({ row: member({ id: '1', role: 'issuer_admin' }) });
    await expect(service.update(actor('1'), ISSUER_2, '1', { disabled: true })).rejects.toMatchObject({
      code: 'SELF_LOCKOUT',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('refuses demoting yourself out of issuer_admin', async () => {
    const { service } = make({ row: member({ id: '1', role: 'issuer_admin' }) });
    await expect(service.update(actor('1'), ISSUER_2, '1', { role: 'agent' })).rejects.toMatchObject({
      code: 'SELF_LOCKOUT',
    });
  });

  it('allows editing your own account in harmless ways', async () => {
    const { service } = make({ row: member({ id: '1', role: 'issuer_admin' }) });
    /* Re-ENABLING yourself, or a role change that keeps issuer_admin, locks
       nobody out — the guard is about losing access, not about self-edits. */
    await expect(
      service.update(actor('1'), ISSUER_2, '1', { disabled: false }),
    ).resolves.toBeTruthy();
  });

  it('refuses disabling the LAST active issuer_admin', async () => {
    const { service, repo } = make({ row: member({ role: 'issuer_admin' }), others: 0 });
    await expect(service.update(actor('1'), PLATFORM, '20', { disabled: true })).rejects.toMatchObject({
      code: 'LAST_ISSUER_ADMIN',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('refuses DEMOTING the last active issuer_admin — same lockout', async () => {
    const { service } = make({ row: member({ role: 'issuer_admin' }), others: 0 });
    await expect(service.update(actor('1'), PLATFORM, '20', { role: 'agent' })).rejects.toMatchObject({
      code: 'LAST_ISSUER_ADMIN',
    });
  });

  it('counts within the TARGET issuer, not the caller scope', async () => {
    const { service, repo } = make({ row: member({ issuerId: '5', role: 'issuer_admin' }), others: 0 });
    await expect(
      service.update(actor('1'), PLATFORM, '20', { disabled: true }),
    ).rejects.toBeTruthy();
    /* A platform caller sees every issuer, so an unscoped count would tally
       unrelated companies and conclude the tenant is fine. */
    expect(repo.countOtherActiveIssuerAdmins).toHaveBeenCalledWith(PLATFORM, '5', '20');
  });

  it('allows it once another active issuer_admin exists', async () => {
    const { service } = make({ row: member({ role: 'issuer_admin' }), others: 1 });
    await expect(
      service.update(actor('1'), PLATFORM, '20', { disabled: true }),
    ).resolves.toBeTruthy();
  });

  it('does not re-check when the target is ALREADY disabled', async () => {
    const { service, repo } = make({ row: member({ role: 'issuer_admin', disabled: true }), others: 0 });
    /* Re-disabling an already-disabled account removes no access, so the guard
       must not block an idempotent call. */
    await expect(
      service.update(actor('1'), PLATFORM, '20', { disabled: true }),
    ).resolves.toBeTruthy();
    expect(repo.countOtherActiveIssuerAdmins).not.toHaveBeenCalled();
  });
});

describe('the platform operator', () => {
  it('may edit staff — it is the recovery path the guard assumes', async () => {
    const { service } = make();
    await expect(service.update(actor('1'), PLATFORM, '20', { disabled: true })).resolves.toBeTruthy();
  });

  it('may NOT create staff — it has no issuer to attach them to', async () => {
    const { service } = make();
    await expect(
      service.create(actor('1'), PLATFORM, {
        email: 'x@y.io',
        password: 'a-long-enough-pw',
        role: 'agent',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("a manager's login is owned by their profile", () => {
  it('refuses editing it from here', async () => {
    const { service, repo } = make({ row: member({ managerId: '7' }) });
    /* Suspending the manager is what disables it. Two edit paths would give
       one account two sources of truth for whether it works. */
    await expect(service.update(actor('1'), ISSUER_2, '20', { disabled: true })).rejects.toMatchObject({
      code: 'MANAGED_ELSEWHERE',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('still LISTS it, so the roster is complete', async () => {
    const { service, repo } = make();
    vi.mocked(repo.list).mockResolvedValueOnce([member({ managerId: '7' })]);
    const res = await service.list(ISSUER_2);
    expect(res.items[0].managerId).toBe('7');
  });
});

describe('what leaves the service', () => {
  it('never returns the password hash', async () => {
    const { service } = make();
    const res = await service.list(ISSUER_2);
    expect(res.items[0]).not.toHaveProperty('passwordHash');
  });

  it('never writes the password to the audit trail', async () => {
    const { service, audit } = make();
    await service.create(actor('1'), ISSUER_2, {
      email: 'x@y.io',
      password: 'a-long-enough-pw',
      role: 'agent',
    });
    const params = JSON.stringify(vi.mocked(audit.record).mock.calls[0][2]);
    expect(params).not.toContain('a-long-enough-pw');
    /* The ROLE is the security-relevant fact and must be there. */
    expect(params).toContain('agent');
  });

  it('rejects a duplicate email before hashing anything', async () => {
    const { service, repo } = make({ taken: true });
    await expect(
      service.create(actor('1'), ISSUER_2, {
        email: 'taken@x.io',
        password: 'a-long-enough-pw',
        role: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('lowercases the email — an identity, not a password', async () => {
    const { service, repo } = make();
    await service.create(actor('1'), ISSUER_2, {
      email: '  Ops@Savills.IO ',
      password: 'a-long-enough-pw',
      role: 'agent',
    });
    expect(vi.mocked(repo.create).mock.calls[0][2].email).toBe('ops@savills.io');
  });
});
