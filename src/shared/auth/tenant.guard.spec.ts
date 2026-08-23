/**
 * TenantGuard is the file that decides what data a caller may see, so its
 * fail-closed behaviour is tested directly rather than inferred from routes.
 *
 * The case that matters most: a non-platform admin with NO issuer must be
 * denied. During migration 040's backfill some admins.issuer_id values are
 * still null, and the safe reading of "no tenant" is no access — never all
 * access.
 */
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { AppError } from '../errors/app-error';
import type { Principal } from './tenant-context';

function contextFor(principal: Principal | undefined, isPublic = false) {
  const req: { principal?: Principal; tenant?: unknown } = { principal };
  const reflector = new Reflector();
  /* Stand in for route metadata without booting a Nest app. */
  reflector.getAllAndOverride = (() => isPublic) as Reflector['getAllAndOverride'];
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { req, ctx, guard: new TenantGuard(reflector) };
}

const admin = (role: string, issuerId?: string): Principal =>
  ({ kind: 'admin', id: '1', email: 'a@b.c', role, issuerId }) as Principal;

describe('TenantGuard', () => {
  it('gives platform_admin an unscoped platform context', () => {
    const { guard, ctx, req } = contextFor(admin('platform_admin'));
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenant).toEqual({ kind: 'platform' });
  });

  it('scopes an issuer_admin to its own issuer', () => {
    const { guard, ctx, req } = contextFor(admin('issuer_admin', '42'));
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenant).toEqual({ kind: 'issuer', issuerId: '42' });
  });

  it('DENIES a non-platform admin with no issuer (fail closed)', () => {
    const { guard, ctx } = contextFor(admin('compliance', undefined));
    expect(() => guard.canActivate(ctx)).toThrowError(AppError);
    try {
      guard.canActivate(ctx);
    } catch (e) {
      expect((e as AppError).status).toBe(403);
    }
  });

  it('scopes an investor by wallet, lowercased', () => {
    const { guard, ctx, req } = contextFor({
      kind: 'investor',
      id: 'w',
      wallet: '0xAbCdEf',
    } as Principal);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenant).toEqual({ kind: 'investor', investorWallet: '0xabcdef' });
  });

  it('rejects an unauthenticated request', () => {
    const { guard, ctx } = contextFor(undefined);
    expect(() => guard.canActivate(ctx)).toThrowError(AppError);
  });

  it('skips resolution for @Public routes', () => {
    const { guard, ctx, req } = contextFor(undefined, true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenant).toBeUndefined();
  });
});
