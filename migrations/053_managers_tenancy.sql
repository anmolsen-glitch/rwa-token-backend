-- Property managers become issuer-owned.
--
-- A `manager` is the firm that OPERATES a property day to day: a public profile
-- shown to investors on the asset page, plus an optional scoped login (role
-- 'manager') that can see only its own properties, post updates, and declare
-- distributions. `offerings.manager_id` is the link, one manager per property.
--
-- Until now `managers` had no issuer_id and no RLS — a platform-global registry
-- from before tenancy existed. That is the last table an issuer_admin could
-- enumerate across the whole platform, and the roster of who operates whose
-- buildings is commercially sensitive: it names an issuer's suppliers, and by
-- extension how many assets they run.
--
-- Doing it NOW because it is free: zero manager rows and zero offerings with a
-- manager assigned (checked 2026-08-22), so NOT NULL needs no backfill and no
-- NOT VALID/VALIDATE dance. The same change after the first issuer onboards its
-- managers is a data migration with a judgement call per row.
--
-- SPV managers (spv_managers) already carry issuer_id NOT NULL, so this makes
-- the two levels of the hierarchy agree rather than introducing a new idea.

ALTER TABLE managers ADD COLUMN IF NOT EXISTS issuer_id BIGINT REFERENCES issuers(id);

-- Safe only because the table is empty; assert that rather than assume it.
DO $$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM managers WHERE issuer_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'managers has % row(s) with no issuer_id — backfill before making it NOT NULL', n;
  END IF;
END $$;

ALTER TABLE managers ALTER COLUMN issuer_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS managers_issuer_idx ON managers (issuer_id, created_at DESC);

/* ---- RLS: the same shape as every other issuer-owned table --------------- */
ALTER TABLE managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE managers FORCE  ROW LEVEL SECURITY;

-- Investors may read managers: the operator's profile is part of the asset's
-- public face, exactly like valuations and property updates (migration 051).
-- The public marketplace read runs as `platform`, so it is covered either way.
DROP POLICY IF EXISTS managers_read ON managers;
CREATE POLICY managers_read ON managers FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR app_is_investor()
    OR issuer_id::text = app_current_issuer()
  );

-- Writes are the owning issuer's alone. WITH CHECK as well as USING, so an
-- issuer cannot create a manager under someone else's id or move one across.
DROP POLICY IF EXISTS managers_write ON managers;
CREATE POLICY managers_write ON managers FOR ALL TO app_tenant
  USING      (app_is_platform() OR issuer_id::text = app_current_issuer())
  WITH CHECK (app_is_platform() OR issuer_id::text = app_current_issuer());

GRANT SELECT, INSERT, UPDATE, DELETE ON managers TO app_tenant;

-- A manager operates ONE issuer's property, so the assignment must not cross
-- tenants. RLS on `offerings` already stops an issuer assigning to someone
-- else's offering, and RLS on `managers` stops it referencing someone else's
-- manager; this constraint closes the remaining case — the PLATFORM admin, who
-- bypasses both policies by design and could otherwise pair them by mistake.
CREATE OR REPLACE FUNCTION manager_matches_offering_issuer(p_offering TEXT, p_manager BIGINT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_manager IS NULL OR EXISTS (
    SELECT 1 FROM offerings o JOIN managers m ON m.id = p_manager
     WHERE o.id = p_offering AND o.issuer_id = m.issuer_id
  );
$$;

ALTER TABLE offerings DROP CONSTRAINT IF EXISTS offerings_manager_same_issuer;
ALTER TABLE offerings ADD CONSTRAINT offerings_manager_same_issuer
  CHECK (manager_matches_offering_issuer(id, manager_id)) NOT VALID;
-- Valid immediately (no offering has a manager), but declared NOT VALID and
-- validated separately so the pattern is the same one used for admins in 040.
ALTER TABLE offerings VALIDATE CONSTRAINT offerings_manager_same_issuer;
