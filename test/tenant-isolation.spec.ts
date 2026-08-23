/**
 * THE required regression test (CLAUDE.md §9, TENANCY_MODEL.md §7).
 *
 * This deliberately issues RAW, UNFILTERED queries — `SELECT * FROM offerings`
 * with no WHERE clause. If isolation still holds, it is the DATABASE enforcing
 * it, not the repository. That is the whole point of RLS: it survives an
 * application bug that forgets a predicate.
 *
 * It also pins two things that fail silently if changed:
 *   1. the runtime role must not have BYPASSRLS (every policy would be inert);
 *   2. context must be transaction-scoped, so it cannot leak into the next
 *      checkout of a pooled connection.
 *
 * Requires a live database and DATABASE_URL pointing at app_tenant_login.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const raw = readFileSync(resolve(__dirname, '../.env'), 'utf8');
    const line = raw.split('\n').find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim();
  } catch {
    return undefined;
  }
}

const url = envValue('DATABASE_URL');

describe.skipIf(!url)('tenant isolation is enforced by Postgres', () => {
  /* max: 1 forces every query onto the SAME physical connection. Without it a
     leak test can pass by luck, because each query might get a fresh backend. */
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });

  afterAll(async () => {
    await pool.end();
  });

  /** Raw, unfiltered read under a given tenant context. */
  async function readOfferings(setContext?: { key: string; value: string }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (setContext) {
        await client.query('SELECT set_config($1, $2, true)', [setContext.key, setContext.value]);
      }
      const { rows } = await client.query<{ issuer_id: string | null }>(
        'SELECT issuer_id FROM offerings',
      );
      await client.query('COMMIT');
      return rows;
    } finally {
      client.release();
    }
  }

  it('runs as a role that CANNOT bypass RLS', async () => {
    const { rows } = await pool.query<{ current_user: string; bypass: boolean }>(
      `SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
    );
    /* If this ever becomes true, every policy is decorative and the rest of
       this file would pass while isolating nothing. */
    expect(rows[0].bypass).toBe(false);
    expect(rows[0].current_user).not.toBe('postgres');
  });

  it('returns NOTHING when no tenant context is set (fail closed)', async () => {
    const rows = await readOfferings();
    expect(rows).toHaveLength(0);
  });

  it('shows an issuer only its own rows, with no WHERE clause in the query', async () => {
    const rows = await readOfferings({ key: 'app.issuer_id', value: '2' });
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.issuer_id))]).toEqual(['2']);
  });

  it('shows a different issuer a disjoint set', async () => {
    const two = await readOfferings({ key: 'app.issuer_id', value: '2' });
    const five = await readOfferings({ key: 'app.issuer_id', value: '5' });
    expect([...new Set(five.map((r) => r.issuer_id))]).toEqual(['5']);

    const idsTwo = new Set(two.map((r) => r.issuer_id));
    expect(five.some((r) => idsTwo.has(r.issuer_id))).toBe(false);
  });

  it('shows everything to the platform context', async () => {
    const all = await readOfferings({ key: 'app.is_platform', value: 'true' });
    const scoped = await readOfferings({ key: 'app.issuer_id', value: '2' });
    expect(all.length).toBeGreaterThan(scoped.length);
  });

  it('does not leak context into the next checkout of the same connection', async () => {
    await readOfferings({ key: 'app.issuer_id', value: '2' });

    /* Same pooled connection (max: 1), no context this time. If set_config's
       is_local flag were dropped — or someone used plain SET — issuer 2's rows
       would still be visible here. */
    const after = await readOfferings();
    expect(after).toHaveLength(0);
  });

  it('hides the issuer roster from an issuer-scoped connection', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.issuer_id', '2', true)`);
      const { rows } = await client.query<{ id: string }>('SELECT id FROM issuers');
      await client.query('COMMIT');
      /* One row: its own. Not the platform's book of business. */
      expect(rows.map((r) => r.id)).toEqual(['2']);
    } finally {
      client.release();
    }
  });
});
