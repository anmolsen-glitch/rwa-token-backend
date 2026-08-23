/**
 * Mirrors migrations/039_tokens.sql + 043 (network dimension).
 *
 * The authoritative token -> issuer map. `src/lib/config.ts` in the Express repo
 * reads the same facts from the deployed-addresses.json address book, but that
 * file is a bootstrap source; this table is the source of truth.
 *
 * Keyed by (network, symbol): the same symbol legitimately exists on localhost
 * and sepolia with different addresses.
 */
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { bigintId } from './columns';

export const tokens = pgTable(
  'tokens',
  {
    network: text('network').notNull(),
    symbol: text('symbol').notNull(),
    issuerId: bigintId('issuer_id').notNull(),
    address: text('address').notNull(),
    onchainid: text('onchainid'),
    deployedAt: timestamp('deployed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.network, t.symbol] })],
);

export type Token = typeof tokens.$inferSelect;
