-- An issuer must be able to create and disable its OWN staff logins.
--
-- Migration 042 gave `admins` a tenant-scoped READ policy but a platform-only
-- WRITE policy. That was right while the platform operator was the only one
-- creating accounts. It is wrong the moment an issuer_admin creates a property
-- manager with a portal login: the login is an `admins` row, the writer is the
-- issuer, and RLS rejects it as a 500.
--
-- Third instance of the same mistake (050 subscriptions, 052 buyback_sales and
-- manager_votes): the policy named the party who OWNS the feature rather than
-- the party who WRITES the row. Worth stating as a rule — when putting a table
-- under RLS, enumerate the writers, not the owners.
--
-- The dangerous part of letting an issuer write `admins` is PRIVILEGE
-- ESCALATION, so the policy is deliberately narrower than "your own issuer":
--
--   * an issuer may only ever write rows carrying its OWN issuer_id, so it
--     cannot create an account inside another tenant;
--   * it may only create the roles BELOW it — never `platform_admin`, which
--     would be a tenant minting a superuser, and never a row with a NULL
--     issuer_id, which is what a platform account looks like;
--   * `issuer_admin` is included so an issuer can appoint its own admins, which
--     is the normal team-management case. Note this means an issuer_admin can
--     create a peer; that is intended (it is their tenant) and is exactly why
--     the platform_admin exclusion above has to be enforced in the DATABASE and
--     not only in application code.

DROP POLICY IF EXISTS admins_tenant_write ON admins;
CREATE POLICY admins_tenant_write ON admins FOR ALL TO app_tenant
  USING (
    app_is_platform()
    OR (
      issuer_id::text = app_current_issuer()
      AND role IN ('issuer_admin', 'compliance', 'agent', 'manager', 'spv_manager')
    )
  )
  WITH CHECK (
    app_is_platform()
    OR (
      issuer_id IS NOT NULL
      AND issuer_id::text = app_current_issuer()
      AND role IN ('issuer_admin', 'compliance', 'agent', 'manager', 'spv_manager')
    )
  );

-- A tenant that could DELETE admins could erase the second signature on a
-- maker-checker approval, or remove the only account that has seen an audit
-- trail. Disabling (an UPDATE) is the supported path; removal stays with the
-- platform operator.
REVOKE DELETE ON admins FROM app_tenant;
GRANT SELECT, INSERT, UPDATE ON admins TO app_tenant;
