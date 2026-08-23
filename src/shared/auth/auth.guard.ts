/**
 * Guard 1 of 3 — authentication + CSRF.
 *
 * Applied globally in app.module.ts, so every route is authenticated unless it
 * carries @Public(). Fail-closed by default is the point: forgetting a
 * decorator locks a route down, it never opens one up.
 *
 * Accepts the httpOnly session cookie (browsers) or a Bearer header (API
 * clients, tests). Cookie-authenticated mutations must also pass the
 * double-submit CSRF check; Bearer requests carry no ambient credential and so
 * are not CSRF-prone.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/app-error';
import {
  ACCOUNT_COOKIE,
  ADMIN_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  INVESTOR_COOKIE,
  SAFE_METHODS,
  SESSION_COOKIES,
} from './cookies';
import { IS_PUBLIC_KEY, SESSION_KEY } from './decorators';
import type { SessionType } from './tenant-context';
import { JwtService } from './jwt.service';
import { PrincipalService } from './principal.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    this.assertCsrf(req);
    if (isPublic) return true;

    /*
     * Which session this route accepts. Defaults to 'admin', so the back-office
     * stays locked down by omission rather than by remembering to annotate it.
     */
    const required =
      this.reflector.getAllAndOverride<SessionType>(SESSION_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? 'admin';

    const token = this.extractToken(req, required);
    if (!token) throw AppError.unauthorized('Missing or malformed credentials.');

    let claims;
    try {
      /*
       * Verified against the REQUIRED type. The `typ` claim is what stops an
       * investor token being replayed on an admin route — all three are signed
       * with the same secret, so without this check they would be
       * interchangeable.
       */
      claims = this.jwt.verify(token, required);
    } catch {
      /* Never surface the jwt library's reason — "jwt expired" vs "invalid
         signature" is a probing oracle. */
      throw AppError.unauthorized('Invalid or expired token.');
    }

    req.principal = await this.loadPrincipal(required, claims.sub);
    return true;
  }

  private loadPrincipal(type: SessionType, subject: string) {
    switch (type) {
      case 'admin':
        return this.principals.loadAdmin(subject);
      case 'account':
        return this.principals.loadAccount(subject);
      case 'investor':
        return this.principals.loadInvestor(subject);
    }
  }

  private static readonly COOKIE_FOR: Record<SessionType, string> = {
    admin: ADMIN_COOKIE,
    account: ACCOUNT_COOKIE,
    investor: INVESTOR_COOKIE,
  };

  /**
   * The cookie for THIS route's session type, or a Bearer header.
   *
   * Deliberately does not fall back to another session's cookie: a browser can
   * legitimately hold an admin cookie and an investor cookie at once, and
   * picking the wrong one would authenticate the wrong principal.
   */
  private extractToken(req: FastifyRequest, type: SessionType): string | null {
    const cookie = req.cookies?.[AuthGuard.COOKIE_FOR[type]];
    if (cookie) return cookie;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length).trim() || null;
  }

  /**
   * Double-submit CSRF. Only applies when the request carries one of our
   * session cookies AND uses an unsafe method — see cookies.ts for why.
   */
  private assertCsrf(req: FastifyRequest): void {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return;

    const cookies = req.cookies ?? {};
    const hasCookieSession = SESSION_COOKIES.some((name) => Boolean(cookies[name]));
    if (!hasCookieSession) return; // bearer or anonymous → not CSRF-prone

    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER];

    if (!cookieToken || typeof headerToken !== 'string' || !this.constantTimeEqual(cookieToken, headerToken)) {
      throw new AppError('CSRF_FAILED', 403, 'CSRF token missing or invalid.');
    }
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
