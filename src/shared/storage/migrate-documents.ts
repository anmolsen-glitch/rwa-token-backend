/**
 * Move legacy base64 KYC documents out of Postgres and onto the storage backend.
 *
 *   npm run db:migrate-documents            # dry run
 *   npm run db:migrate-documents -- --confirm
 *
 * Not a SQL migration: it moves BYTES, needs the encryption key, and must be
 * re-runnable and interruptible. Each document is written to disk, verified by
 * reading it back and comparing the hash, and only then is `content` cleared.
 * A crash mid-run leaves an orphaned file, never a row without its bytes.
 */
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import 'dotenv/config';
import { LocalDiskStorage } from './local-disk.storage';

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_ADMIN_URL');

  const raw = process.env.DOCUMENT_ENCRYPTION_KEY;
  const key = raw ? Buffer.from(raw, 'base64') : null;
  if (raw && key!.length !== 32) throw new Error('DOCUMENT_ENCRYPTION_KEY must be 32 bytes base64');

  const root = resolve(process.env.DOCUMENT_STORAGE_ROOT ?? './var/kyc-documents');
  const storage = new LocalDiskStorage(root, key);
  console.log(`storage root : ${root}`);
  console.log(`encryption   : ${key ? 'AES-256-GCM' : 'NONE (dev only)'}`);

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 2,
  });

  const { rows } = await pool.query<{
    id: string;
    account_id: string | null;
    wallet: string | null;
    filename: string;
    content: string;
  }>(`SELECT id, account_id, wallet, filename, content
        FROM kyc_documents
       WHERE content IS NOT NULL AND storage_key IS NULL
       ORDER BY id`);

  console.log(`pending      : ${rows.length} document(s)\n`);
  if (rows.length === 0) return void (await pool.end());

  if (!confirm) {
    for (const r of rows) {
      console.log(`  would move id=${r.id} account=${r.account_id ?? '(none)'} ${r.filename}`);
    }
    console.log('\nDRY RUN — re-run with --confirm to move them.');
    return void (await pool.end());
  }

  let moved = 0;
  let skipped = 0;
  for (const r of rows) {
    /* Keyed by account so "delete everything for this person" stays a directory
       removal. A document with no account has no owner to key by. */
    if (!r.account_id) {
      console.log(`  SKIP id=${r.id} — no linked account (wallet ${r.wallet ?? 'unknown'})`);
      skipped++;
      continue;
    }

    const data = Buffer.from(r.content, 'base64');
    const stored = await storage.put(data, { accountId: r.account_id, filename: r.filename });

    /* Read back and compare before dropping the only other copy. */
    const roundTrip = await storage.get(stored.key);
    const check = createHash('sha256').update(roundTrip).digest('hex');
    if (check !== stored.sha256) {
      throw new Error(`id=${r.id}: round-trip hash mismatch — refusing to clear content`);
    }

    await pool.query(
      `UPDATE kyc_documents
          SET content = NULL, storage_backend = $2, storage_key = $3, sha256 = $4, encrypted = $5
        WHERE id = $1`,
      [r.id, storage.name, stored.key, stored.sha256, stored.encrypted],
    );
    console.log(`  moved id=${r.id} -> ${stored.key} (${stored.sizeBytes} bytes)`);
    moved++;
  }

  console.log(`\nmoved ${moved}, skipped ${skipped}`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error('[documents] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
