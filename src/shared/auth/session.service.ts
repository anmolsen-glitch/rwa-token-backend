/**
 * Issues and clears session cookies. Cookie names, flags, and TTLs match the
 * Express app exactly — both services read the same browser cookies during the
 * migration, so any divergence logs users out at random.
 *
 * The session JWT is httpOnly (JS cannot read it, so XSS cannot exfiltrate it).
 * That makes requests CSRF-prone, so a second, JS-readable `rwa_csrf` cookie is
 * issued alongside; the frontend echoes it in the x-csrf-token header. An
 * attacker's cross-site form rides the session cookie but cannot read the CSRF
 * cookie to forge the header.
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { AppConfig } from '../config/app-config.service';
import { ACCOUNT_COOKIE, ADMIN_COOKIE, CSRF_COOKIE, INVESTOR_COOKIE, durationMs } from './cookies';

@Injectable()
export class SessionService {
  constructor(private readonly config: AppConfig) {}

  private baseOptions(maxAgeMs: number) {
    return {
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: this.config.get('COOKIE_SAMESITE'),
      domain: this.config.get('COOKIE_DOMAIN'),
      path: '/',
      maxAge: Math.floor(maxAgeMs / 1000), // @fastify/cookie takes seconds
    } as const;
  }

  issueAdmin(reply: FastifyReply, token: string): void {
    const maxAge = durationMs(this.config.get('JWT_EXPIRES_IN'));
    void reply.setCookie(ADMIN_COOKIE, token, { ...this.baseOptions(maxAge), httpOnly: true });
    /* Not httpOnly — the SPA must read this one to echo it back. */
    void reply.setCookie(CSRF_COOKIE, randomBytes(24).toString('hex'), {
      ...this.baseOptions(maxAge),
      httpOnly: false,
    });
  }

  /** Account (person) session — step 1 of the investor flow. */
  issueAccount(reply: FastifyReply, token: string): void {
    this.issue(reply, ACCOUNT_COOKIE, token, this.config.get('INVESTOR_JWT_EXPIRES_IN'));
  }

  /** Investor (wallet) session, established by SIWE — step 3. */
  issueInvestor(reply: FastifyReply, token: string): void {
    this.issue(reply, INVESTOR_COOKIE, token, this.config.get('INVESTOR_JWT_EXPIRES_IN'));
  }

  private issue(reply: FastifyReply, name: string, token: string, ttl: string): void {
    const maxAge = durationMs(ttl);
    void reply.setCookie(name, token, { ...this.baseOptions(maxAge), httpOnly: true });
    void reply.setCookie(CSRF_COOKIE, randomBytes(24).toString('hex'), {
      ...this.baseOptions(maxAge),
      httpOnly: false,
    });
  }

  clearAccount(reply: FastifyReply): void {
    this.clear(reply, ACCOUNT_COOKIE);
  }

  clearInvestor(reply: FastifyReply): void {
    this.clear(reply, INVESTOR_COOKIE);
  }

  private clear(reply: FastifyReply, name: string): void {
    const opts = { ...this.baseOptions(0), maxAge: undefined };
    void reply.clearCookie(name, { ...opts, httpOnly: true });
    void reply.clearCookie(CSRF_COOKIE, { ...opts, httpOnly: false });
  }

  clearAdmin(reply: FastifyReply): void {
    const opts = { ...this.baseOptions(0), maxAge: undefined };
    void reply.clearCookie(ADMIN_COOKIE, { ...opts, httpOnly: true });
    void reply.clearCookie(CSRF_COOKIE, { ...opts, httpOnly: false });
  }
}
