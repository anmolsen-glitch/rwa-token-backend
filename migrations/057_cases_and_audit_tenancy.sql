-- Legal cases and the audit log come under tenancy.
--
-- A CASE is the off-chain order behind a privileged action: a court order,
-- sanctions listing, fraud report, or lost-key recovery. Freezes, burns and
-- forced transfers reference one, so the case is the answer to "why did you
-- move someone else's tokens" — and it has to be as tightly scoped as the
-- powers it justifies.
--
-- `legal_cases` has no issuer_id: it predates tenancy and is empty (checked
-- 2026-08-22), so the column is free to add and make NOT NULL now.
--
-- `audit_log` ALREADY has issuer_id (written by AuditService) but no policy.
-- That is the more serious of the two: the audit trail records who did what to
-- whom across every tenant, and until now any issuer connection could read all
-- of it. It is added as READ-ONLY for tenants — see below.

ALTER TABLE legal_cases ADD COLUMN IF NOT EXISTS issuer_id BIGINT REFERENCES issuers(id);

DO $$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM legal_cases WHERE issuer_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'legal_cases has % row(s) with no issuer_id — backfill first', n;
  END IF;
END $$;

ALTER TABLE legal_cases ALTER COLUMN issuer_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS legal_cases_issuer_idx ON legal_cases (issuer_id, created_at DESC);

-- A case reference should be unique WITHIN an issuer, not globally: two
-- companies can legitimately receive orders numbered the same way, and a
-- collision across tenants would leak that the other one exists.
CREATE UNIQUE INDEX IF NOT EXISTS legal_cases_issuer_reference_uniq
  ON legal_cases (issuer_id, lower(reference));

ALTER TABLE legal_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_cases FORCE  ROW LEVEL SECURITY;

-- Not investor-readable. A case names a subject wallet and often a reason; an
-- investor must not be able to discover that someone is under investigation,
-- including themselves — telling the subject is a decision for compliance and
-- their lawyers, not an API default.
DROP POLICY IF EXISTS legal_cases_read ON legal_cases;
CREATE POLICY legal_cases_read ON legal_cases FOR SELECT TO app_tenant
  USING (app_is_platform() OR issuer_id::text = app_current_issuer());

DROP POLICY IF EXISTS legal_cases_write ON legal_cases;
CREATE POLICY legal_cases_write ON legal_cases FOR ALL TO app_tenant
  USING      (app_is_platform() OR issuer_id::text = app_current_issuer())
  WITH CHECK (app_is_platform() OR issuer_id::text = app_current_issuer());

REVOKE DELETE ON legal_cases FROM app_tenant;
GRANT SELECT, INSERT, UPDATE ON legal_cases TO app_tenant;

/* ---- audit_log: READ-ONLY to tenants ------------------------------------- */
--
-- Writes go through db.worker() (BYPASSRLS) precisely so an actor can never
-- suppress their own trail by manipulating tenant scope — that predates this
-- migration and is why no INSERT policy is granted here. What is new is that a
-- tenant can no longer READ another tenant's trail.
--
-- Rows with a NULL issuer_id are PLATFORM actions. They stay visible only to
-- the platform: an issuer seeing them would learn what the operator does across
-- the whole business.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_read ON audit_log;
CREATE POLICY audit_log_read ON audit_log FOR SELECT TO app_tenant
  USING (app_is_platform() OR issuer_id::text = app_current_issuer());

-- No INSERT/UPDATE/DELETE policy at all: the trail is append-only, written by
-- the worker connection. A tenant that could edit it could rewrite history
-- about itself, which is the one thing an audit log must never allow.
REVOKE INSERT, UPDATE, DELETE ON audit_log FROM app_tenant;
GRANT SELECT ON audit_log TO app_tenant;

CREATE INDEX IF NOT EXISTS audit_log_issuer_idx ON audit_log (issuer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_case_idx   ON audit_log (case_id) WHERE case_id IS NOT NULL;
