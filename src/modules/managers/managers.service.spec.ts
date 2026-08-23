/**
 * Property-manager rules.
 *
 * A manager is DELEGATED AUTHORITY over specific properties, so almost every
 * test here is a way that delegation could leak — into another issuer's roster,
 * into a property the manager does not operate, or past a suspension.
 */
import { describe, expect, it, vi } from 'vitest';
import { ManagersService } from './managers.service';
import type { ManagersRepository } from './managers.repository';
import type { AuditService } from '@shared/audit/audit.service';
import type { Manager, Offering } from '@shared/db/schema';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const ISSUER: TenantContext = { kind: 'issuer', issuerId: '2' };
const PLATFORM: TenantContext = { kind: 'platform' };
const INVESTOR: TenantContext = { kind: 'investor', investorWallet: '0xaaa' };

const admin = (role: string, managerId?: string): Principal =>
  ({ kind: 'admin', id: '9', email: 'a@x.io', role, managerId }) as Principal;

const manager = (over: Partial<Manager> = {}): Manager =>
  ({
    id: '1',
    issuerId: '2',
    name: 'Acme Facilities',
    company: 'Acme Ltd',
    bio: null,
    logoUrl: null,
    contactEmail: null,
    status: 'active',
    adminId: null,
    spvManagerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }) as Manager;

const offering = (over: Partial<Offering> = {}): Offering =>
  ({
    id: 'csret',
    issuerId: '2',
    name: 'Creekside',
    status: 'open',
    visibility: 'public',
    managerId: '1',
    location: 'Dubai',
    country: 784,
    tokenSymbol: 'CSRET',
    image: null,
    ...over,
  }) as Offering;

function make(opts: { row?: Manager | undefined; offerings?: Offering[]; taken?: boolean } = {}) {
  const repo = {
    list: vi.fn(async () => [manager()]),
    findById: vi.fn(async () => ('row' in opts ? opts.row : manager())),
    findByAdminId: vi.fn(async () => manager()),
    create: vi.fn(async (_t, issuerId: string, input: Record<string, unknown>) =>
      manager({ issuerId, adminId: (input.adminId as string) ?? null }),
    ),
    update: vi.fn(async (_t, _id, fields: Record<string, unknown>) => manager(fields)),
    listOfferings: vi.fn(async () => opts.offerings ?? [offering()]),
    createLogin: vi.fn(async () => ({ id: '77' })),
    emailTaken: vi.fn(async () => opts.taken ?? false),
    setLoginDisabled: vi.fn(async () => undefined),
  } as unknown as ManagersRepository;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return { service: new ManagersService(repo, audit), repo, audit };
}

