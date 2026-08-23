-- Multi-issuer tenancy, part 2: assign existing admins to tenants.
--
-- TENANCY_MODEL.md §6 steps 4-5. This is a DATA migration, chosen deliberately
-- (see the operator decision recorded below) rather than derived — there is no
-- way to infer which issuer an existing admin belongs to.
--
-- Assignment:
--   admin@example.com     -> platform_admin, no issuer (cross-tenant, audited)
--   agent@demo.local      -> issuer 2  (Palm Crest Properties SPV Ltd.)
--   agent2@demo.local     -> issuer 5  (Jumeirah Bay Holdings SPV Ltd)
--   compliance@demo.local -> issuer 2  (Palm Crest Properties SPV Ltd.)
--
-- Spread across two issuers on purpose, so cross-tenant isolation is observable
-- rather than merely asserted.
--
-- Still NOT done here (the one-way doors, TENANCY_MODEL.md §6 step 8):
--   * offerings.issuer_id -> NOT NULL  (2 offerings remain unassigned)
--   * VALIDATE CONSTRAINT admins_tenant_ck

-- Order matters: set issuer_id BEFORE promoting anyone to platform_admin, so
-- the NOT VALID tenant CHECK is never violated by an in-flight row.
UPDATE admins SET issuer_id = 2 WHERE lower(email) = 'agent@demo.local';
UPDATE admins SET issuer_id = 5 WHERE lower(email) = 'agent2@demo.local';
UPDATE admins SET issuer_id = 2 WHERE lower(email) = 'compliance@demo.local';

-- The seed superuser becomes the platform operator: no tenant, sees everything,
-- every action audited. This is the most dangerous credential in the system.
UPDATE admins SET issuer_id = NULL, role = 'platform_admin'
 WHERE lower(email) = 'admin@example.com';

-- Fail loudly rather than leaving a half-tenanted admin table behind.
DO $$
DECLARE bad INT;
BEGIN
  SELECT count(*) INTO bad FROM admins
   WHERE (role =  'platform_admin' AND issuer_id IS NOT NULL)
      OR (role <> 'platform_admin' AND issuer_id IS NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION 'Backfill incomplete: % admin(s) violate the tenant rule', bad;
  END IF;
END $$;
