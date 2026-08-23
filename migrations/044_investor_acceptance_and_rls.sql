-- Investor tenancy: the acceptance model, and RLS for the dual-axis tables.
--
-- TENANCY_MODEL.md §4.3 (acceptance) and §2.4 (dual-axis scoping).
--
-- This is the hard half of the tenancy model. Until now every protected table
-- had ONE owner, so a single `issuer_id = current` predicate sufficed. These
-- tables have TWO legitimate owners: a subscriptions row is "my investment" to
-- the investor and "my cap table" to the issuer. Which rows you see depends on
-- WHICH AXIS you sit on, not on a column.

-- ---------------------------------------------------------------------------
-- 1. Acceptance: verify once (platform), accept per issuer (TENANCY_MODEL §D2)
--
-- KYC is performed once by the platform and shared. Each issuer then makes its
-- own RELIANCE decision. The issuer stays the obliged entity, which is why it
-- must be able to pull the underlying records for its own compliance file —
-- and why that pull is scoped to its own cap table (§5.1) and audited (§5.2).
--
-- Keyed on accounts.id, not a wallet: one person may link several wallets
-- (wallets.primary_wallet), and acceptance is a decision about the PERSON.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS issuer_investor_acceptance (
  issuer_id   BIGINT      NOT NULL REFERENCES issuers(id)  ON DELETE CASCADE,
  investor_id BIGINT      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'accepted'
                CHECK (status IN ('accepted', 'rejected', 'pending_review')),
  kyc_version BIGINT      NOT NULL DEFAULT 1,   -- which verification was relied upon
  decided_by  BIGINT      REFERENCES admins(id),
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT,
  PRIMARY KEY (issuer_id, investor_id)
);

CREATE INDEX IF NOT EXISTS iia_investor_idx ON issuer_investor_acceptance (investor_id);

-- Lets an issuer see that its acceptance rests on a verification that has since
-- been re-run: acceptance.kyc_version < investors.kyc_version means re-confirm.
ALTER TABLE investors ADD COLUMN IF NOT EXISTS kyc_version BIGINT NOT NULL DEFAULT 1;

-- Per-issuer reliance policy. auto_accept = pure reliance (row created on first
-- subscription); manual_review = that issuer's compliance team decides.
ALTER TABLE issuers ADD COLUMN IF NOT EXISTS acceptance_policy TEXT NOT NULL DEFAULT 'auto_accept'
  CHECK (acceptance_policy IN ('auto_accept', 'manual_review'));

