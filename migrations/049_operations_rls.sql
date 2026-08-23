-- Bring the approval workflow under tenancy.
--
-- operation_requests/operation_approvals are the maker-checker queue for
-- sensitive chain writes: mint, burn, force-transfer, pause. Under a single
-- issuer they needed no scoping. With several, two things must be true:
--
--   1. An issuer sees only ITS OWN requests. A pending force-transfer names a
--      wallet and an amount — that is cap-table intelligence about a competitor.
--   2. An issuer cannot approve another issuer's request. Otherwise the
--      four-eyes rule is satisfiable by an unrelated company's staff.
--
-- Scope path is token_symbol -> tokens.issuer_id (TENANCY_MODEL.md §2.1), the
-- same join offerings uses. No denormalised issuer_id: `tokens` is already the
-- authoritative map since migration 039, and a copy would be one more thing to
-- keep in step.

ALTER TABLE operation_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_requests  FORCE  ROW LEVEL SECURITY;
ALTER TABLE operation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_approvals FORCE  ROW LEVEL SECURITY;

/**
 * A request with a NULL token_symbol (e.g. a future platform-wide action) is
 * visible to the platform only — it belongs to no issuer, and defaulting such a
 * row to "everyone" is how a scoping model quietly leaks.
 */
DROP POLICY IF EXISTS operation_requests_tenant ON operation_requests;
CREATE POLICY operation_requests_tenant ON operation_requests FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM tokens t
       WHERE upper(t.symbol) = upper(operation_requests.token_symbol)
         AND t.issuer_id::text = app_current_issuer()
    )
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM tokens t
       WHERE upper(t.symbol) = upper(operation_requests.token_symbol)
         AND t.issuer_id::text = app_current_issuer()
    )
  );

DROP POLICY IF EXISTS operation_approvals_tenant ON operation_approvals;
CREATE POLICY operation_approvals_tenant ON operation_approvals FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM operation_requests r JOIN tokens t
              ON upper(t.symbol) = upper(r.token_symbol)
       WHERE r.id = operation_approvals.operation_id
         AND t.issuer_id::text = app_current_issuer()
    )
  )
  WITH CHECK (
    app_is_platform()
    OR EXISTS (
      SELECT 1 FROM operation_requests r JOIN tokens t
              ON upper(t.symbol) = upper(r.token_symbol)
       WHERE r.id = operation_approvals.operation_id
         AND t.issuer_id::text = app_current_issuer()
    )
  );

-- `tokens` already has a read policy (migration 043); operations need to resolve
-- a symbol they own, which that policy already permits.
CREATE INDEX IF NOT EXISTS operation_requests_token_idx ON operation_requests (upper(token_symbol));
