/** Mirrors migrations/011_issuers.sql — the tenant root. */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const issuers = pgTable('issuers', {
  /* BIGSERIAL — the sequence is the default, so id is optional on insert. */
  id: bigintId('id').primaryKey().default(sql`nextval('issuers_id_seq'::regclass)`),
  name: text('name').notNull(),
  legalEntity: text('legal_entity'),
  contactEmail: text('contact_email'),
  ownerWallet: text('owner_wallet'),
  /** Operator-entered identifier for the vehicle; distinct from the CIN. */
  spvId: text('spv_id'),
  /** One of the closed SPV legal forms (Private Limited, LLP, Trust, ...). */
  spvType: text('spv_type'),
  kybStatus: text('kyb_status').notNull().default('pending_review'),
  /* migration 047 — per-issuer reliance policy (TENANCY_MODEL §9). */
  acceptancePolicy: text('acceptance_policy').notNull().default('auto_accept'),
  kybNote: text('kyb_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Issuer = typeof issuers.$inferSelect;
export type NewIssuer = typeof issuers.$inferInsert;
