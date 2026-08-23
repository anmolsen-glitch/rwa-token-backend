/**
 * Mirrors migrations/010_wallets.sql.
 *
 * One PERSON may link several wallets. `primary_wallet` is the identity anchor:
 * KYC, the ONCHAINID, and acceptance decisions all hang off it, never off a
 * secondary address.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const wallets = pgTable('wallets', {
  address: text('address').primaryKey(),
  primaryWallet: text('primary_wallet').notNull(),
  screening: text('screening').notNull().default('clear'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Wallet = typeof wallets.$inferSelect;
