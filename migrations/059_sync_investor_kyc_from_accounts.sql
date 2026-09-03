-- Mirror person-level KYC/accreditation onto linked wallet rows.
-- accounts is authoritative (migration 045); investors.kyc_* is a legacy mirror
-- that goes stale when KYC is approved after wallet link.

UPDATE investors i
   SET kyc_status            = a.kyc_status,
       kyc_note              = a.kyc_note,
       kyc_submitted_at      = a.kyc_submitted_at,
       kyc_rejected_at       = a.kyc_rejected_at,
       kyc_version           = a.kyc_version,
       kyc_details           = a.kyc_details,
       country               = COALESCE(a.country, i.country),
       aml_status            = a.aml_status,
       accreditation_status  = a.accreditation_status,
       accreditation_note    = a.accreditation_note,
       updated_at            = now()
  FROM accounts a
 WHERE i.account_id = a.id
   AND (
     i.kyc_status IS DISTINCT FROM a.kyc_status
     OR i.kyc_version IS DISTINCT FROM a.kyc_version
     OR i.accreditation_status IS DISTINCT FROM a.accreditation_status
   );
