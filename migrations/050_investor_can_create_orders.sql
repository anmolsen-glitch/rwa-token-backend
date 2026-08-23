-- Let an investor create their OWN order.
--
-- Migration 044 gave `subscriptions` a platform-only write policy, with the
-- comment "orders are created and settled by platform flows". That was simply
-- wrong about who creates an order: the INVESTOR does, from their own session.
-- The read policy was correct; the write policy locked out the primary author.
--
-- Symptom: a valid order returned 500 — RLS silently rejected the INSERT, which
-- is exactly how a WITH CHECK failure presents.
--
-- The rule: an investor may INSERT a row for their OWN wallet, and nothing else.
-- No UPDATE, no DELETE — status transitions (paid, settling, settled, refunded)
-- move money and stay with the platform/worker paths.

DROP POLICY IF EXISTS subscriptions_investor_insert ON subscriptions;
CREATE POLICY subscriptions_investor_insert ON subscriptions FOR INSERT TO app_tenant
  WITH CHECK (
    app_is_platform()
    OR lower(wallet) = lower(coalesce(app_current_investor(), ''))
  );

-- The platform policy stays FOR ALL, so platform flows keep full access; this
-- one only widens INSERT for the investor axis.
