/** Mirrors migrations/006_investor_auth.sql + 023 (issued_at). */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const investorNonces = pgTable('investor_nonces', {
  address: text('address').primaryKey(),
  nonce: text('nonce').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type InvestorNonce = typeof investorNonces.$inferSelect;
