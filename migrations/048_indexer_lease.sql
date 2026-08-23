-- Singleton lease for background work (the indexer).
--
-- WHY NOT pg_try_advisory_lock: it is SESSION-scoped, and this project's dev
-- database is reached through Supavisor's TRANSACTION pooler, which multiplexes
-- sessions across backends. Measured 2026-08-22: two separate clients BOTH
-- acquired the same advisory lock, because each landed on a different backend.
-- It provides no mutual exclusion there — the same class of trap as `SET` vs
-- `SET LOCAL` (CLAUDE.md §7.2).
--
-- A lease ROW is pooling-agnostic: acquisition is a single atomic statement, and
-- a holder that dies simply stops renewing, so the lease lapses and another
-- instance takes over. No stale-lock cleanup, no dependence on connection
-- lifetime.
CREATE TABLE IF NOT EXISTS worker_lease (
  id         TEXT        PRIMARY KEY,   -- 'indexer'
  owner      TEXT        NOT NULL,      -- random per-process id
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE worker_lease IS
  'Singleton lease for background workers. Renewed while running; lapses if the holder dies.';
