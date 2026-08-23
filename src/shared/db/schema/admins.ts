/**
 * Mirrors migrations/002_auth.sql, plus the tenancy column added by the planned
 * migration 040 (TENANCY_MODEL.md §4.2).
 *
 * `issuerId` is nullable in the type because migration 040 lands additively —
 * it becomes NOT NULL for non-platform roles only after the backfill (§6 step
 * 8). Until then, treat a null issuerId on a non-platform admin as a hard error
 * at the guard, not as "sees everything".
 */
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const admins = pgTable('admins', {
  id: bigintId('id').primaryKey().default(sql`nextval('admins_id_seq'::regclass)`),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  role: text('role').notNull(),
  issuerId: bigintId('issuer_id'),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Admin = typeof admins.$inferSelect;
