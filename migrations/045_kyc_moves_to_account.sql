-- KYC becomes a property of the PERSON, not of a wallet.
--
-- WHY. The investor flow is: sign up -> KYC -> connect wallet. KYC therefore has
-- to exist BEFORE any wallet does, but today every kyc_* column lives on
-- `investors`, whose primary key IS the wallet. There is literally nowhere to
-- record the KYC of someone who has not connected a wallet yet — and the live
-- data already shows one such account.
--
-- It also fixes an inconsistency: issuer_investor_acceptance.investor_id
-- references accounts(id), so an issuer's reliance decision is about a PERSON,
-- but the kyc_version it pins was read off a wallet-keyed row. Subject and
-- version must be the same thing or staleness (TENANCY_MODEL.md §5.3) compares
-- across two different identities.
--
-- STRANGLER CONSTRAINT: the Express app still reads investors.kyc_status. These
-- columns are therefore ADDED, not moved — investors.kyc_* stays and the Nest
-- KYC repository dual-writes both until the Express KYC routes are deleted.
-- accounts is the source of truth from now on.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'none'
  CHECK (kyc_status IN ('none', 'applied', 'verifying', 'completed', 'rejected'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kyc_note         TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kyc_rejected_at  TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kyc_version      BIGINT NOT NULL DEFAULT 1;

-- Identity fields collected during KYC. They belong to the person too — a
-- second wallet does not give someone a second name or country.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS country INTEGER;

CREATE INDEX IF NOT EXISTS accounts_kyc_status_idx ON accounts (kyc_status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Backfill from the wallet-keyed rows.
--
-- Only linked rows can be carried over (account_id IS NOT NULL). The 3 orphan
-- wallets have no person to attach to and are deliberately left alone rather
-- than guessed at — an unlinked wallet's KYC is not attributable to anyone.
-- ---------------------------------------------------------------------------

UPDATE accounts a
   SET kyc_status      = i.kyc_status,
       kyc_note        = i.kyc_note,
       kyc_submitted_at= i.kyc_submitted_at,
       kyc_rejected_at = i.kyc_rejected_at,
       kyc_version     = i.kyc_version,
       country         = COALESCE(a.country, i.country),
       updated_at      = now()
  FROM investors i
 WHERE i.account_id = a.id
   AND i.kyc_status IS NOT NULL
   AND a.kyc_status = 'none';   -- never clobber a decision already recorded here

-- Report what could not be carried over, so it is visible rather than silent.
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM investors WHERE account_id IS NULL;
  IF orphans > 0 THEN
    RAISE NOTICE 'kyc backfill: % wallet(s) have no linked account; their KYC was NOT migrated', orphans;
  END IF;
END $$;
