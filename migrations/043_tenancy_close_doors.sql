-- Multi-issuer tenancy, part 4: close the one-way doors.
--
-- TENANCY_MODEL.md §6 step 8. Everything before this was additive and
-- reversible. This migration makes the invariants permanent, so it runs only
-- after the scoped read paths are live and verified — which they now are
-- (migrations 040-042, 30 passing tests).
--
-- Operator decisions recorded here because they are NOT derivable from data:
--   * the 2 unassigned offerings belong to issuer 1 (Jaipur LLP) — both are
--     Indian assets and Jaipur LLP is the Indian entity;
--   * `tokens` is populated only where the on-chain owner matches an
--     issuers.owner_wallet. Guessing an owner for the rest would put a false
--     claim in the table that is meant to be authoritative.

-- ---------------------------------------------------------------------------
-- 1. Add a network dimension to `tokens` BEFORE it holds any rows.
--
-- Migration 039 keyed tokens by symbol alone. That is wrong the moment a symbol
-- exists on more than one chain — the address book already has both `localhost`
-- and `sepolia` sections, and the same symbol appears in both. Fixing it now is
-- free (the table is empty); fixing it after it has rows is not.
-- ---------------------------------------------------------------------------

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'sepolia';
ALTER TABLE tokens ALTER COLUMN network DROP DEFAULT;

ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_pkey;
ALTER TABLE tokens ADD  PRIMARY KEY (network, symbol);

-- The old unique index was global; addresses are only unique per network.
DROP INDEX IF EXISTS tokens_address_key;
CREATE UNIQUE INDEX IF NOT EXISTS tokens_network_address_key
  ON tokens (network, lower(address));

-- ---------------------------------------------------------------------------
-- 2. Populate `tokens` for the sepolia deployment.
--
-- issuer_id derived by matching the on-chain token owner to issuers.owner_wallet:
--   0x7E71… -> 1 Jaipur LLP          0xd835… -> 2 Palm Crest
--   0x8E99… -> 4 Palm Crest          0xa3cc… -> 5 Jumeirah Bay
--
-- DELIBERATELY OMITTED: GOAV and BLR1. Both are owned on-chain by the platform
-- deploy key 0xb475…7a7E, which belongs to no issuer, and neither is referenced
-- by any offering. An unknown owner is recorded as absent, not as a guess.
--
-- KNOWN INCONSISTENCY: MBWT is assigned to issuer 1 because its offering
-- (bandra-tower-a) is, but its on-chain owner is the platform key 0xb475, NOT
-- Jaipur LLP's 0x7E71. Off-chain and on-chain ownership disagree until the token
-- is transferred or the issuer record is corrected. Tracked, not silently
-- papered over.
-- ---------------------------------------------------------------------------

INSERT INTO tokens (network, symbol, issuer_id, address) VALUES
  ('sepolia', 'JPR',   1, '0x1719098fe6e9E67b85b4aC80F893183d75209A60'),
  ('sepolia', 'PUN',   1, '0x53C8bcBab719444648c9C55332F8a30a8b364Ff1'),
  ('sepolia', 'MBWT',  1, '0x6D72353d13D88Dc6c53b46D5189E1476A982C1d1'),
  ('sepolia', 'MCRRE', 2, '0x244B8C48b721B2767709C238B5c4EcEfBF4FdA0e'),
  ('sepolia', 'DVVRE', 2, '0x422ae36b53F6e84Bf4Dc6B4a89B4f3bE9f955a2A'),
  ('sepolia', 'MCR',   4, '0xfB9964b82b47b8E5e041ff40fdbe9d82176b40E8'),
  ('sepolia', 'JBRA',  5, '0xD36901332257Cc9A0f7c9D4781b757C7Bc29F79D'),
  ('sepolia', 'CSRET', 5, '0xbD018D41dA527E4421c95127F90A8577CeC661E5')
ON CONFLICT (network, symbol) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Assign the last two offerings, then shut the door.
-- ---------------------------------------------------------------------------

UPDATE offerings SET issuer_id = 1, updated_at = now()
 WHERE id IN ('pune-sez', 'bandra-tower-a') AND issuer_id IS NULL;

DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM offerings WHERE issuer_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'Refusing NOT NULL: % offering(s) still have no issuer', orphans;
  END IF;
END $$;

-- ONE-WAY DOOR: every offering now belongs to exactly one issuer, forever.
ALTER TABLE offerings ALTER COLUMN issuer_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. ONE-WAY DOOR: enforce the admin tenant rule on existing rows too.
--
-- Migration 040 added this NOT VALID so the backfill could happen afterwards.
-- VALIDATE re-checks every row; it takes only a SHARE UPDATE EXCLUSIVE lock, so
-- concurrent reads and writes are unaffected.
-- ---------------------------------------------------------------------------

ALTER TABLE admins VALIDATE CONSTRAINT admins_tenant_ck;

-- ---------------------------------------------------------------------------
-- 5. Bring `tokens` under RLS, matching migration 042's pattern.
--
-- Investors need to resolve a token to its asset while browsing, so reads are
-- open to an investor context; writes are platform-only (tokens appear via
-- deployment, not via issuer self-service).
-- ---------------------------------------------------------------------------

ALTER TABLE tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE tokens FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tokens_tenant_read ON tokens;
CREATE POLICY tokens_tenant_read ON tokens FOR SELECT TO app_tenant
  USING (
    app_is_platform()
    OR app_is_investor()
    OR issuer_id::text = app_current_issuer()
  );

DROP POLICY IF EXISTS tokens_platform_write ON tokens;
CREATE POLICY tokens_platform_write ON tokens FOR ALL TO app_tenant
  USING      (app_is_platform())
  WITH CHECK (app_is_platform());
