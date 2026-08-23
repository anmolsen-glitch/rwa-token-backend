/**
 * Typed accessor over ConfigService.
 *
 * Nest's ConfigService loses precise types through Zod transforms (a
 * `string → string[]` transform infers as `unknown`). This wrapper restores
 * them, so `cfg.get('CORS_ORIGINS')` is `string[]` and `cfg.get('PORT')` is
 * `number` — no casts at call sites.
 *
 * Inject AppConfig, never ConfigService, and never `process.env`.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key as string) as Env[K];
  }

  /** Per-action approval overrides, assembled from the flat env vars. */
  get approvalThresholds(): Record<string, number> {
    return { 'force-transfer': this.get('APPROVAL_THRESHOLD_FORCE_TRANSFER') };
  }

  /** Compliance modules bound at deploy time. */
  get moduleAddresses(): { maxHoldersModule: string; lockupPeriodModule: string } {
    const max = this.get('MAXHOLDERS_MODULE');
    const lock = this.get('LOCKUP_MODULE');
    if (!max || !lock) {
      throw new Error('MAXHOLDERS_MODULE and LOCKUP_MODULE must be set to deploy a token suite.');
    }
    return { maxHoldersModule: max, lockupPeriodModule: lock };
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isDevelopment(): boolean {
    return this.get('NODE_ENV') === 'development';
  }
}