-- Audit rows need a scope column so an issuer can read its own slice; deriving
-- it from params JSONB is neither indexable nor reliable (§2.4).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS issuer_id BIGINT REFERENCES issuers(id);
CREATE INDEX IF NOT EXISTS audit_log_issuer_idx ON audit_log (issuer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Cap-table membership
--
-- "Is this investor on issuer X's cap table?" is asked by several policies, so
-- it lives in one function rather than being re-implemented per table.
--
-- Membership = holds/held a subscription to one of that issuer's offerings, OR
-- holds a non-zero balance in one of its tokens, OR has an acceptance row.
--
-- NOTE the join for balances: balances.token stores the token CONTRACT ADDRESS
-- (lower-cased), not the symbol — verified against live data. Joining on symbol
-- would match nothing, and because RLS fails closed that would silently return
-- empty sets rather than erroring.
--
-- SECURITY DEFINER so the function reads the underlying tables without the
-- caller's own RLS filtering them first, which would make membership
-- self-referential. It takes no caller input beyond the wallet and returns only
-- a boolean, so it discloses nothing by itself.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_issuer_sees_investor(p_wallet TEXT)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN app_current_issuer() IS NULL THEN false
    ELSE EXISTS (
      SELECT 1 FROM subscriptions s
        JOIN offerings o ON o.id = s.offering_id
       WHERE lower(s.wallet) = lower(p_wallet)
         AND o.issuer_id::text = app_current_issuer()
    ) OR EXISTS (
      SELECT 1 FROM balances b
        JOIN tokens t ON lower(t.address) = lower(b.token)
       WHERE lower(b.address) = lower(p_wallet)
         AND b.balance <> 0
         AND t.issuer_id::text = app_current_issuer()
    ) OR EXISTS (
      SELECT 1 FROM issuer_investor_acceptance a
        JOIN investors i ON i.account_id = a.investor_id
       WHERE lower(i.wallet) = lower(p_wallet)
         AND a.issuer_id::text = app_current_issuer()
    )
  END;
$$;

REVOKE ALL ON FUNCTION app_issuer_sees_investor(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_issuer_sees_investor(TEXT) TO app_tenant, app_worker;

/** The wallet of the current investor session, or NULL. */
CREATE OR REPLACE FUNCTION app_current_investor() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.investor_wallet', true), '') $$;

-- ---------------------------------------------------------------------------
-- 3. investors — global identity, restricted access
--
-- §2.2 lists `investors` as platform-global: one person, one row, shared across
-- issuers. That is about IDENTITY OWNERSHIP, not read access. An issuer may
-- read only the investors on its own cap table (§5.1) — it must never be able
-- to enumerate the platform's investor base, nor learn that one of its holders
-- also holds a competitor's token.
-- ---------------------------------------------------------------------------

ALTER TABLE investors ENABLE ROW LEVEL SECURITY;
ALTER TABLE investors FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS investors_tenant_read ON investors;
CREATE POLICY investors_tenant_read ON investors FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR lower(wallet) = lower(coalesce(app_current_investor(), ''))
    OR app_issuer_sees_investor(wallet)
  );

-- Investor records are written by onboarding/KYC flows, which are platform
-- operations. Issuers never mutate a shared identity.
DROP POLICY IF EXISTS investors_platform_write ON investors;
CREATE POLICY investors_platform_write ON investors FOR ALL TO app_tenant
  USING      (app_is_platform())
  WITH CHECK (app_is_platform());

-- ---------------------------------------------------------------------------
-- 4. subscriptions — the canonical dual-axis table
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_tenant_read ON subscriptions;
CREATE POLICY subscriptions_tenant_read ON subscriptions FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    -- investor axis: my investments, across every issuer
    OR lower(wallet) = lower(coalesce(app_current_investor(), ''))
    -- issuer axis: my cap table, across every investor
    OR EXISTS (
      SELECT 1 FROM offerings o
       WHERE o.id = subscriptions.offering_id
         AND o.issuer_id::text = app_current_issuer()
    )
  );

-- Orders are created and settled by platform flows (payment webhooks, escrow),
-- never edited by an issuer directly.
DROP POLICY IF EXISTS subscriptions_platform_write ON subscriptions;
CREATE POLICY subscriptions_platform_write ON subscriptions FOR ALL TO app_tenant
  USING      (app_is_platform())
  WITH CHECK (app_is_platform());

-- ---------------------------------------------------------------------------
-- 5. balances / transfers — dual-axis, keyed by token ADDRESS
-- ---------------------------------------------------------------------------

ALTER TABLE balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE balances FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS balances_tenant_read ON balances;
CREATE POLICY balances_tenant_read ON balances FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR lower(address) = lower(coalesce(app_current_investor(), ''))
    OR EXISTS (
      SELECT 1 FROM tokens t
       WHERE lower(t.address) = lower(balances.token)
         AND t.issuer_id::text = app_current_issuer()
    )
  );

ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transfers_tenant_read ON transfers;
CREATE POLICY transfers_tenant_read ON transfers FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR lower(from_addr) = lower(coalesce(app_current_investor(), ''))
    OR lower(to_addr)   = lower(coalesce(app_current_investor(), ''))
    OR EXISTS (
      SELECT 1 FROM tokens t
       WHERE lower(t.address) = lower(transfers.token)
         AND t.issuer_id::text = app_current_issuer()
    )
  );

-- balances and transfers are written ONLY by the indexer, which runs as
-- app_worker (BYPASSRLS). No app_tenant write policy exists, so a request-path
-- bug cannot forge a holding.

-- ---------------------------------------------------------------------------
-- 6. acceptance table itself
-- ---------------------------------------------------------------------------

ALTER TABLE issuer_investor_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuer_investor_acceptance FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iia_tenant_read ON issuer_investor_acceptance;
CREATE POLICY iia_tenant_read ON issuer_investor_acceptance FOR SELECT TO app_tenant
  USING (app_is_platform() OR issuer_id::text = app_current_issuer());

-- An issuer decides acceptance for ITSELF only. WITH CHECK stops it writing a
-- decision on another issuer's behalf.
DROP POLICY IF EXISTS iia_tenant_write ON issuer_investor_acceptance;
CREATE POLICY iia_tenant_write ON issuer_investor_acceptance FOR ALL TO app_tenant
  USING      (app_is_platform() OR issuer_id::text = app_current_issuer())
  WITH CHECK (app_is_platform() OR issuer_id::text = app_current_issuer());
