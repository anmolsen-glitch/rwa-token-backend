-- Multi-issuer tenancy, part 1: give platform operators a tenant.
--
-- See docs/TENANCY_MODEL.md §4.2 (in ../rwa-token-backend/docs/).
--
-- ADDITIVE AND REVERSIBLE. This migration deliberately does NOT:
--   * make issuer_id NOT NULL  (that is the one-way door — §6 step 8)
--   * backfill any admin's issuer_id  (needs a human decision per admin)
--   * create the app_tenant role or enable RLS  (migration 043)
--
-- The Express app reads `admins` with SELECT *, so an added nullable column is
-- invisible to it. Both services keep working while this sits half-applied.

-- 1. The tenancy column. Nullable for now: platform_admin legitimately has no
--    issuer, and existing admins have not been assigned one yet.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS issuer_id BIGINT REFERENCES issuers(id);

CREATE INDEX IF NOT EXISTS admins_issuer_idx ON admins (issuer_id);

-- 2. Add the platform_admin role.
--
--    Until now `issuer_admin` was the de-facto superuser (it satisfied every
--    role check in src/middleware/auth.ts:69). Under multi-tenancy issuer_admin
--    becomes bounded to its own issuer, and platform_admin takes over the
--    cross-tenant bypass. 'spv_manager' is already accepted by migration 035.
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE admins ADD CONSTRAINT admins_role_check
  CHECK (role IN ('platform_admin', 'issuer_admin', 'compliance', 'agent', 'manager', 'spv_manager'));

-- 3. Tenant consistency, enforced as NOT VALID so existing rows are exempt
--    until the backfill runs. New and updated rows must comply immediately.
--
--    Once every non-platform admin has an issuer_id, run:
--        ALTER TABLE admins VALIDATE CONSTRAINT admins_tenant_ck;
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_tenant_ck;
ALTER TABLE admins ADD CONSTRAINT admins_tenant_ck CHECK (
  (role =  'platform_admin' AND issuer_id IS NULL) OR
  (role <> 'platform_admin' AND issuer_id IS NOT NULL)
) NOT VALID;
