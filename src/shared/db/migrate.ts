/**
 * Migration runner — same contract as the Express app's (src/lib/db/migrate.ts):
 * applies every `migrations/*.sql` exactly once, sorted by filename, each in its
 * own transaction, tracked in the SAME `schema_migrations` table.
 *
 * Sharing that table is deliberate. Both apps point at one database, so there
 * must be exactly one ledger of what has been applied. This repo owns migrations
 * from 039 onward; the Express repo owns 001–038 and must not gain new ones.
 *
 *   npm run db:migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import 'dotenv/config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

async function main(): Promise<void> {
  /* Migrations need owner privileges (ALTER TABLE, CREATE POLICY), which the
     runtime app_tenant_login role deliberately does not have. DATABASE_ADMIN_URL
     holds the owner connection; DATABASE_URL is the least-privilege runtime one. */
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_ADMIN_URL (or DATABASE_URL) to an owner connection');

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 2,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const done = new Set(rows.map((r) => r.filename));

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
  const pending = files.filter((f) => !done.has(f));

  if (pending.length === 0) {
    console.log('[migrate] up to date — nothing to apply');
    await pool.end();
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`[migrate] applied ${pending.length} migration(s)`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
