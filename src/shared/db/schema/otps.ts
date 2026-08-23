/** Mirrors migrations/025_account_verification.sql. */
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const accountOtps = pgTable(
  'account_otps',
  {
    email: text('email').notNull(),
    /** 'verify' | 'reset' */
    purpose: text('purpose').notNull(),
    code: text('code').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.email, t.purpose] })],
);

export type AccountOtp = typeof accountOtps.$inferSelect;
export type OtpPurpose = 'verify' | 'reset';
