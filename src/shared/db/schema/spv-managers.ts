/**
 * SPV managers — the layer between the platform operator and per-property
 * managers.
 *
 * Belongs to exactly ONE issuer and oversees that SPV's property managers
 * (`managers.spvManagerId`). `adminId` is the seam for a scoped login: the
 * 'spv_manager' role already exists in the admins CHECK, but no login is wired
 * yet, so today these are profiles plus an authority boundary.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const spvManagers = pgTable('spv_managers', {
  id: bigintId('id').primaryKey().default(sql`nextval('spv_managers_id_seq'::regclass)`),
  issuerId: bigintId('issuer_id').notNull(),
  name: text('name').notNull(),
  company: text('company'),
  contactEmail: text('contact_email'),
  phone: text('phone'),
  /** 'active' | 'suspended' */
  status: text('status').notNull().default('active'),
  adminId: bigintId('admin_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SpvManager = typeof spvManagers.$inferSelect;
