/**
 * Mirrors migrations/001_init.sql + 008/014/019/024/026/027/033 + 044.
 *
 * PII LIVES HERE. Never select this table directly from a service — go through
 * InvestorsService, which writes an audit row for every issuer-side read
 * (TENANCY_MODEL.md §5.2).
 *
 * The table is platform-global (one person, one row, shared across issuers),
 * but READ ACCESS is restricted to an issuer's own cap table by the RLS policy
 * in migration 044.
 */
import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { bigintId } from './columns';

export const investors = pgTable('investors', {
  wallet: text('wallet').primaryKey(),
  accountId: bigintId('account_id'),
  onchainid: text('onchainid'),
  country: integer('country'),
  name: text('name'),
  email: text('email'),
  kycStatus: text('kyc_status').notNull(),
  kycNote: text('kyc_note'),
  kycProvider: text('kyc_provider'),
  kycRef: text('kyc_ref'),
  kycDetails: jsonb('kyc_details'),
  kycSubmittedAt: timestamp('kyc_submitted_at', { withTimezone: true }),
  kycRejectedAt: timestamp('kyc_rejected_at', { withTimezone: true }),
  kycVersion: bigintId('kyc_version').notNull(),
  /* Mirrors of the account-level values (migration 047), written only so the
     Express app keeps working. accounts.* is the source of truth. */
  amlStatus: text('aml_status'),
  accreditationStatus: text('accreditation_status'),
  accreditationNote: text('accreditation_note'),
  verified: boolean('verified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Investor = typeof investors.$inferSelect;
