-- Multi-issuer tenancy, part 3: make the database enforce isolation.
--
-- TENANCY_MODEL.md §7. Until now every WHERE issuer_id = … in the app was the
-- ONLY thing separating tenants. This migration adds the backstop, so an
-- application bug (a forgotten predicate, a careless join) cannot leak across
-- tenants.
--
-- WHY GROUP ROLES WITH NO PASSWORD HERE:
-- Migrations are committed to git, so they must never contain a credential.
-- This file creates NOLOGIN group roles and the policies; the LOGIN roles and
-- their passwords are created out-of-band by `npm run db:setup-roles`, which
-- reads them from the environment.
--
-- THE EXPRESS APP IS UNAFFECTED. It connects as `postgres`, which has BYPASSRLS,
-- so every policy below is invisible to it. That is what lets this land while
-- the strangler migration is only partly done.
--
-- SCOPE: only the tables the migrated modules actually read today (issuers,
-- offerings, admins). Enabling RLS on a table whose module has not migrated
-- would protect nothing and risk breaking the Express path if it ever stopped
-- using a BYPASSRLS role. Each future module brings its own tables under RLS.

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------

-- Request-path role. RLS APPLIES to it: it is not a table owner and must never
-- be granted BYPASSRLS. Handles issuer, investor, and platform callers — which
-- of those a request is comes from the app.* settings, not from the role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END $$;

-- Background-worker role: the indexer, webhook consumers, reconciliation, and
-- the pre-tenant auth lookup (you cannot scope a login by the issuer the login
-- is about to establish). Cross-tenant BY DESIGN, and unreachable from an HTTP
-- request handler.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_tenant, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app_tenant, app_worker;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app_tenant, app_worker;

-- Tables created later must not silently be unreadable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant, app_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_tenant, app_worker;

-- ---------------------------------------------------------------------------
-- 2. Helper predicates
--
-- current_setting(name, true) returns NULL when unset rather than raising, so
-- an unscoped connection matches nothing. Fail-closed is the default, which is
-- the property that makes this worth having.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.is_platform', true) = 'true', false) $$;

CREATE OR REPLACE FUNCTION app_current_issuer() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.issuer_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_is_investor() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.investor_wallet', true), '') IS NOT NULL $$;

-- ---------------------------------------------------------------------------
-- 3. offerings
--
-- Platform sees everything. An issuer sees only its own — note that a NULL
-- issuer_id compares as NULL, i.e. false, so the 2 unassigned offerings are
-- invisible to every issuer until migration 043 assigns them. Investors see all
-- offerings: this is a marketplace and browsing is cross-issuer by design
-- (TENANCY_MODEL.md §2.4).
-- ---------------------------------------------------------------------------

ALTER TABLE offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE offerings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offerings_tenant_read ON offerings;
CREATE POLICY offerings_tenant_read ON offerings FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR app_is_investor()
    OR issuer_id::text = app_current_issuer()
  );

-- Writes are strictly own-issuer (or platform). WITH CHECK stops an issuer
-- from re-parenting a row to somebody else's issuer_id.
DROP POLICY IF EXISTS offerings_tenant_write ON offerings;
CREATE POLICY offerings_tenant_write ON offerings FOR ALL TO app_tenant
  USING      (app_is_platform() OR issuer_id::text = app_current_issuer())
  WITH CHECK (app_is_platform() OR issuer_id::text = app_current_issuer());

-- ---------------------------------------------------------------------------
-- 4. issuers
--
-- The roster of issuers is the platform's book of business. An issuer admin may
-- read exactly one row — its own. Investors get nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuers FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS issuers_tenant_read ON issuers;
CREATE POLICY issuers_tenant_read ON issuers FOR SELECT TO app_tenant
  USING (app_is_platform() OR id::text = app_current_issuer());

DROP POLICY IF EXISTS issuers_platform_write ON issuers;
CREATE POLICY issuers_platform_write ON issuers FOR ALL TO app_tenant
  USING      (app_is_platform())
  WITH CHECK (app_is_platform());

-- ---------------------------------------------------------------------------
-- 5. admins
--
-- An issuer admin may see its own issuer's operators, never another issuer's.
-- Login lookups happen through the app_worker role because the tenant is not
-- yet known at that point.
-- ---------------------------------------------------------------------------

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE admins FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_tenant_read ON admins;
CREATE POLICY admins_tenant_read ON admins FOR SELECT TO app_tenant
  USING (app_is_platform() OR issuer_id::text = app_current_issuer());

DROP POLICY IF EXISTS admins_platform_write ON admins;
CREATE POLICY admins_platform_write ON admins FOR ALL TO app_tenant
  USING      (app_is_platform())
  WITH CHECK (app_is_platform());
