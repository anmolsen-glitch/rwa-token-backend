/**
 * Mirrors migrations/044 — the reliance record.
 *
 * KYC is performed once by the platform; each issuer records its own acceptance
 * decision here rather than re-verifying (TENANCY_MODEL.md §D2, §5).
 *
 * Keyed on accounts.id, not a wallet: one person may link several wallets, and
 * acceptance is a decision about the person.
 */
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { bigintId } from './columns';

export const issuerInvestorAcceptance = pgTable(
  'issuer_investor_acceptance',
  {
    issuerId: bigintId('issuer_id').notNull(),
    investorId: bigintId('investor_id').notNull(),
    status: text('status').notNull().default('accepted'),
    kycVersion: bigintId('kyc_version').notNull(),
    decidedBy: bigintId('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
  (t) => [primaryKey({ columns: [t.issuerId, t.investorId] })],
);

export type Acceptance = typeof issuerInvestorAcceptance.$inferSelect;
export type AcceptanceStatus = 'accepted' | 'rejected' | 'pending_review';
