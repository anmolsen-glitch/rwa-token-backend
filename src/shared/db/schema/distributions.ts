/**
 * Income distributions — rent/dividend payouts.
 *
 * `distributions` is the declaration; `distributionClaims` is one row per
 * holder, allocated pro-rata at declaration time and then claimed. The
 * allocation is a SNAPSHOT: selling afterwards does not change what you were
 * owed for the period the payout covers.
 */
import { numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const distributions = pgTable('distributions', {
  id: bigintId('id').primaryKey().default(sql`nextval('distributions_id_seq'::regclass)`),
  tokenSymbol: text('token_symbol').notNull(),
  totalAmount: numeric('total_amount').notNull(),
  currency: text('currency').notNull().default('INR'),
  note: text('note'),
  declaredByEmail: text('declared_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const distributionClaims = pgTable('distribution_claims', {
  id: bigintId('id').primaryKey().default(sql`nextval('distribution_claims_id_seq'::regclass)`),
  distributionId: bigintId('distribution_id').notNull(),
  wallet: text('wallet').notNull(),
  amount: numeric('amount').notNull(),
  /** 'claimable' | 'claimed' */
  status: text('status').notNull().default('claimable'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
});

export type Distribution = typeof distributions.$inferSelect;
export type DistributionClaim = typeof distributionClaims.$inferSelect;
