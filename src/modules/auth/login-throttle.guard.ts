/**
 * Brute-force throttle for the login endpoint.
 *
 * The global rate limit (300/15min) is far too generous for credential
 * stuffing. This adds a tighter per-IP budget on /auth/login specifically,
 * matching the Express app's loginLimiter.
 *
 * LIMITATION, stated plainly: the counter is in-memory, so it is per-instance.
 * With one process that is exactly right; behind multiple replicas an attacker
 * gets N× the budget. The Express app has the same property (express-rate-limit
 * defaults to an in-memory store), so this is parity, not a regression. Move to
 * a shared store when the API is actually replicated — not before, since a
 * Redis dependency for one endpoint is not worth it today.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@shared/errors/app-error';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const key = req.ip;
    const now = Date.now();

    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }

    if (bucket.count >= MAX_ATTEMPTS) {
      throw new AppError('TOO_MANY_ATTEMPTS', 429, 'Too many login attempts. Try again later.', {
        retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
      });
    }

    bucket.count += 1;
    return true;
  }

  /** Bounded memory: drop expired buckets rather than growing forever. */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
