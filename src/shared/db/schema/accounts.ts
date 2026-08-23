/**
 * Mirrors migrations/024_accounts.sql + 025 + 045.
 *
 * `accounts` is THE PERSON. It is the subject of:
 *   - KYC verification (migration 045),
 *   - issuer acceptance decisions (issuer_investor_acceptance.investor_id),
 *   - login/session identity.
 *
 * `investors` is the WALLET-level record (ONCHAINID, on-chain verified flag).
 * One person may link several wallets; they do not thereby acquire several
 * identities, several KYC states, or several countries.
 */
import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const accounts = pgTable('accounts', {
  /* BIGSERIAL — the sequence IS the default, so declaring it makes the field
     optional on insert instead of forcing callers to invent an id. */
  id: bigintId('id').primaryKey().default(sql`nextval('accounts_id_seq'::regclass)`),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  emailVerified: boolean('email_verified').notNull().default(false),

  /* KYC — the person's, not a wallet's (migration 045). */
  kycStatus: text('kyc_status').notNull().default('none'),
  kycNote: text('kyc_note'),
  kycSubmittedAt: timestamp('kyc_submitted_at', { withTimezone: true }),
  kycRejectedAt: timestamp('kyc_rejected_at', { withTimezone: true }),
  kycVersion: bigintId('kyc_version').notNull().default('1'),
  country: integer('country'),

  /* Aggregate across every wallet the person controls — the WORST decision
     (migration 047). Individual screenings stay per-wallet in aml_screenings. */
  amlStatus: text('aml_status').notNull().default('unscreened'),

  /* 'accredited' unlocks accredited-only offerings and the higher cap. */
  accreditationStatus: text('accreditation_status').notNull().default('none'),
  accreditationNote: text('accreditation_note'),
  accreditationDecidedAt: timestamp('accreditation_decided_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Account = typeof accounts.$inferSelect;

/** The investor journey, in order. Drives the client's progress UI. */
export type OnboardingStep = 'signup' | 'verify_email' | 'kyc' | 'connect_wallet' | 'ready';
