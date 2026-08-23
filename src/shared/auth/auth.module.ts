/**
 * Auth infrastructure. Global because guards are registered app-wide in
 * app.module.ts and Nest must be able to inject their dependencies from any
 * module's context.
 */
import { Global, Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { JwtService } from './jwt.service';
import { PrincipalService } from './principal.service';
import { RolesGuard } from './roles.guard';
import { SessionService } from './session.service';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [JwtService, PrincipalService, SessionService, AuthGuard, TenantGuard, RolesGuard],
  exports: [JwtService, PrincipalService, SessionService, AuthGuard, TenantGuard, RolesGuard],
})
export class AuthModule {}