describe('tenancy', () => {
  it("404s another issuer's manager rather than 403", async () => {
    const { service } = make({ row: undefined });
    /* RLS already hid the row. 403 would confirm the id exists, which
       discloses that a competitor employs that operator. */
    await expect(service.findById(ISSUER, '99')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an investor creating a manager', async () => {
    const { service } = make();
    await expect(service.create(admin('issuer_admin'), INVESTOR, { name: 'X' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('takes the issuer from the TENANT, never the body', async () => {
    const { service, repo } = make();
    await service.create(admin('issuer_admin'), ISSUER, { name: 'X', issuerId: '5' } as never);
    expect(vi.mocked(repo.create).mock.calls[0][1]).toBe('2');
  });

  it('refuses the platform admin creating a manager without an issuer', async () => {
    const { service } = make();
    /* A manager must belong to exactly one issuer; a platform-scoped create has
       no issuer to attach it to and would violate the NOT NULL anyway. */
    await expect(service.create(admin('platform_admin'), PLATFORM, { name: 'X' })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('portal logins', () => {
  it('creates a profile with no login when no email is given', async () => {
    const { service, repo } = make();
    const res = await service.create(admin('issuer_admin'), ISSUER, { name: 'X' });
    expect(repo.createLogin).not.toHaveBeenCalled();
    expect(res.hasLogin).toBe(false);
  });

  it('creates the login under THIS issuer, never platform-wide', async () => {
    const { service, repo } = make();
    await service.create(admin('issuer_admin'), ISSUER, {
      name: 'X',
      loginEmail: 'ops@acme.io',
      loginPassword: 'a-long-enough-password',
    });
    expect(vi.mocked(repo.createLogin).mock.calls[0][1]).toBe('2');
  });

  it('rejects a short login password', async () => {
    const { service, repo } = make();
    await expect(
      service.create(admin('issuer_admin'), ISSUER, {
        name: 'X',
        loginEmail: 'ops@acme.io',
        loginPassword: 'short',
      }),
    ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an email that already has a login', async () => {
    const { service } = make({ taken: true });
    await expect(
      service.create(admin('issuer_admin'), ISSUER, {
        name: 'X',
        loginEmail: 'taken@acme.io',
        loginPassword: 'a-long-enough-password',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('never records the password in the audit trail', async () => {
    const { service, audit } = make();
    await service.create(admin('issuer_admin'), ISSUER, {
      name: 'X',
      loginEmail: 'ops@acme.io',
      loginPassword: 'a-long-enough-password',
    });
    const params = JSON.stringify(vi.mocked(audit.record).mock.calls[0][2]);
    expect(params).not.toContain('a-long-enough-password');
    expect(params).toContain('withLogin');
  });
});

describe('suspension', () => {
  it('DISABLES the portal login when a manager is suspended', async () => {
    const { service, repo } = make({ row: manager({ adminId: '77' }) });
    await service.update(admin('issuer_admin'), ISSUER, '1', { status: 'suspended' });
    /* Without this a suspended manager keeps posting updates and declaring
       distributions — "suspended" would be a label, not a control. */
    expect(repo.setLoginDisabled).toHaveBeenCalledWith(ISSUER, '77', true);
  });

  it('re-enables the login on reactivation', async () => {
    const { service, repo } = make({ row: manager({ adminId: '77' }) });
    await service.update(admin('issuer_admin'), ISSUER, '1', { status: 'active' });
    expect(repo.setLoginDisabled).toHaveBeenCalledWith(ISSUER, '77', false);
  });

  it('does not touch logins on an ordinary profile edit', async () => {
    const { service, repo } = make({ row: manager({ adminId: '77' }) });
    await service.update(admin('issuer_admin'), ISSUER, '1', { company: 'Renamed' });
    expect(repo.setLoginDisabled).not.toHaveBeenCalled();
  });

  it("404s an update to another issuer's manager", async () => {
    const { service, repo } = make({ row: undefined });
    await expect(
      service.update(admin('issuer_admin'), ISSUER, '99', { company: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe('public profile', () => {
  it('404s a SUSPENDED manager', async () => {
    const { service } = make({ row: manager({ status: 'suspended' }) });
    /* The profile is marketing surface; showing a suspended operator next to
       live assets misrepresents who is running them. */
    await expect(service.publicProfile('1')).rejects.toMatchObject({ status: 404 });
  });

  it('lists only publicly-visible properties', async () => {
    const { service } = make({
      offerings: [offering({ id: 'a' }), offering({ id: 'b', visibility: 'private' })],
    });
    const res = await service.publicProfile('1');
    expect(res.properties).toHaveLength(1);
  });

  it('never exposes the login email or whether it is disabled', async () => {
    const { service } = make({ row: manager({ adminId: '77', contactEmail: 'ops@acme.io' }) });
    const res = await service.publicProfile('1');
    /* contactEmail is a published business contact; the LOGIN identity is not,
       and `hasLogin` is the only signal that one exists. */
    expect(res).toMatchObject({ hasLogin: true, contactEmail: 'ops@acme.io' });
    expect(res).not.toHaveProperty('adminId');
  });
});

describe('the manager portal', () => {
  it('refuses a manager login with no linked profile', async () => {
    const { service } = make();
    /* Falling through to "no filter" here would show them every property. */
    await expect(service.myProperties(admin('manager'), ISSUER)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('lists only the properties assigned to that manager', async () => {
    const { service, repo } = make();
    await service.myProperties(admin('manager', '1'), ISSUER);
    expect(repo.listOfferings).toHaveBeenCalledWith(ISSUER, '1');
  });
});

describe('assertOperates', () => {
  it('lets an issuer_admin act on any of its own properties', async () => {
    const { service, repo } = make();
    await expect(
      service.assertOperates(admin('issuer_admin'), ISSUER, { id: 'csret', managerId: '1' }),
    ).resolves.toBeUndefined();
    /* The tenant check already ran; no manager lookup is needed. */
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('lets a manager act on a property they operate', async () => {
    const { service } = make();
    await expect(
      service.assertOperates(admin('manager', '1'), ISSUER, { id: 'csret', managerId: '1' }),
    ).resolves.toBeUndefined();
  });

  it("refuses a manager acting on a SIBLING property of the same issuer", async () => {
    const { service } = make();
    /* The tenant check passes — it is their issuer's asset — so this is the
       only thing standing between one manager and another's property. */
    await expect(
      service.assertOperates(admin('manager', '1'), ISSUER, { id: 'other', managerId: '2' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a SUSPENDED manager whose login is still live', async () => {
    const { service } = make({ row: manager({ status: 'suspended' }) });
    /* Suspension disables the login, but a session issued moments earlier can
       still arrive. Status is re-read here rather than trusted from the token. */
    await expect(
      service.assertOperates(admin('manager', '1'), ISSUER, { id: 'csret', managerId: '1' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a manager login with no profile', async () => {
    const { service } = make();
    await expect(
      service.assertOperates(admin('manager'), ISSUER, { id: 'csret', managerId: '1' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
