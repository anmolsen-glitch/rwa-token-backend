/**
 * SPV manager rules.
 *
 * This layer holds authority over an issuer's property managers — it can create
 * them, adopt them, and suspend them — so almost every test is a way that
 * authority could reach outside its own SPV, or move a manager without the
 * other side seeing it.
 */
import { describe, expect, it, vi } from 'vitest';
import { SpvManagersService } from './spv-managers.service';
import type { SpvManagersRepository } from './spv-managers.repository';
import type { IssuersRepository } from '@modules/issuers/issuers.repository';
import type { ManagersService } from '@modules/managers/managers.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { Manager, SpvManager } from '@shared/db/schema';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';

const ISSUER_2: TenantContext = { kind: 'issuer', issuerId: '2' };
const PLATFORM: TenantContext = { kind: 'platform' };
const INVESTOR: TenantContext = { kind: 'investor', investorWallet: '0xaaa' };
const ACTOR = { kind: 'admin', id: '9', email: 'a@x.io', role: 'issuer_admin' } as Principal;

const spv = (over: Partial<SpvManager> = {}): SpvManager =>
  ({
    id: '1',
    issuerId: '2',
    name: 'Priya Nair',
    company: 'Savills SPV Ops',
    contactEmail: null,
    phone: null,
    status: 'active',
    adminId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }) as SpvManager;

const mgr = (over: Partial<Manager> = {}): Manager =>
  ({
    id: '10',
    issuerId: '2',
    name: 'Acme Facilities',
    company: null,
    bio: null,
    logoUrl: null,
    contactEmail: null,
    status: 'active',
    adminId: null,
    spvManagerId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }) as Manager;

function make(opts: { row?: SpvManager | undefined; manager?: Manager | undefined; issuer?: unknown } = {}) {
  const repo = {
    list: vi.fn(async () => [spv()]),
    findById: vi.fn(async () => ('row' in opts ? opts.row : spv())),
    create: vi.fn(async (_t, issuerId: string, input: Record<string, unknown>) =>
      spv({ issuerId, name: input.name as string }),
    ),
    update: vi.fn(async (_t, _id, fields: Record<string, unknown>) => spv(fields)),
    reports: vi.fn(async () => [mgr()]),
    eligible: vi.fn(async () => [mgr()]),
    findManager: vi.fn(async () => ('manager' in opts ? opts.manager : mgr())),
    setReportsTo: vi.fn(async () => undefined),
  } as unknown as SpvManagersRepository;

  const issuers = {
    findById: vi.fn(async () => ('issuer' in opts ? opts.issuer : { id: '2', name: 'Savills' })),
  } as unknown as IssuersRepository;

  const managers = {
    create: vi.fn(async () => ({ id: '11', name: 'New Manager', hasLogin: false })),
  } as unknown as ManagersService;

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return { service: new SpvManagersService(repo, issuers, managers, audit), repo, issuers, managers, audit };
}

