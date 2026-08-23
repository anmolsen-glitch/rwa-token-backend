-- AML status and accreditation become properties of the PERSON.
--
-- Third instance of the same correction (see 045 for KYC, 046 for documents):
-- the flow is sign up -> KYC -> connect wallet, so anything about the PERSON
-- cannot live on a wallet-keyed row.
--
-- WHY EACH ONE MOVES:
--
--   accreditation — an "accredited investor" determination is about a human's
--   income/net worth, gated on KYC (which is now person-level). A second wallet
--   does not make someone accredited twice, and someone can legitimately be
--   accredited before connecting any wallet at all.
--
--   aml_status — the individual SCREENINGS remain per-wallet (that is what a
--   provider actually screens: an address's on-chain history). But the
--   AGGREGATE — the worst decision across every wallet a person controls — is a
--   statement about the person, and it is what gates KYC and onboarding.
--
-- aml_screenings is deliberately NOT changed: it is an append-only evidence
-- trail keyed by (wallet, person) and rewriting history has no upside.
--
-- Additive; investors.* stay for the Express app and are dual-written.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS aml_status TEXT NOT NULL DEFAULT 'unscreened'
  CHECK (aml_status IN ('unscreened', 'clear', 'review', 'blocked'));

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS accreditation_status TEXT NOT NULL DEFAULT 'none'
  CHECK (accreditation_status IN ('none', 'accredited', 'rejected'));

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS accreditation_note      TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS accreditation_decided_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS accounts_accreditation_idx ON accounts (accreditation_status);
CREATE INDEX IF NOT EXISTS accounts_aml_idx ON accounts (aml_status);

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- AML takes the WORST status across the person's wallets, matching the
-- aggregation rule: blocked > review > clear > unscreened. Taking any single
-- wallet's value would silently clear a person who has a blocked address.
-- ---------------------------------------------------------------------------

UPDATE accounts a
   SET aml_status = w.worst
  FROM (
    SELECT account_id,
           CASE
             WHEN bool_or(aml_status = 'blocked') THEN 'blocked'
             WHEN bool_or(aml_status = 'review')  THEN 'review'
             WHEN bool_or(aml_status = 'clear')   THEN 'clear'
             ELSE 'unscreened'
           END AS worst
      FROM investors
     WHERE account_id IS NOT NULL
     GROUP BY account_id
  ) w
 WHERE w.account_id = a.id
   AND a.aml_status = 'unscreened';

-- Accreditation: carry over any decision that was actually made ('none' is the
-- absence of a decision, so it must not overwrite one recorded here).
UPDATE accounts a
   SET accreditation_status = i.accreditation_status,
       accreditation_note   = i.accreditation_note
  FROM investors i
 WHERE i.account_id = a.id
   AND i.accreditation_status <> 'none'
   AND a.accreditation_status = 'none';

DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM investors WHERE account_id IS NULL;
  IF orphans > 0 THEN
    RAISE NOTICE 'aml/accreditation: % wallet(s) have no account; their status was NOT migrated', orphans;
  END IF;
END $$;
