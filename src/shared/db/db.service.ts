/**
 * The only way to reach Postgres.
 *
 * There is deliberately no exported pool and no unscoped query method. An
 * unscoped query is a cross-tenant data leak (TENANCY_MODEL.md §1 D3), so the
 * unsafe path does not exist rather than merely being discouraged.
 *
 * Every call runs inside a transaction that first sets the RLS context with
 * `SET LOCAL`. SET LOCAL is scoped to the transaction, so the context cannot
 * survive into the next checkout of a pooled connection — using plain `SET`
 * here is the classic RLS-plus-pooling leak, and there is a regression test
 * that fails if anyone changes it.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config.service';
import type { TenantContext } from '../auth/tenant-context';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** The transaction handle handed to callers. Same query API as `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: Pool;
  private readonly db: Db;
  /* Separate pool authenticating as app_worker_login (BYPASSRLS). Kept as a
     distinct CONNECTION rather than a session flag on purpose: if the bypass
     were a setting the tenant role could set, an injection bug on the request
     path could switch it on. A role the request path never authenticates as
     cannot be reached that way. */
  private readonly workerPool: Pool;
  private readonly workerDb: Db;

  constructor(config: AppConfig) {
    const ssl = DbService.sslConfig(config);
    const max = config.get('DATABASE_POOL_MAX');

    this.pool = new Pool({
      connectionString: config.get('DATABASE_URL'),
      max,
      idleTimeoutMillis: 30_000,
      ssl,
    });
    this.db = drizzle(this.pool, { schema });

    /* Falls back to the main URL when unset — correct only pre-migration-042.
       Supabase free tier has a modest connection budget, so keep this small. */
    const workerUrl = config.get('DATABASE_WORKER_URL');
    if (workerUrl) {
      this.workerPool = new Pool({ connectionString: workerUrl, max: 3, idleTimeoutMillis: 30_000, ssl });
      this.workerDb = drizzle(this.workerPool, { schema });
    } else {
      this.logger.warn(
        'DATABASE_WORKER_URL is not set — cross-tenant queries share the request-path connection. ' +
          'After migration 042 this will fail; set it to the app_worker_login URL.',
      );
      this.workerPool = this.pool;
      this.workerDb = this.db;
    }
  }

  /**
   * Supabase requires TLS. Its transaction pooler presents a certificate for a
   * shared hostname, so full verification fails unless you pin their CA —
   * hence 'no-verify' as the default and DATABASE_CA_CERT as the upgrade path.
   */
  private static sslConfig(config: AppConfig): false | { rejectUnauthorized: boolean; ca?: string } {
    const mode = config.get('DATABASE_SSL');
    if (mode === 'disable') return false;
    if (mode === 'verify') {
      const ca = config.get('DATABASE_CA_CERT');
      if (!ca) throw new Error('DATABASE_SSL=verify requires DATABASE_CA_CERT');
      return { rejectUnauthorized: true, ca };
    }
    return { rejectUnauthorized: false };
  }

  /**
   * Run queries scoped to a tenant. This is the default and should be ~every
   * call site.
   *
   *   return this.db.scoped(tenant, (tx) => tx.select().from(offerings));
   *
   * Exactly one of app.issuer_id / app.investor_wallet is set, so an RLS policy
   * can tell which axis the caller sits on (TENANCY_MODEL.md §2.4).
   */
  async scoped<T>(tenant: TenantContext, fn: (tx: Tx) => Promise<T> | T): Promise<T> {
    return this.db.transaction(async (tx) => {
      /*
       * set_config(key, value, is_local) — NOT `SET LOCAL key = $1`.
       *
       * Postgres does not accept bind parameters in a SET statement, so the
       * parameterised form is a syntax error. set_config() is the function
       * equivalent and takes parameters normally; passing `true` for is_local
       * makes it transaction-scoped, exactly like SET LOCAL.
       *
       * Using set_config also means the tenant id stays a bound parameter
       * rather than being interpolated into SQL text.
       */
      switch (tenant.kind) {
        case 'issuer':
          await tx.execute(sql`SELECT set_config('app.issuer_id', ${tenant.issuerId}, true)`);
          break;
        case 'investor':
          await tx.execute(
            sql`SELECT set_config('app.investor_wallet', ${tenant.investorWallet}, true)`,
          );
          break;
        case 'account':
          /* `accounts` is not yet under RLS, but the context is set anyway so
             adding a policy later needs no change at the call sites. */
          await tx.execute(sql`SELECT set_config('app.account_id', ${tenant.accountId}, true)`);
          break;
        case 'platform':
          /* Bypasses tenant policies by design — always audited (§1 D4). */
          await tx.execute(sql`SELECT set_config('app.is_platform', 'true', true)`);
          break;
      }
      return fn(tx);
    });
  }

  /**
   * Cross-tenant access for background workers only: the indexer, webhook
   * consumers, reconciliation. Never reachable from an HTTP request.
   *
   * `reason` is required and logged — an unexplained cross-tenant read should
   * be visible in the logs without reading the code.
   */
  async worker<T>(reason: string, fn: (tx: Tx) => Promise<T> | T): Promise<T> {
    this.logger.debug({ reason }, 'cross-tenant worker transaction');
    return this.workerDb.transaction(async (tx) => fn(tx));
  }

  /**
   * Try to acquire or renew a singleton worker lease.
   *
   * NOT pg_try_advisory_lock: that is session-scoped, and behind Supavisor's
   * transaction pooler two clients can both acquire the same lock because they
   * land on different backends (measured — see migration 048). A lease row is
   * pooling-agnostic.
   *
   * One atomic statement: take it if it is unheld or lapsed, or renew it if we
   * already hold it. Returns false when someone else holds a live lease.
   */
  async acquireLease(id: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const rows = await this.worker(`lease: acquire ${id}`, async (tx) => {
      const res = await tx.execute(sql`
        INSERT INTO worker_lease (id, owner, expires_at)
        VALUES (${id}, ${owner}, now() + make_interval(secs => ${ttlSeconds}))
        ON CONFLICT (id) DO UPDATE
           SET owner = EXCLUDED.owner,
               expires_at = EXCLUDED.expires_at,
               acquired_at = CASE WHEN worker_lease.owner = EXCLUDED.owner
                                  THEN worker_lease.acquired_at ELSE now() END
         WHERE worker_lease.owner = EXCLUDED.owner
            OR worker_lease.expires_at < now()
        RETURNING owner
      `);
      return Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
    });
    return rows.length > 0;
  }

  /** Release a lease early so a restart does not wait out the TTL. */
  async releaseLease(id: string, owner: string): Promise<void> {
    await this.worker(`lease: release ${id}`, async (tx) => {
      await tx.execute(sql`DELETE FROM worker_lease WHERE id = ${id} AND owner = ${owner}`);
    });
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    if (this.workerPool !== this.pool) await this.workerPool.end();
  }
}
