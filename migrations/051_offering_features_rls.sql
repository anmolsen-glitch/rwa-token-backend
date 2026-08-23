-- Bring the offering-attached tables under tenancy.
--
-- Every one of these hangs off an offering, so the scope path is the same:
-- offering_id -> offerings.issuer_id (TENANCY_MODEL.md §2.1). They were left
-- unprotected while their module lived on Express; porting the module without
-- the policies would quietly thin the backstop exactly where new code lands.
--
-- WHAT INVESTORS MAY SEE, and why it differs per table:
--   valuations, property_updates, buyback_offers  -> readable by investors.
--     These are the asset's public face: an investor deciding whether to buy or
--     sell needs the appraisal, the manager's updates, and the standing bid.
--   manager_proposals, manager_votes -> readable by investors, because holders
--     vote on them; a governance vote nobody can read is not governance.
--   buyback_sales -> DUAL-AXIS: the seller sees their own sales, the issuer sees
--     all sales of its asset. Same shape as subscriptions (§2.4).

/* ---- valuations: issuer writes, everyone reads --------------------------- */
ALTER TABLE valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE valuations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS valuations_read ON valuations;
CREATE POLICY valuations_read ON valuations FOR SELECT TO app_tenant
  USING (
    app_is_platform() OR app_is_investor()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = valuations.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

DROP POLICY IF EXISTS valuations_write ON valuations;
CREATE POLICY valuations_write ON valuations FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = valuations.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = valuations.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

/* ---- property_updates: same shape ---------------------------------------- */
ALTER TABLE property_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_updates FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_updates_read ON property_updates;
CREATE POLICY property_updates_read ON property_updates FOR SELECT TO app_tenant
  USING (
    app_is_platform() OR app_is_investor()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = property_updates.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

DROP POLICY IF EXISTS property_updates_write ON property_updates;
CREATE POLICY property_updates_write ON property_updates FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = property_updates.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = property_updates.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

/* ---- buyback_offers: the standing bid, public to investors ---------------- */
ALTER TABLE buyback_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyback_offers FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS buyback_offers_read ON buyback_offers;
CREATE POLICY buyback_offers_read ON buyback_offers FOR SELECT TO app_tenant
  USING (
    app_is_platform() OR app_is_investor()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = buyback_offers.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

DROP POLICY IF EXISTS buyback_offers_write ON buyback_offers;
CREATE POLICY buyback_offers_write ON buyback_offers FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = buyback_offers.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = buyback_offers.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

/* ---- buyback_sales: DUAL-AXIS (seller vs issuer) ------------------------- */
ALTER TABLE buyback_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyback_sales FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS buyback_sales_read ON buyback_sales;
CREATE POLICY buyback_sales_read ON buyback_sales FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR lower(wallet) = lower(coalesce(app_current_investor(), ''))
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = buyback_sales.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

/* Recorded by platform settlement flows, never edited by hand. */
DROP POLICY IF EXISTS buyback_sales_write ON buyback_sales;
CREATE POLICY buyback_sales_write ON buyback_sales FOR ALL TO app_tenant
  USING (app_is_platform()) WITH CHECK (app_is_platform());

/* ---- governance: proposals + votes --------------------------------------- */
ALTER TABLE manager_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_proposals FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manager_proposals_read ON manager_proposals;
CREATE POLICY manager_proposals_read ON manager_proposals FOR SELECT TO app_tenant
  USING (
    app_is_platform() OR app_is_investor()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = manager_proposals.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

DROP POLICY IF EXISTS manager_proposals_write ON manager_proposals;
CREATE POLICY manager_proposals_write ON manager_proposals FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = manager_proposals.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = manager_proposals.offering_id
                 AND o.issuer_id::text = app_current_issuer())
  );

ALTER TABLE manager_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_votes FORCE  ROW LEVEL SECURITY;

/* Votes are readable by anyone who can read the proposal — a tally nobody can
   verify is not a vote. */
DROP POLICY IF EXISTS manager_votes_read ON manager_votes;
CREATE POLICY manager_votes_read ON manager_votes FOR SELECT TO app_tenant
  USING (
    app_is_platform() OR app_is_investor()
    OR EXISTS (
      SELECT 1 FROM manager_proposals p JOIN offerings o ON o.id = p.offering_id
       WHERE p.id = manager_votes.proposal_id AND o.issuer_id::text = app_current_issuer()
    )
  );

/* An investor may cast their OWN vote and nobody else's. */
DROP POLICY IF EXISTS manager_votes_insert ON manager_votes;
CREATE POLICY manager_votes_insert ON manager_votes FOR INSERT TO app_tenant
  WITH CHECK (
    app_is_platform()
    OR lower(wallet) = lower(coalesce(app_current_investor(), ''))
  );
