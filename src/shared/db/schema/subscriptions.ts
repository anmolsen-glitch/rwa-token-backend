/**
 * Mirrors migrations/007_payments.sql + 018/022 (escrow status widening).
 *
 * A DUAL-AXIS table: this row is "my investment" to the investor and "my cap
 * table" to the issuer (TENANCY_MODEL.md §2.4). Scoping depends on which axis
 * the caller sits on, which is why the RLS policy has two branches.
 *
 * Money columns are NUMERIC and read as strings. Never parse them into a JS
 * number.
 */
import { integer, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const subscriptions = pgTable('subscriptions', {
  id: bigintId('id').primaryKey().default(sql`nextval('subscriptions_id_seq'::regclass)`),
  reference: text('reference').notNull(),
  wallet: text('wallet').notNull(),
  offeringId: text('offering_id').notNull(),
  tokenSymbol: text('token_symbol').notNull(),
  amountFiat: numeric('amount_fiat').notNull(),
  currency: text('currency').notNull(),
  pricePerToken: numeric('price_per_token').notNull(),
  tokens: integer('tokens').notNull(),
  status: text('status').notNull(),
  paymentProvider: text('payment_provider').notNull(),
  paymentRef: text('payment_ref'),
  txHash: text('tx_hash'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Subscription = typeof subscriptions.$inferSelect;
