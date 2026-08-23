/**
 *   POST /api/auth/login   { email, password } → { admin } + session cookies
 *   POST /api/auth/logout  clears the session
 *   GET  /api/auth/me      the current admin + resolved tenant scope
 */
import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentUser, Public, Tenant } from '@shared/auth/decorators';
import { SessionService } from '@shared/auth/session.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginThrottleGuard } from './login-throttle.guard';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiAuthErrors, ApiRateLimited, ApiValidationError } from '@shared/openapi/api-error.decorator';

@ApiTags('Admin Auth')
@Controller('admin/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly session: SessionService,
  ) {}

  /*
   * @Public because the caller has no session yet — that is the point of
   * logging in. CSRF still applies (AuthGuard checks it before the public
   * short-circuit), which is why a stale cookie cannot be replayed here.
   *
   * passthrough: true lets us set cookies while still RETURNING the body, so
   * the controller keeps the normal shape instead of calling reply.send().
   */
  @Public()
  @UseGuards(LoginThrottleGuard)
  @ApiOperation({
    summary: 'Log in (back-office)',
    description:
      'Sets an httpOnly session cookie plus a JS-readable `rwa_csrf` cookie. The JWT is ' +
      'deliberately NOT returned in the body — echoing it there would hand XSS the very ' +
      'thing httpOnly exists to prevent. Throttled to 10 attempts per IP per 15 minutes.',
  })
  @ApiOkResponse({ description: 'Session established; cookies set.' })
  @ApiValidationError()
  @ApiRateLimited()
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const { token, admin } = await this.auth.login(dto.email, dto.password);
    this.session.issueAdmin(reply, token);
    /* The token is deliberately NOT in the body. The Express app returns it for
       non-browser clients; browsers must use the httpOnly cookie, and echoing
       it in the body hands XSS the thing httpOnly exists to protect. */
    return { admin };
  }

  @Public()
  @ApiOperation({ summary: 'Log out (back-office)', description: 'Clears the session and CSRF cookies.' })
  @HttpCode(200)
  @Post('logout')
  logout(@Res({ passthrough: true }) reply: FastifyReply) {
    this.session.clearAdmin(reply);
    return { ok: true };
  }

  @ApiOperation({
    summary: 'Current admin + resolved tenant scope',
    description:
      'Returns the authenticated admin and the TenantContext derived from their token. ' +
      'The tenant is surfaced so scoping is debuggable from the client rather than ' +
      'invisible server-side state.',
  })
  @ApiAuthErrors()
  @Get('me')
  me(@CurrentUser() principal: Principal, @Tenant() tenant: TenantContext) {
    return {
      admin: {
        id: principal.id,
        email: principal.email,
        role: principal.role,
        issuerId: principal.issuerId ?? null,
      },
      /* Surfacing the resolved scope makes tenancy debuggable from the client
         instead of being invisible server-side state. */
      tenant,
    };
  }
}
