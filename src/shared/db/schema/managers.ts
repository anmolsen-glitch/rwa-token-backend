/**
 * Property managers — the firm that OPERATES an asset day to day.
 *
 * Two things in one row: a public profile investors see on the asset page, and
 * an optional login (`adminId` -> an `admins` row with role 'manager') giving a
 * scoped portal over only that manager's properties.
 *
 * Issuer-owned since migration 053. `spvManagerId` is the layer above — a
 * person overseeing one issuer's managers — kept nullable because a manager can
 * be assigned directly with nobody in between.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const managers = pgTable('managers', {
  id: bigintId('id').primaryKey().default(sql`nextval('managers_id_seq'::regclass)`),
  issuerId: bigintId('issuer_id').notNull(),
  name: text('name').notNull(),
  company: text('company'),
  bio: text('bio'),
  logoUrl: text('logo_url'),
  contactEmail: text('contact_email'),
  /** 'active' | 'suspended' */
  status: text('status').notNull().default('active'),
  /** The manager's portal login, if one was created. */
  adminId: bigintId('admin_id'),
  spvManagerId: bigintId('spv_manager_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Manager = typeof managers.$inferSelect;
