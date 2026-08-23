/**
 * Indexer persistence — SQL ported VERBATIM from
 * ../rwa-token-backend/src/lib/db/index.ts.
 *
 * These statements are the hardened part: idempotent transfer application,
 * reorg rewind that reverses balance deltas in the right direction, and the
 * block-hash ledger that finds a fork point. They are written as raw SQL rather
 * than rebuilt in the query builder precisely so a reader can diff them against
 * the Express originals line by line.
 *
 * Everything runs on db.worker(): the indexer is cross-tenant by definition —
 * it writes `balances` and `transfers` for every issuer's tokens — and those
 * tables are under RLS with NO app_tenant write policy, so only the BYPASSRLS
 * worker connection can write them at all.
 */
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService, type Tx } from '@shared/db/db.service';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface IndexerState {
  token: string;
  symbol: string;
  decimals: number;
  lastIndexedBlock: number;
  lastIndexedHash: string | null;
  chainBehindSince: string | null;
}

export interface TransferInput {
  from: string;
  to: string;
  value: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: number;
}

/** drizzle's execute() returns a driver result; normalise to rows. */
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const r = (res as { rows?: T[] }).rows;
  return r ?? [];
}

@Injectable()
export class IndexerRepository {
  constructor(private readonly db: DbService) {}

  private run<T>(reason: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.worker(`indexer: ${reason}`, fn);
  }

  async getState(token: string): Promise<IndexerState | null> {
    const rows = await this.run('load state', async (tx) =>
      rowsOf<Record<string, unknown>>(
        await tx.execute(sql`SELECT * FROM indexer_state WHERE token = ${token.toLowerCase()}`),
      ),
    );
    const r = rows[0];
    if (!r) return null;
    /* pg returns BIGINT as a string — coerce so callers do arithmetic, not
       string concatenation (the original bug this comment guards). */
    return {
      token: String(r.token),
      symbol: String(r.symbol),
      decimals: Number(r.decimals),
      lastIndexedBlock: Number(r.last_indexed_block),
      lastIndexedHash: (r.last_indexed_hash as string) ?? null,
      chainBehindSince: r.chain_behind_since ? String(r.chain_behind_since) : null,
    };
  }

  async upsertState(s: {
    token: string;
    symbol: string;
    decimals: number;
    lastIndexedBlock: number;
  }): Promise<void> {
    await this.run('upsert state', async (tx) => {
      await tx.execute(sql`
        INSERT INTO indexer_state (token, symbol, decimals, last_indexed_block)
        VALUES (${s.token.toLowerCase()}, ${s.symbol}, ${s.decimals}, ${s.lastIndexedBlock})
        ON CONFLICT (token) DO UPDATE
          SET symbol = EXCLUDED.symbol, decimals = EXCLUDED.decimals
      `);
    });
  }

  async setLastIndexedBlock(token: string, block: number, hash: string | null): Promise<void> {
    await this.run('set cursor', async (tx) => {
      await tx.execute(sql`
        UPDATE indexer_state SET last_indexed_block = ${block}, last_indexed_hash = ${hash}
         WHERE token = ${token.toLowerCase()}
      `);
    });
  }

  /**
   * Apply a chunk of transfers. ONE transaction, idempotent.
   *
   * The `rowCount === 0 -> continue` is load-bearing: the transfers table's
   * (tx_hash, log_index) key makes the insert a no-op on a replay, and skipping
   * the balance update in that case is what stops an overlapping range from
   * double-counting a holding.
   */
  async applyTransfers(token: string, events: TransferInput[]): Promise<void> {
    if (events.length === 0) return;
    const tk = token.toLowerCase();

    await this.run('apply transfers', async (tx) => {
      for (const ev of events) {
        const from = ev.from.toLowerCase();
        const to = ev.to.toLowerCase();
        const kind = from === ZERO ? 'mint' : to === ZERO ? 'burn' : 'transfer';
        const value = ev.value.toString();

        const res = await tx.execute(sql`
          INSERT INTO transfers (token, tx_hash, log_index, block_number, from_addr, to_addr, value, kind)
          VALUES (${tk}, ${ev.txHash}, ${ev.logIndex}, ${ev.blockNumber}, ${from}, ${to}, ${value}, ${kind})
          ON CONFLICT (tx_hash, log_index) DO NOTHING
          RETURNING tx_hash
        `);
        if (rowsOf(res).length === 0) continue; // already processed — do NOT re-apply

        if (from !== ZERO) {
          await tx.execute(sql`
            INSERT INTO balances (token, address, balance) VALUES (${tk}, ${from}, -${value}::numeric)
            ON CONFLICT (token, address) DO UPDATE SET balance = balances.balance - ${value}::numeric
          `);
        }
        if (to !== ZERO) {
          await tx.execute(sql`
            INSERT INTO balances (token, address, balance) VALUES (${tk}, ${to}, ${value}::numeric)
            ON CONFLICT (token, address) DO UPDATE SET balance = balances.balance + ${value}::numeric
          `);
        }
      }
    });
  }

