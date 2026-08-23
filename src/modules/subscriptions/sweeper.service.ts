/**
 * Background maintenance for the order lifecycle.
 *
 * Two scans, both idempotent and both safe to run on a schedule:
 *
 *   expireStaleReservations  releases allocation held by abandoned checkouts
 *   recoverStaleSettlements  resolves orders stuck mid-mint after a crash
 *
 * SINGLETON via the `worker_lease` row, not an advisory lock: session-scoped
 * state does not survive a transaction pooler, and two instances both sweeping
 * would double-refund and double-mint. Same lease mechanism the indexer uses,
 * different id — one process may hold either, both, or neither.
 *
 * Failures here are logged and swallowed. A sweep is a safety net; a net that
 * takes down the API when it tears is worse than no net.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService } from '@shared/db/db.service';
import { AppConfig } from '@shared/config/app-config.service';
import { SubscriptionsService } from './subscriptions.service';

const LEASE_ID = 'order-sweeper';
const LEASE_TTL_SECONDS = 120;
/** Frequent enough to matter, rare enough that a missed tick costs nothing. */
const INTERVAL_MS = 60_000;

@Injectable()
export class SweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SweeperService.name);
  private readonly owner = `${process.pid}-${randomBytes(4).toString('hex')}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly subs: SubscriptionsService,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('SWEEPER_ENABLED')) {
      this.logger.log(
        'order sweeper disabled (SWEEPER_ENABLED=false) — Express is presumably sweeping',
      );
      return;
    }
    /* Start the timer regardless of whether the first scan succeeds — a failed
       boot scan must not leave the sweeper permanently dead. */
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    await this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    void this.db.releaseLease(LEASE_ID, this.owner).catch(() => undefined);
  }

  private async tick(): Promise<void> {
    /* Overlap guard: a slow scan must not have a second one start on top. */
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.db.acquireLease(LEASE_ID, this.owner, LEASE_TTL_SECONDS))) return;
      await this.subs.expireStaleReservations();
      await this.subs.recoverStaleSettlements();
    } catch (err) {
      this.logger.error({ err }, 'order sweep failed — will retry on the next tick');
    } finally {
      this.running = false;
    }
  }
}
