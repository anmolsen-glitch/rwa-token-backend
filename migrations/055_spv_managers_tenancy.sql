-- SPV managers come under tenancy.
--
-- An SPV manager sits between the platform operator and the per-property
-- managers: scoped to ONE issuer, they create the property managers running
-- that SPV's assets, place them under themselves, detach them, and suspend
-- them. They cannot approve KYB, deploy tokens, or touch the chain.
--
-- `issuer_id` is already NOT NULL (migration 035 got that right), so unlike
-- `managers` there is no column to add — only the policies. Zero rows today, so
-- the constraint below is free to validate.

ALTER TABLE spv_managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE spv_managers FORCE  ROW LEVEL SECURITY;

-- Not investor-readable, unlike `managers`. A property manager's profile is the
-- asset's public face — an investor is told who runs their building. The SPV's
-- internal management layer is not: it names the issuer's own staff structure
-- and appears on no public page.
DROP POLICY IF EXISTS spv_managers_read ON spv_managers;
CREATE POLICY spv_managers_read ON spv_managers FOR SELECT TO app_tenant
  USING (app_is_platform() OR issuer_id::text = app_current_issuer());

DROP POLICY IF EXISTS spv_managers_write ON spv_managers;
CREATE POLICY spv_managers_write ON spv_managers FOR ALL TO app_tenant
  USING      (app_is_platform() OR issuer_id::text = app_current_issuer())
  WITH CHECK (app_is_platform() OR issuer_id::text = app_current_issuer());

GRANT SELECT, INSERT, UPDATE, DELETE ON spv_managers TO app_tenant;

-- A property manager may only report to an SPV manager of the SAME issuer.
--
-- The same reasoning as `offerings_manager_same_issuer` (migration 053): RLS
-- stops an ISSUER pairing rows across tenants, but the platform admin bypasses
-- every policy by design, and adopting a rival SPV's property manager would let
-- whoever holds this row suspend a competitor's operator. Enforced in the
-- database so it holds regardless of which code path does the write.
CREATE OR REPLACE FUNCTION spv_manager_matches_manager_issuer(p_manager BIGINT, p_spv BIGINT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_spv IS NULL OR EXISTS (
    SELECT 1 FROM managers m JOIN spv_managers s ON s.id = p_spv
     WHERE m.id = p_manager AND m.issuer_id = s.issuer_id
  );
$$;

ALTER TABLE managers DROP CONSTRAINT IF EXISTS managers_spv_same_issuer;
ALTER TABLE managers ADD CONSTRAINT managers_spv_same_issuer
  CHECK (spv_manager_matches_manager_issuer(id, spv_manager_id)) NOT VALID;
ALTER TABLE managers VALIDATE CONSTRAINT managers_spv_same_issuer;
