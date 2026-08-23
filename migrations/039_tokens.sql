-- Multi-issuer tenancy, part 0: make token → issuer unambiguous.
--
-- See docs/TENANCY_MODEL.md §4.1 (in ../rwa-token-backend/docs/).
--
-- Why this is a prerequisite: four issuer-scoped tables are keyed by token
-- symbol — balances, transfers, distributions, operation_requests — but there
-- is no tokens table. Token config lives in src/lib/config.ts, and
-- offerings.token_symbol is nullable with NO unique constraint, so
-- `token_symbol → issuer` is ambiguous today. Tenant isolation cannot rest on
-- an ambiguous join.
--
-- DDL ONLY. Populating this table from the address book is a separate,
-- reversible data step — see TENANCY_MODEL.md §6 step 3.

CREATE TABLE IF NOT EXISTS tokens (
  symbol      TEXT        PRIMARY KEY,
  issuer_id   BIGINT      NOT NULL REFERENCES issuers(id),
  address     TEXT        NOT NULL,
  onchainid   TEXT,
  deployed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tokens_issuer_idx ON tokens (issuer_id);

-- One token address per chain deployment; catches a double-record of the same
-- suite under two symbols.
CREATE UNIQUE INDEX IF NOT EXISTS tokens_address_key ON tokens (lower(address));

COMMENT ON TABLE tokens IS
  'Authoritative token -> issuer map. src/lib/config.ts is a bootstrap source, not the source of truth.';