describe('the issuer in the path is a filter, not authority', () => {
  it("404s an issuer caller naming ANOTHER issuer's id", async () => {
    const { service, repo } = make();
    /* The path segment must never widen scope. 404 rather than 403 because
       "that issuer exists but is not yours" is itself a disclosure. */
    await expect(service.list(ISSUER_2, '5')).rejects.toMatchObject({ status: 404 });
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('lets an issuer caller name its own id', async () => {
    const { service } = make();
    await expect(service.list(ISSUER_2, '2')).resolves.toMatchObject({ items: [expect.anything()] });
  });

  it('lets the platform name any issuer — the only way it can act on one', async () => {
    const { service } = make();
    await expect(service.list(PLATFORM, '5')).resolves.toBeTruthy();
  });

  it('refuses an investor entirely', async () => {
    const { service } = make();
    await expect(service.list(INVESTOR, '2')).rejects.toMatchObject({ status: 403 });
  });

  it('404s an issuer id that does not exist', async () => {
    const { service } = make({ issuer: undefined });
    await expect(service.list(PLATFORM, '99')).rejects.toMatchObject({ status: 404 });
  });

  it('takes the issuer for a CREATE from the checked path, not the body', async () => {
    const { service, repo } = make();
    await service.create(ACTOR, ISSUER_2, '2', { name: 'X', issuerId: '5' } as never);
    expect(vi.mocked(repo.create).mock.calls[0][1]).toBe('2');
  });
});

describe('reading one SPV manager', () => {
  it("404s another issuer's SPV manager", async () => {
    const { service } = make({ row: undefined });
    await expect(service.get(ISSUER_2, '99')).rejects.toMatchObject({ status: 404 });
  });

  it('includes the property managers reporting to it', async () => {
    const { service } = make();
    const res = await service.get(ISSUER_2, '1');
    expect(res.managers).toEqual([expect.objectContaining({ id: '10' })]);
  });
});

describe('adopting a property manager', () => {
  it("404s a manager belonging to ANOTHER issuer", async () => {
    const { service, repo } = make({ manager: mgr({ issuerId: '5' }) });
    /* RLS hides it from an issuer caller, but the PLATFORM sees every row —
       this explicit comparison is what stops the operator pairing across
       tenants, and adopting a rival's operator means being able to suspend it. */
    await expect(service.setReportsTo(ACTOR, PLATFORM, '1', '10', true)).rejects.toMatchObject({
      status: 404,
    });
    expect(repo.setReportsTo).not.toHaveBeenCalled();
  });

  it('404s a manager that does not exist', async () => {
    const { service } = make({ manager: undefined });
    await expect(service.setReportsTo(ACTOR, ISSUER_2, '1', '99', true)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('attaches an unattached manager of the same issuer', async () => {
    const { service, repo } = make();
    const res = await service.setReportsTo(ACTOR, ISSUER_2, '1', '10', true);
    expect(res).toMatchObject({ spvManagerId: '1', managerId: '10' });
    expect(repo.setReportsTo).toHaveBeenCalledWith(ISSUER_2, '10', '1');
  });

  it('REFUSES to silently re-parent a manager reporting elsewhere', async () => {
    const { service, repo } = make({ manager: mgr({ spvManagerId: '7' }) });
    /* Re-parenting without a release moves a manager out from under another
       SPV manager without that one ever seeing it. Release first. */
    await expect(service.setReportsTo(ACTOR, ISSUER_2, '1', '10', true)).rejects.toMatchObject({
      code: 'ALREADY_REPORTS',
    });
    expect(repo.setReportsTo).not.toHaveBeenCalled();
  });

  it('is idempotent when it already reports HERE', async () => {
    const { service } = make({ manager: mgr({ spvManagerId: '1' }) });
    await expect(service.setReportsTo(ACTOR, ISSUER_2, '1', '10', true)).resolves.toMatchObject({
      spvManagerId: '1',
    });
  });

  it('refuses a SUSPENDED SPV manager taking on more', async () => {
    const { service } = make({ row: spv({ status: 'suspended' }) });
    await expect(service.setReportsTo(ACTOR, ISSUER_2, '1', '10', true)).rejects.toMatchObject({
      code: 'SPV_MANAGER_SUSPENDED',
    });
  });
});

describe('releasing a property manager', () => {
  it('clears only the reporting line', async () => {
    const { service, repo } = make({ manager: mgr({ spvManagerId: '1' }) });
    const res = await service.setReportsTo(ACTOR, ISSUER_2, '1', '10', false);
    /* The manager keeps its profile, properties and login — releasing must
       never be a way to delete an operator. */
    expect(res.spvManagerId).toBeNull();
    expect(repo.setReportsTo).toHaveBeenCalledWith(ISSUER_2, '10', null);
  });

  it("refuses to release one that doesn't report here", async () => {
    const { service } = make({ manager: mgr({ spvManagerId: '7' }) });
    await expect(service.setReportsTo(ACTOR, ISSUER_2, '1', '10', false)).rejects.toMatchObject({
      code: 'NOT_REPORTING',
    });
  });

  it('lets a SUSPENDED SPV manager still release — freezing must not trap', async () => {
    const { service } = make({ row: spv({ status: 'suspended' }), manager: mgr({ spvManagerId: '1' }) });
    await expect(service.setReportsTo(ACTOR, ISSUER_2, '1', '10', false)).resolves.toBeTruthy();
  });
});

describe('creating a property manager under an SPV manager', () => {
  it('delegates to ManagersService rather than duplicating the create', async () => {
    const { service, managers, repo } = make();
    await service.createManager(ACTOR, ISSUER_2, '1', { name: 'New Manager' });
    /* One implementation of what a manager is — including the login rules and
       its audit row — so the two paths cannot drift. */
    expect(managers.create).toHaveBeenCalled();
    expect(repo.setReportsTo).toHaveBeenCalledWith(ISSUER_2, '11', '1');
  });

  it('refuses when the SPV manager is suspended', async () => {
    const { service, managers } = make({ row: spv({ status: 'suspended' }) });
    await expect(
      service.createManager(ACTOR, ISSUER_2, '1', { name: 'Late Arrival' }),
    ).rejects.toMatchObject({ code: 'SPV_MANAGER_SUSPENDED' });
    expect(managers.create).not.toHaveBeenCalled();
  });

  it("404s under another issuer's SPV manager before creating anything", async () => {
    const { service, managers } = make({ row: undefined });
    await expect(
      service.createManager(ACTOR, ISSUER_2, '99', { name: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(managers.create).not.toHaveBeenCalled();
  });
});

describe('suspension', () => {
  it('freezes the layer without orphaning the managers underneath', async () => {
    const { service, repo } = make();
    await service.update(ACTOR, ISSUER_2, '1', { status: 'suspended' });
    /* Nothing is detached — the reports stay, they just cannot grow. */
    expect(repo.setReportsTo).not.toHaveBeenCalled();
  });

  it("404s an update to another issuer's SPV manager", async () => {
    const { service, repo } = make({ row: undefined });
    await expect(
      service.update(ACTOR, ISSUER_2, '99', { name: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(repo.update).not.toHaveBeenCalled();
  });
});
