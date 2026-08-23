/**
 * createAsset — the wizard's create-listing call. It must never touch the
 * chain: the deploy is a separate retryable step, which is what removed the
 * need for the Express write-ahead pending_deploys table.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { OfferingsService } from './offerings.service';
import type { CreateAssetDto } from './dto/create-asset.dto';

const ISSUER_TENANT: TenantContext = { kind: 'issuer', issuerId: '2' };
const PRINCIPAL = { id: '1', role: 'issuer_admin' } as unknown as Principal;

const DOCS = [
  { type: 'Title Deed', url: 'https://x/deed.pdf' },
  { type: 'Valuation Report', url: 'https://x/val.pdf' },
  { type: 'SPV Ownership Proof', url: 'https://x/spv.pdf' },
];

const BASE: CreateAssetDto = {
  symbol: 'MCR',
  name: 'Marina Crest Residence',
  currency: 'AED',
  pricePerToken: '1000',
  minInvestment: '1000',
  targetRaise: '2500000',
  country: 784,
  documents: DOCS,
} as CreateAssetDto;

function build(overrides: Record<string, unknown> = {}) {
  const created: Record<string, unknown>[] = [];
  const repo = {
    findById: vi.fn(async () => undefined),
    tokenSymbolInUse: vi.fn(async () => false),
    create: vi.fn(async (_t: unknown, issuerId: string, input: Record<string, unknown>) => {
      created.push(input);
      return {
        ...input,
        issuerId,
        tokenSymbol: null,
        status: 'coming_soon',
        createdAt: new Date(0),
      };
    }),
    ...overrides,
  };
  const issuers = {
    findById: vi.fn(async () => ({ id: '2', kybStatus: 'approved', ownerWallet: '0x' + 'a'.repeat(40) })),
  };
  const deploy = { deploySuite: vi.fn() };
  const audit = { record: vi.fn(async () => ({})) };
  const config = { get: () => 'sepolia' };
  const svc = new OfferingsService(
    repo as never,
    issuers as never,
    deploy as never,
    audit as never,
    config as never,
  );
  return { svc, repo, issuers, deploy, audit, created };
}

describe('OfferingsService.createAsset', () => {
  it('creates the listing with the token plan recorded, and never deploys', async () => {
    const { svc, deploy, created } = build();
    const out = await svc.createAsset(PRINCIPAL, ISSUER_TENANT, '2', BASE);
    expect(out.token).toBeNull();
    expect(out.offering.id).toBe('mcr');
    expect(deploy.deploySuite).not.toHaveBeenCalled();
    expect(created[0].tokenPlan).toMatchObject({
      symbol: 'MCR',
      tokenName: 'Marina Crest Residence',
      maxHolders: 500,
      lockupDays: 0,
      intendedStatus: 'open',
    });
  });

  it('404s when an issuer names a different issuer in the path', async () => {
    const { svc } = build();
    await expect(svc.createAsset(PRINCIPAL, ISSUER_TENANT, '5', BASE)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses the legacy one-shot deployNow flag with a pointer to the deploy route', async () => {
    const { svc } = build();
    await expect(
      svc.createAsset(PRINCIPAL, ISSUER_TENANT, '2', { ...BASE, deployNow: true }),
    ).rejects.toMatchObject({ code: 'DEPLOY_IS_SEPARATE' });
  });

  it('rejects a stated supply that disagrees with targetRaise / pricePerToken', async () => {
    const { svc } = build();
    await expect(
      svc.createAsset(PRINCIPAL, ISSUER_TENANT, '2', { ...BASE, totalTokens: 100 }),
    ).rejects.toMatchObject({ code: 'SUPPLY_MISMATCH' });
    await expect(
      svc.createAsset(PRINCIPAL, ISSUER_TENANT, '2', { ...BASE, totalTokens: 2500 }),
    ).resolves.toBeTruthy();
  });

  it('requires every listing document to have a URL', async () => {
    const { svc } = build();
    await expect(
      svc.createAsset(PRINCIPAL, ISSUER_TENANT, '2', { ...BASE, documents: DOCS.slice(0, 2) }),
    ).rejects.toMatchObject({ code: 'MISSING_DOCUMENTS' });
  });

  it('conflicts when the symbol already has a deployed token', async () => {
    const { svc } = build({ tokenSymbolInUse: vi.fn(async () => true) });
    await expect(svc.createAsset(PRINCIPAL, ISSUER_TENANT, '2', BASE)).rejects.toMatchObject({
      code: 'TOKEN_SYMBOL_EXISTS',
    });
  });

  it('conflicts on unapproved KYB', async () => {
    const { svc, issuers } = build();
    issuers.findById.mockResolvedValueOnce({ id: '2', kybStatus: 'pending', ownerWallet: '0x' + 'a'.repeat(40) });
    await expect(svc.createAsset(PRINCIPAL, ISSUER_TENANT, '2', BASE)).rejects.toMatchObject({
      code: 'KYB_NOT_APPROVED',
    });
  });
});
