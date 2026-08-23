/** Mirrors migrations/005_approvals.sql + 012 (case_id). */
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const operationRequests = pgTable('operation_requests', {
  id: bigintId('id').primaryKey().default(sql`nextval('operation_requests_id_seq'::regclass)`),
  action: text('action').notNull(),
  tokenSymbol: text('token_symbol'),
  params: jsonb('params').notNull(),
  requiredRole: text('required_role').notNull(),
  approvalsRequired: integer('approvals_required').notNull(),
  status: text('status').notNull().default('pending'),
  requestedBy: bigintId('requested_by').notNull(),
  requestedByEmail: text('requested_by_email'),
  txHash: text('tx_hash'),
  error: text('error'),
  decidedNote: text('decided_note'),
  caseId: bigintId('case_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const operationApprovals = pgTable(
  'operation_approvals',
  {
    operationId: bigintId('operation_id').notNull(),
    approverId: bigintId('approver_id').notNull(),
    approverEmail: text('approver_email'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.approverId] })],
);

export type OperationRequest = typeof operationRequests.$inferSelect;
export type OperationApproval = typeof operationApprovals.$inferSelect;