  /**
   * Rewind past a reorg: reverse every balance delta above `block`, drop those
   * transfers, and move the cursor back.
   *
   * Note the directions are INVERTED relative to applyTransfers — the sender is
   * credited back and the receiver debited. Getting this backwards silently
   * doubles the error instead of undoing it.
   */
  async rewindToBlock(token: string, block: number): Promise<void> {
    const tk = token.toLowerCase();
    await this.run('rewind', async (tx) => {
      const rows = rowsOf<{ from_addr: string; to_addr: string; value: string }>(
        await tx.execute(sql`
          SELECT from_addr, to_addr, value FROM transfers
           WHERE token = ${tk} AND block_number > ${block}
        `),
      );
      for (const ev of rows) {
        if (ev.from_addr !== ZERO) {
          await tx.execute(sql`
            UPDATE balances SET balance = balance + ${ev.value}::numeric
             WHERE token = ${tk} AND address = ${ev.from_addr}
          `);
        }
        if (ev.to_addr !== ZERO) {
          await tx.execute(sql`
            UPDATE balances SET balance = balance - ${ev.value}::numeric
             WHERE token = ${tk} AND address = ${ev.to_addr}
          `);
        }
      }
      await tx.execute(sql`DELETE FROM transfers WHERE token = ${tk} AND block_number > ${block}`);
      await tx.execute(sql`
        UPDATE indexer_state SET last_indexed_block = ${block}, last_indexed_hash = NULL
         WHERE token = ${tk}
      `);
    });
  }

  async recordBlockHash(token: string, block: number, hash: string, keepDepth: number): Promise<void> {
    const tk = token.toLowerCase();
    await this.run('record block hash', async (tx) => {
      await tx.execute(sql`
        INSERT INTO indexer_block_hashes (token, block_number, hash) VALUES (${tk}, ${block}, ${hash})
        ON CONFLICT (token, block_number) DO UPDATE SET hash = EXCLUDED.hash
      `);
      await tx.execute(sql`
        DELETE FROM indexer_block_hashes WHERE token = ${tk} AND block_number < ${block - keepDepth}
      `);
    });
  }

  async recentBlockHashes(token: string, limit: number): Promise<Array<{ block: number; hash: string }>> {
    const rows = await this.run('recent block hashes', async (tx) =>
      rowsOf<{ block_number: string; hash: string }>(
        await tx.execute(sql`
          SELECT block_number, hash FROM indexer_block_hashes
           WHERE token = ${token.toLowerCase()}
           ORDER BY block_number DESC LIMIT ${limit}
        `),
      ),
    );
    return rows.map((r) => ({ block: Number(r.block_number), hash: r.hash }));
  }

  async pruneBlockHashesAbove(token: string, block: number): Promise<void> {
    await this.run('prune hashes above', async (tx) => {
      await tx.execute(sql`
        DELETE FROM indexer_block_hashes WHERE token = ${token.toLowerCase()} AND block_number > ${block}
      `);
    });
  }

  async resetTokenData(token: string): Promise<void> {
    const tk = token.toLowerCase();
    await this.run('reset token data', async (tx) => {
      await tx.execute(sql`DELETE FROM balances WHERE token = ${tk}`);
      await tx.execute(sql`DELETE FROM transfers WHERE token = ${tk}`);
      await tx.execute(sql`DELETE FROM indexer_block_hashes WHERE token = ${tk}`);
      await tx.execute(sql`DELETE FROM indexer_state WHERE token = ${tk}`);
    });
  }

  async markChainBehind(token: string): Promise<void> {
    await this.run('mark chain behind', async (tx) => {
      await tx.execute(sql`
        UPDATE indexer_state SET chain_behind_since = now()
         WHERE token = ${token.toLowerCase()} AND chain_behind_since IS NULL
      `);
    });
  }

  async clearChainBehind(token: string): Promise<void> {
    await this.run('clear chain behind', async (tx) => {
      await tx.execute(sql`
        UPDATE indexer_state SET chain_behind_since = NULL
         WHERE token = ${token.toLowerCase()} AND chain_behind_since IS NOT NULL
      `);
    });
  }

  async holderCount(token: string): Promise<number> {
    const rows = await this.run('holder count', async (tx) =>
      rowsOf<{ c: number }>(
        await tx.execute(sql`
          SELECT COUNT(*)::int AS c FROM balances
           WHERE token = ${token.toLowerCase()} AND balance <> 0
        `),
      ),
    );
    return Number(rows[0]?.c ?? 0);
  }
}
