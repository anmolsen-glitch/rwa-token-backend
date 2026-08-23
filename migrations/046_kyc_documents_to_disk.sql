-- KYC documents: off the database, onto disk — and keyed to the PERSON.
--
-- TWO PROBLEMS, one migration.
--
-- 1. STORAGE. `content` holds base64 in Postgres (~33% inflation on top of
--    already-large scans). Measured: 10 documents = 8.5 MB. That is survivable
--    on a dev database and wrong everywhere: identity documents bloat every
--    backup, every replica, and every SELECT * that forgets to exclude the
--    column. Files move to a storage backend; the row keeps only metadata plus
--    a key.
--
-- 2. SUBJECT. The table is keyed by `wallet`, but migration 045 moved KYC to
--    the PERSON because the flow is sign up -> KYC -> connect wallet. Documents
--    are uploaded during KYC, when there is no wallet yet. Without account_id
--    an uploaded passport has nowhere to attach.
--
-- Additive: `content` becomes nullable and stays, so the Express app keeps
-- serving existing documents until its routes are deleted. Rows migrated to
-- disk have content = NULL and storage_key set.

-- 1. The person this document belongs to.
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id);
CREATE INDEX IF NOT EXISTS kyc_documents_account_idx ON kyc_documents (account_id, uploaded_at DESC);

-- `wallet` becomes optional: documents now arrive before a wallet exists.
ALTER TABLE kyc_documents ALTER COLUMN wallet DROP NOT NULL;

-- 2. Where the bytes actually live.
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS storage_backend TEXT;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS storage_key     TEXT;

-- Integrity: lets a later audit prove a file on disk is the one that was
-- uploaded, and detects silent corruption or tampering.
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS sha256 TEXT;

-- Marks a file written with application-level encryption, so a future key
-- rotation can find exactly which rows need re-wrapping.
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;

-- 3. Bytes may now live on disk instead of in the row.
ALTER TABLE kyc_documents ALTER COLUMN content DROP NOT NULL;

-- Exactly one home: either inline base64 (legacy) or a storage key. Never both,
-- never neither — "neither" is a document that silently cannot be retrieved.
ALTER TABLE kyc_documents DROP CONSTRAINT IF EXISTS kyc_documents_one_home_ck;
ALTER TABLE kyc_documents ADD CONSTRAINT kyc_documents_one_home_ck CHECK (
  (content IS NOT NULL AND storage_key IS NULL) OR
  (content IS NULL     AND storage_key IS NOT NULL)
);

-- 4. Backfill account_id from the wallet, where a link exists. Documents whose
--    wallet has no account are left for a human — inventing an owner for an
--    identity document is the one guess never worth making.
UPDATE kyc_documents d
   SET account_id = i.account_id
  FROM investors i
 WHERE lower(i.wallet) = lower(d.wallet)
   AND i.account_id IS NOT NULL
   AND d.account_id IS NULL;

DO $$
DECLARE unowned INT;
BEGIN
  SELECT count(*) INTO unowned FROM kyc_documents WHERE account_id IS NULL;
  IF unowned > 0 THEN
    RAISE NOTICE 'kyc_documents: % document(s) have no linked account and were NOT re-keyed', unowned;
  END IF;
END $$;
