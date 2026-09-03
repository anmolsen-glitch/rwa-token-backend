-- KYC metadata (doc types, AML declarations) belongs to the person, same as
-- kyc_status. Documents themselves live in kyc_documents; this holds the
-- structured fields the reviewer UI reads (docType, addressDocType, aml).

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kyc_details JSONB NOT NULL DEFAULT '{}'::jsonb;
