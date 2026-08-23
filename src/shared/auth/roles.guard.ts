/**
 * Guard 3 of 3 — role checks from @Roles(...).
 *
 * IMPORTANT CHANGE FROM THE EXPRESS APP: there, `issuer_admin` satisfied every
 * role check as a superuser (src/middleware/auth.ts:69). Under multi-tenancy
 * that is wrong — issuer_admin is now bounded to its own issuer, and
 * `platform_admin` is the only role that bypasses. Reintroducing the old
 * behaviour would silently re-open every tenant wall.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';
import type { AdminRole } from './tenant-context';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const role = req.principal?.role;
    if (!role) throw AppError.unauthorized();

    if (role === 'platform_admin' || required.includes(role)) return true;

    throw new AppError('FORBIDDEN', 403, 'You do not have permission to perform this action.', {
      requiredRoles: required,
      yourRole: role,
    });
  }
}
