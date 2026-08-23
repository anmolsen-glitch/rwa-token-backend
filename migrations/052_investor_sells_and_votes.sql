-- Two write paths that belong to the INVESTOR, not the issuer.
--
-- Migration 051 gave buyback_sales a dual-axis READ policy but left its write
-- policy platform-only, and gave manager_votes an INSERT policy with no UPDATE.
-- Both look fine until the flow actually runs, because the party doing the
-- writing is the investor:
--
--   * a sell-back is recorded BY the seller, after they transfer tokens from
--     their own wallet (non-custodial — the platform cannot pull them, so it
--     cannot be the one to book the sale either);
--   * a vote is an UPSERT, because changing your mind before the window closes
--     is a normal thing to do. INSERT alone makes the second vote fail.
--
-- Exactly the mistake migration 050 fixed for subscriptions. It surfaces as a
-- 500 rather than a 403, which is why it is worth naming: an RLS rejection on a
-- write does not read like a permission error at the API boundary.

/* ---- buyback_sales: the seller books their own sale ---------------------- */
DROP POLICY IF EXISTS buyback_sales_write ON buyback_sales;

-- Issuer/platform: full control over its own asset's sales (corrections,
-- settlement). Still scoped through the offering.
CREATE POLICY buyback_sales_write ON buyback_sales FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = buyback_sales.offering_id
               AND o.issuer_id::text = app_current_issuer())
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (SELECT 1 FROM offerings o WHERE o.id = buyback_sales.offering_id
               AND o.issuer_id::text = app_current_issuer())
  );

-- Investor: INSERT ONLY, and only a row carrying their own wallet. No UPDATE
-- and no DELETE — a settled sale is a financial record, and the counterparty
-- must not be able to edit or erase it after the fact.
CREATE POLICY buyback_sales_investor_insert ON buyback_sales FOR INSERT TO app_tenant
  WITH CHECK (lower(wallet) = lower(COALESCE(app_current_investor(), '')));

/* ---- manager_votes: changing your mind before the window closes ---------- */
-- The INSERT policy from 051 stays as-is; this adds the UPDATE half of the
-- upsert. Both branches are pinned to the voter's own wallet, so a holder can
-- revise their own vote and nobody else's.
DROP POLICY IF EXISTS manager_votes_update ON manager_votes;
CREATE POLICY manager_votes_update ON manager_votes FOR UPDATE TO app_tenant
  USING (
    app_is_platform() OR lower(wallet) = lower(COALESCE(app_current_investor(), ''))
  )
  WITH CHECK (
    app_is_platform() OR lower(wallet) = lower(COALESCE(app_current_investor(), ''))
  );
