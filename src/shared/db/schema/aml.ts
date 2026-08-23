/**
 * Mirrors migrations/027_aml_screening.sql.
 *
 * APPEND-ONLY evidence. Rows are never updated or deleted: a screening is what
 * the provider said at a point in time, and ongoing monitoring re-screens by
 * inserting, not by overwriting. Deliberately still keyed by wallet — an
 * address is what a provider actually screens.
 */
import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const amlScreenings = pgTable('aml_screenings', {
  id: bigintId('id').primaryKey().default(sql`nextval('aml_screenings_id_seq'::regclass)`),
  wallet: text('wallet').notNull(),
  /** The person's primary wallet, as recorded at screening time. */
  person: text('person').notNull(),
  provider: text('provider').notNull(),
  reference: text('reference'),
  riskScore: integer('risk_score').notNull(),
  riskLevel: text('risk_level').notNull(),
  sanctioned: boolean('sanctioned').notNull().default(false),
  categories: jsonb('categories'),
  decision: text('decision').notNull(),
  raw: jsonb('raw'),
  screenedBy: text('screened_by'),
  screenedAt: timestamp('screened_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AmlScreening = typeof amlScreenings.$inferSelect;
