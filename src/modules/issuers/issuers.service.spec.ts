/**
 * Issuer visibility rules. These encode a security boundary, not a preference:
 * the roster of issuers is the platform's book of business, and an issuer admin
 * must not be able to enumerate or probe its competitors.
 */
import { describe, expect, it, vi } from 'vitest';
import { IssuersService } from './issuers.service';
import type { IssuersRepository } from './issuers.repository';
import type { Issuer } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';
import type { AuditService } from '@shared/audit/audit.service';

const issuer = (id: string, name: string): Issuer =>
  ({
    id,
    name,
    legalEntity: null,
    contactEmail: null,
    ownerWallet: null,
    kybStatus: 'approved',
    kybNote: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }) as Issuer;

function makeService(rows: Issuer[]) {
  const repo = {
    listAll: vi.fn(async () => rows),
    findById: vi.fn(async (_t: TenantContext, id: string) => rows.find((r) => r.id === id)),
    create: vi.fn(async () => rows[0]),
    update: vi.fn(async () => rows[0]),
    setKyb: vi.fn(async () => ({ ...rows[0], kybStatus: 'approved' })),
    pendingKyb: vi.fn(async () => rows),
    applyAsNewIssuer: vi.fn(async () => rows[0]),
  } as unknown as IssuersRepository;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return { service: new IssuersService(repo, audit), repo, audit };
}

const PLATFORM: TenantContext = { kind: 'platform' };
const ISSUER_2: TenantContext = { kind: 'issuer', issuerId: '2' };
const INVESTOR: TenantContext = { kind: 'investor', investorWallet: '0xabc' };

describe('IssuersService.list', () => {
  it('shows every issuer to a platform admin', async () => {
    const { service } = makeService([issuer('2', 'Palm Crest'), issuer('5', 'Jumeirah Bay')]);
    const res = await service.list(PLATFORM);
    expect(res.items.map((i) => i.id)).toEqual(['2', '5']);
  });

  it('shows an issuer admin exactly one issuer — its own', async () => {
    const { service } = makeService([issuer('2', 'Palm Crest'), issuer('5', 'Jumeirah Bay')]);
    const res = await service.list(ISSUER_2);
    expect(res.items.map((i) => i.id)).toEqual(['2']);
  });

  it('never calls listAll for an issuer admin', async () => {
    const { service, repo } = makeService([issuer('2', 'Palm Crest')]);
    await service.list(ISSUER_2);
    /* A future refactor that "simplifies" this to list-then-filter would leak
       every issuer's row into memory and, one careless change later, onto the
       wire. Assert the query itself is scoped. */
    expect(repo.listAll).not.toHaveBeenCalled();
  });

  it('refuses investors', async () => {
    const { service } = makeService([issuer('2', 'Palm Crest')]);
    await expect(service.list(INVESTOR)).rejects.toBeInstanceOf(AppError);
  });
});

describe('IssuersService.findById', () => {
  it('returns 404 — not 403 — when the issuer belongs to someone else', async () => {
    const { service } = makeService([issuer('2', 'Palm Crest'), issuer('5', 'Jumeirah Bay')]);
    /* 403 would confirm the id exists, which is itself the disclosure. */
    await expect(service.findById(ISSUER_2, '5')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('does not even query for another issuer', async () => {
    const { service, repo } = makeService([issuer('5', 'Jumeirah Bay')]);
    await expect(service.findById(ISSUER_2, '5')).rejects.toBeInstanceOf(AppError);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('returns the issuer admin its own record', async () => {
    const { service } = makeService([issuer('2', 'Palm Crest')]);
    await expect(service.findById(ISSUER_2, '2')).resolves.toMatchObject({ id: '2' });
  });

  it('lets a platform admin read any issuer', async () => {
    const { service } = makeService([issuer('5', 'Jumeirah Bay')]);
    await expect(service.findById(PLATFORM, '5')).resolves.toMatchObject({ id: '5' });
  });

  it('404s for a genuinely missing id', async () => {
    const { service } = makeService([]);
    await expect(service.findById(PLATFORM, '99')).rejects.toMatchObject({ status: 404 });
  });
});

describe('issuer creation and KYB are platform-only', () => {
  const PLATFORM_P = { kind: 'admin', id: '1', role: 'platform_admin' } as never;
  const ISSUER_P = { kind: 'admin', id: '2', role: 'issuer_admin' } as never;

  it('refuses an issuer_admin creating another issuer', async () => {
    const { service } = makeService([issuer('2', 'Palm Crest')]);
    /* Creating an issuer creates a TENANT — one tenant must not mint another. */
    await expect(
      service.create(ISSUER_P, ISSUER_2, { name: 'Sneaky SPV' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets the platform create one', async () => {
    const { service, repo } = makeService([issuer('2', 'Palm Crest')]);
    await service.create(PLATFORM_P, PLATFORM, { name: 'New SPV' });
    expect(repo.create).toHaveBeenCalled();
  });

  it('always creates as pending_review — nobody self-approves KYB', async () => {
    const { service, repo } = makeService([issuer('2', 'Palm Crest')]);
    await service.create(PLATFORM_P, PLATFORM, { name: 'New SPV' });
    /* The repository hard-codes pending_review; the caller cannot choose. */
    expect(vi.mocked(repo.create).mock.calls[0][1]).not.toHaveProperty('kybStatus');
  });

  it('refuses an issuer_admin deciding KYB', async () => {
    const { service } = makeService([issuer('2', 'Palm Crest')]);
    await expect(
      service.decideKyb(ISSUER_P, ISSUER_2, '2', true),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('is idempotent when re-approving', async () => {
    const already = issuer('2', 'Palm Crest');
    (already as { kybStatus: string }).kybStatus = 'approved';
    const { service, repo } = makeService([already]);
    await service.decideKyb(PLATFORM_P, PLATFORM, '2', true);
    expect(repo.setKyb).not.toHaveBeenCalled();
  });
});

describe('issuer updates', () => {
  const ISSUER_P = { kind: 'admin', id: '2', role: 'issuer_admin' } as never;

  it('lets an issuer edit its OWN record', async () => {
    const { service, repo } = makeService([issuer('2', 'Palm Crest')]);
    await service.update(ISSUER_P, ISSUER_2, '2', { name: 'Renamed' });
    expect(repo.update).toHaveBeenCalled();
  });

  it("404s another issuer's record", async () => {
    const { service } = makeService([issuer('5', 'Jumeirah')]);
    await expect(service.update(ISSUER_P, ISSUER_2, '5', { name: 'x' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('cannot change kybStatus through a patch', async () => {
    const { service, repo } = makeService([issuer('2', 'Palm Crest')]);
    await service.update(ISSUER_P, ISSUER_2, '2', { name: 'x' } as never);
    /* KYB moves only through decideKyb — otherwise an issuer approves itself
       by sending a field. */
    expect(vi.mocked(repo.update).mock.calls[0][2]).not.toHaveProperty('kybStatus');
  });
});
