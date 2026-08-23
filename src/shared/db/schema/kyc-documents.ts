/**
 * Mirrors migrations/026_kyc_lifecycle.sql + 046.
 *
 * `content` (legacy base64) and `storageKey` are mutually exclusive — enforced
 * by a CHECK constraint. New uploads always take the storage path; the column
 * remains only until the Express routes that read it are deleted.
 */
import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const kycDocuments = pgTable('kyc_documents', {
  id: bigintId('id').primaryKey().default(sql`nextval('kyc_documents_id_seq'::regclass)`),
  accountId: bigintId('account_id'),
  /** Nullable since migration 046 — documents arrive before a wallet exists. */
  wallet: text('wallet'),
  docType: text('doc_type').notNull(),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  content: text('content'),
  storageBackend: text('storage_backend'),
  storageKey: text('storage_key'),
  sha256: text('sha256'),
  encrypted: boolean('encrypted').notNull().default(false),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});

export type KycDocument = typeof kycDocuments.$inferSelect;
