/** Mirrors migrations/003_audit.sql + 012 (case_id) + 044 (issuer_id). */
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const auditLog = pgTable('audit_log', {
  /* BIGSERIAL: the sequence IS the column default. Declaring it tells Drizzle
     the field is optional on insert — without this, every insert would have to
     invent an id. */
  id: bigintId('id').primaryKey().default(sql`nextval('audit_log_id_seq'::regclass)`),
  actorId: bigintId('actor_id'),
  actorEmail: text('actor_email'),
  actorRole: text('actor_role'),
  issuerId: bigintId('issuer_id'),
  action: text('action').notNull(),
  target: text('target'),
  params: jsonb('params').notNull(),
  status: text('status').notNull(),
  txHash: text('tx_hash'),
  error: text('error'),
  caseId: bigintId('case_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AuditRow = typeof auditLog.$inferSelect;
