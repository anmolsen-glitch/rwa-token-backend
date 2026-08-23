/**
 * The decorator vocabulary every controller uses. There are exactly four —
 * if you need a fifth, add it here rather than reaching into the request object
 * in a handler.
 */
import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AdminRole, Principal, SessionType, TenantContext } from './tenant-context';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const SESSION_KEY = 'auth:session';

/**
 * Opt a route out of authentication. Guards are global, so this is the ONLY
 * way a route becomes unauthenticated — which means `grep -r "@Public"` is a
 * complete audit of the app's public surface.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict a route to these admin roles. Enforced by RolesGuard. */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Which session type this route accepts. Defaults to 'admin' when absent, so
 * the back-office surface stays locked down by omission rather than by
 * remembering to annotate it.
 */
export const Session = (type: SessionType) => SetMetadata(SESSION_KEY, type);

/** The resolved data-scoping context. Set by TenantGuard from the JWT only. */
export const Tenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.tenant) {
    /* Unreachable if guards ran. If it throws, a route bypassed TenantGuard —
       that is a security bug, not a 500 to paper over. */
    throw new Error('TenantContext missing — route is not behind TenantGuard');
  }
  return req.tenant;
});

/** The authenticated caller. Prefer @Tenant() for anything data-scoping. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.principal) throw new Error('Principal missing — route is not behind AuthGuard');
  return req.principal;
});
