/**
 * Legal cases — the off-chain order behind a privileged action.
 *
 * A freeze, burn or forced transfer references a case, so this table is the
 * answer to "why did you move someone else's tokens". Issuer-owned since
 * migration 057.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const legalCases = pgTable('legal_cases', {
  id: bigintId('id').primaryKey().default(sql`nextval('legal_cases_id_seq'::regclass)`),
  issuerId: bigintId('issuer_id').notNull(),
  reference: text('reference').notNull(),
  /** court_order | sanctions | fraud | recovery | dispute | other */
  type: text('type').notNull(),
  subjectWallet: text('subject_wallet'),
  description: text('description'),
  documentUrl: text('document_url'),
  /** 'open' | 'closed' */
  status: text('status').notNull().default('open'),
  openedBy: bigintId('opened_by'),
  openedByEmail: text('opened_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export type LegalCase = typeof legalCases.$inferSelect;
