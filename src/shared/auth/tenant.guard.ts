/**
 * Guard 2 of 3 — resolves the data-scoping context.
 *
 * THE most security-sensitive file in the repo. The tenant is derived from the
 * verified principal and from nothing else: never a body field, never a query
 * param, never a header. If a caller could name its own issuerId, every wall in
 * TENANCY_MODEL.md would be decorative.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import { IS_PUBLIC_KEY } from './decorators';
import type { Principal, TenantContext } from './tenant-context';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!req.principal) throw AppError.unauthorized();

    req.tenant = this.resolve(req.principal);
    return true;
  }

  private resolve(principal: Principal): TenantContext {
    if (principal.kind === 'investor' && principal.wallet) {
      return { kind: 'investor', investorWallet: principal.wallet.toLowerCase() };
    }

    /* A person who may not have connected a wallet yet (flow steps 1-2). Scopes
       to their own account, never to issuer data. */
    if (principal.kind === 'account') {
      return { kind: 'account', accountId: principal.id };
    }

    if (principal.kind === 'admin') {
      if (principal.role === 'platform_admin') return { kind: 'platform' };

      /*
       * A non-platform admin with no issuer is a misconfigured account. Until
       * migration 040's backfill completes some rows may still be null — and
       * the safe reading of "no tenant" is NO ACCESS, never ALL ACCESS.
       */
      if (!principal.issuerId) {
        throw AppError.forbidden('Account is not assigned to an issuer. Contact a platform administrator.');
      }
      return { kind: 'issuer', issuerId: principal.issuerId };
    }

    throw AppError.forbidden('Session type cannot be scoped to a tenant.');
  }
}
