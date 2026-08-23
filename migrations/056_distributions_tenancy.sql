-- Income distributions come under tenancy.
--
-- A distribution is a rent/dividend payout declared for one asset and allocated
-- pro-rata to whoever held the token at declaration time. Two tables:
--
--   distributions        the declaration (asset, total, note)
--   distribution_claims  one row per holder — their share, claimable then claimed
--
-- Scope path: distributions.token_symbol -> tokens.issuer_id. `tokens` is keyed
-- by (symbol, network), and the symbol alone is what `distributions` carries, so
-- the join below deliberately does NOT pin a network: the same symbol on two
-- networks would belong to the same issuer anyway (tokens.issuer_id is set at
-- deploy), and pinning it would silently hide a distribution after a network
-- switch. If symbols ever become reusable ACROSS issuers this has to change —
-- but then so does every other lookup by symbol in the app.

/* ---- distributions: issuer declares, investor reads ---------------------- */
ALTER TABLE distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributions FORCE  ROW LEVEL SECURITY;

-- Investors may read declarations: "this asset paid out X on this date" is what
-- makes a claim checkable by the person receiving it.
DROP POLICY IF EXISTS distributions_read ON distributions;
CREATE POLICY distributions_read ON distributions FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR app_is_investor()
    OR EXISTS (
      SELECT 1 FROM tokens t
       WHERE upper(t.symbol) = upper(distributions.token_symbol)
         AND t.issuer_id::text = app_current_issuer()
    )
  );

DROP POLICY IF EXISTS distributions_write ON distributions;
CREATE POLICY distributions_write ON distributions FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM tokens t
       WHERE upper(t.symbol) = upper(distributions.token_symbol)
         AND t.issuer_id::text = app_current_issuer()
    )
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM tokens t
       WHERE upper(t.symbol) = upper(distributions.token_symbol)
         AND t.issuer_id::text = app_current_issuer()
    )
  );

GRANT SELECT, INSERT, UPDATE ON distributions TO app_tenant;

/* ---- distribution_claims: DUAL-AXIS -------------------------------------- */
-- Same shape as subscriptions and buyback_sales: a holder matches on their own
-- wallet across every issuer, an issuer matches through the asset across every
-- holder. Neither sees the other's side.
ALTER TABLE distribution_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE distribution_claims FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS distribution_claims_read ON distribution_claims;
CREATE POLICY distribution_claims_read ON distribution_claims FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR lower(wallet) = lower(COALESCE(app_current_investor(), ''))
    OR EXISTS (
      SELECT 1 FROM distributions d JOIN tokens t
              ON upper(t.symbol) = upper(d.token_symbol)
       WHERE d.id = distribution_claims.distribution_id
         AND t.issuer_id::text = app_current_issuer()
    )
  );

-- The ISSUER creates the claims (allocation happens when they declare).
DROP POLICY IF EXISTS distribution_claims_issuer_write ON distribution_claims;
CREATE POLICY distribution_claims_issuer_write ON distribution_claims FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM distributions d JOIN tokens t
              ON upper(t.symbol) = upper(d.token_symbol)
       WHERE d.id = distribution_claims.distribution_id
         AND t.issuer_id::text = app_current_issuer()
    )
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM distributions d JOIN tokens t
              ON upper(t.symbol) = upper(d.token_symbol)
       WHERE d.id = distribution_claims.distribution_id
         AND t.issuer_id::text = app_current_issuer()
    )
  );

-- The INVESTOR marks their own claims claimed. UPDATE only — they must never be
-- able to INSERT a claim (that would be minting themselves a payout) or DELETE
-- one (a settled payout is a financial record). Same lesson as migrations 050,
-- 052 and 054: name the party who WRITES the row, and give them the narrowest
-- verb that does the job.
DROP POLICY IF EXISTS distribution_claims_investor_claim ON distribution_claims;
CREATE POLICY distribution_claims_investor_claim ON distribution_claims FOR UPDATE TO app_tenant
  USING      (lower(wallet) = lower(COALESCE(app_current_investor(), '')))
  WITH CHECK (lower(wallet) = lower(COALESCE(app_current_investor(), '')));

REVOKE DELETE ON distribution_claims FROM app_tenant;
GRANT SELECT, INSERT, UPDATE ON distribution_claims TO app_tenant;

-- Claims are always read by wallet or by distribution; neither had an index.
CREATE INDEX IF NOT EXISTS distribution_claims_wallet_idx
  ON distribution_claims (lower(wallet), status);
CREATE INDEX IF NOT EXISTS distribution_claims_distribution_idx
  ON distribution_claims (distribution_id);
