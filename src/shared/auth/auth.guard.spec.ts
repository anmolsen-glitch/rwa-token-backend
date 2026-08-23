/**
 * AuthGuard: authentication + double-submit CSRF.
 *
 * CSRF applies to AUTHENTICATED mutations only. @Public routes skip it: they
 * do not rely on the ambient cookie, and checking it anyway meant a stale
 * session cookie could 403 signup/login (on localhost the two portals share
 * cookies across ports; this happened).
 */
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AppError } from '../errors/app-error';
import type { JwtService } from './jwt.service';
import type { PrincipalService } from './principal.service';
import { IS_PUBLIC_KEY, SESSION_KEY } from './decorators';
import type { SessionType } from './tenant-context';

interface ReqShape {
  method: string;
  cookies: Record<string, string>;
  headers: Record<string, string | undefined>;
  principal?: unknown;
}

function build(opts: {
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string | undefined>;
  isPublic?: boolean;
  session?: SessionType;
  verify?: () => { sub: string };
}) {
  const req: ReqShape = {
    method: opts.method ?? 'GET',
    cookies: opts.cookies ?? {},
    headers: opts.headers ?? {},
  };

  const reflector = new Reflector();
  /* Key-aware: the guard reads BOTH the public flag and the required session
     type, and returning one value for every key silently mis-types the route. */
  reflector.getAllAndOverride = ((key: string) => {
    if (key === IS_PUBLIC_KEY) return opts.isPublic ?? false;
    if (key === SESSION_KEY) return opts.session ?? 'admin';
    return undefined;
  }) as unknown as Reflector['getAllAndOverride'];

  const jwt = {
    verify:
      opts.verify ??
      (() => {
        throw new Error('invalid');
      }),
  } as unknown as JwtService;

  const principals = {
    loadAdmin: vi.fn(async (id: string) => ({ kind: 'admin', id, role: 'issuer_admin' })),
    loadAccount: vi.fn(async (id: string) => ({ kind: 'account', id, accountId: id })),
    loadInvestor: vi.fn(async (w: string) => ({ kind: 'investor', id: w, wallet: w })),
  } as unknown as PrincipalService;

  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;

  return { req, ctx, guard: new AuthGuard(reflector, jwt, principals) };
}

describe('AuthGuard — CSRF', () => {
  it('allows safe methods without a CSRF header', async () => {
    const { guard, ctx } = build({ method: 'GET', isPublic: true });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a cookie-session mutation with no CSRF header', async () => {
    const { guard, ctx } = build({
      method: 'POST',
      cookies: { rwa_admin_token: 'x', rwa_csrf: 'secret' },
      verify: () => ({ sub: 'a1', typ: 'admin' }) as never,
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'CSRF_FAILED' });
  });

  it('lets a PUBLIC mutation through despite a stale session cookie', async () => {
    /* Signup/login with the OTHER portal's cookie present — must not 403. */
    const { guard, ctx } = build({
      method: 'POST',
      isPublic: true,
      cookies: { rwa_admin_token: 'x', rwa_csrf: 'secret' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a mismatched CSRF header', async () => {
    const { guard, ctx } = build({
      method: 'POST',
      cookies: { rwa_admin_token: 'x', rwa_csrf: 'secret' },
      headers: { 'x-csrf-token': 'wrong-value-x' },
      verify: () => ({ sub: 'a1', typ: 'admin' }) as never,
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'CSRF_FAILED' });
  });

  it('accepts a matching CSRF header', async () => {
    const { guard, ctx } = build({
      method: 'POST',
      isPublic: true,
      cookies: { rwa_admin_token: 'x', rwa_csrf: 'secret' },
      headers: { 'x-csrf-token': 'secret' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('exempts Bearer requests — they carry no ambient credential', async () => {
    const { guard, ctx } = build({
      method: 'POST',
      isPublic: true,
      headers: { authorization: 'Bearer abc' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('AuthGuard — authentication', () => {
  it('rejects a protected route with no credentials', async () => {
    const { guard, ctx } = build({ isPublic: false });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(AppError);
  });

  it('does not leak why a token failed', async () => {
    const { guard, ctx } = build({
      isPublic: false,
      cookies: { rwa_admin_token: 'expired-token' },
      verify: () => {
        throw new Error('jwt expired');
      },
    });
    /* "jwt expired" vs "invalid signature" is a probing oracle — the client
       gets one indistinguishable message. */
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      message: 'Invalid or expired token.',
    });
  });

  it('loads the principal from the DB on success', async () => {
    const { guard, ctx, req } = build({
      isPublic: false,
      cookies: { rwa_admin_token: 'good' },
      verify: () => ({ sub: '7' }),
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.principal).toMatchObject({ id: '7' });
  });
});

describe('AuthGuard — session types', () => {
  it('verifies an admin route against typ=admin', async () => {
    const verify = vi.fn(() => ({ sub: '1' }));
    const { guard, ctx } = build({
      cookies: { rwa_admin_token: 'x' },
      verify,
    });
    await guard.canActivate(ctx);
    expect(verify).toHaveBeenCalledWith('x', 'admin');
  });

  it('verifies an account route against typ=account', async () => {
    const verify = vi.fn(() => ({ sub: '7' }));
    const { guard, ctx } = build({
      session: 'account',
      cookies: { rwa_account_token: 'y' },
      verify,
    });
    await guard.canActivate(ctx);
    /* The typ claim is what stops an admin token being replayed here — all
       three are signed with the same secret. */
    expect(verify).toHaveBeenCalledWith('y', 'account');
  });

  it('does NOT fall back to another session type\'s cookie', async () => {
    /* A browser can legitimately hold both; picking the wrong one would
       authenticate the wrong principal. */
    const { guard, ctx } = build({
      session: 'account',
      cookies: { rwa_admin_token: 'admin-token' },
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('loads an investor principal for an investor route', async () => {
    const { guard, ctx, req } = build({
      session: 'investor',
      cookies: { rwa_investor_token: 'z' },
      verify: () => ({ sub: '0xabc' }),
    });
    await guard.canActivate(ctx);
    expect(req.principal).toMatchObject({ kind: 'investor', wallet: '0xabc' });
  });
});
