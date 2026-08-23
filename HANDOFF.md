# Handoff — RWA tokenization platform (NestJS migration)

**Last updated:** 2026-08-23. Written for a fresh session picking this up cold.

Read this, then read `CLAUDE.md` in this repo. `CLAUDE.md` is the *contract* —
how every module must be shaped. This file is the *situation* — where things
stand and what will bite you.

---

## 1. What this is

An ERC-3643 (T-REX) real-world-asset tokenization platform: issuers list
property, investors pass KYC and buy tokenized shares, compliance is enforced
on-chain via ONCHAINID claims.

Four apps in `~/trex_rwa/`:

| Path | What | State |
|---|---|---|
| `rwa-token-backend-nest` | **NestJS backend — the live one** | 132 routes, serves the ENTIRE API |
| `rwa-token-backend` | Express backend — the original | Idle fallback, **do not delete** |
| `rwa-token-frontend` | Admin portal (Vite + React) | Points at Nest |
| `rwa-investor-next` | Investor portal (Next 16) | Points at Nest |

> **All four repos are under git as of 2026-08-23** (the three unversioned ones
> got an initial commit before route retirement started). There is also a
> cutover backup at `~/trex_rwa/.cutover-backup-2026-08-22/`.

---

## 2. Current state — Nest serves everything

The last four proxied routes were ported on 2026-08-23 and their Express
handlers deleted. Nothing reaches Express anymore; the catch-all proxy remains
wired but has no routes left to forward.

```
frontends ──▶ Nest :4100 ── serves the ENTIRE API
                  │
                  ├── owns the INDEXER       (INDEXER_ENABLED=true)
                  └── owns the ORDER SWEEPER (SWEEPER_ENABLED=true)

Express :4000 ── idle fallback. Indexer + sweeper gated off in its .env;
                 deploy recovery RETIRED (see below). Safe to stop, kept
                 runnable per the do-not-delete rule.
```

The 2026-08-23 ports, and where they landed:

| Was (Express) | Now (Nest) |
|---|---|
| `POST/GET /api/uploads` | same paths, `modules/uploads` (public, per-route body/rate limits via an onRoute hook in `main.ts`) |
| `GET /api/subscriptions` | `GET /api/admin/subscriptions` — now tenant-scoped by RLS, camelCase, `{ items }` |
| `POST /api/issuers/:id/assets` | `POST /api/admin/issuers/:issuerId/assets` — create-listing only; `deployNow` is refused |
| `POST /api/investor/transfer/preview` | same path, `modules/portfolio` |

**Deploy recovery was retired, not ported.** It rescued exactly one state — an
interrupted `createAsset deployNow` one-shot, tracked in `pending_deploys`.
That state can no longer arise: Nest writes the offering row FIRST and the
deploy is a separate retryable step whose adoption path (salt lookup + owner
check + conditional unpause) finishes any interrupted attempt on the next
retry. `pending_deploys` was verified empty before the loop was switched off.

Two port gaps found and fixed along the way, both live-verified:
- Nest's `DeployService` never **unpaused** after deploy (the factory deploys
  tokens PAUSED; Express did this in `finishSuite`). All 8 existing Sepolia
  tokens were checked unpaused — the gap had not bitten yet.
- `deploy-token` now honors the wizard's recorded **token plan** (tokenName,
  maxHolders/lockupDays fallback, `intendedStatus` applied once a token
  exists), and the admin health tile now calls `/api/health` (`/health` had
  404'd since cutover).

### Running it

```bash
cd rwa-token-backend-nest && npm run build && node dist/main.js   # :4100
cd rwa-token-backend      && npm run dev                          # :4000 (optional fallback)
npm run db:migrate     # applies migrations/*.sql in order
npx vitest run         # 335 passing, 2 skipped
```

---

## 3. The two ideas that explain most of the code

### Multi-tenancy is enforced by Postgres, not by application code

Every tenant-scoped query goes through `DbService.scoped(tenant, fn)`. There is
no exported pool and no unscoped query method — the unsafe path deliberately
does not exist. RLS policies are the backstop; the service layer is convenience
on top.

```ts
return this.db.scoped(tenant, (tx) => tx.select().from(offerings));
```

`TenantContext` is a discriminated union: `issuer` | `investor` | `account` |
`platform`. **Never read an issuer id from a request body, query param, or path
segment** — it comes from the verified token. Where a path *does* name an issuer
(`/api/admin/issuers/:issuerId/spv-managers`), the segment is a **filter that
must agree with the token**, never a source of authority.

Background work uses `db.worker(reason, fn)` — cross-tenant by design,
unreachable from HTTP.

### Non-custodial, with platform-managed compliance

The investor's wallet is the management key of their own ONCHAINID. The platform
deploys the identity and pays gas but holds no key that can act as them. So:

- The platform **signs claims off-chain**; the investor calls `addClaim` from
  their own wallet. Hence the two-phase `prepare` → (investor submits) →
  `confirm` flow.
- Anything the investor does on-chain (sell-back, crypto payment) is reported to
  us as a **tx hash, which is an unverified claim until we read the receipt**.
  Both paths verify sender, recipient, exact amount and success before booking
  anything. Do not weaken this.
- The platform keeps ERC-3643 **agent** powers (register, freeze,
  forced-transfer) to meet regulatory obligations. That is control over
  compliance, not custody.

---

## 4. Gotchas that cost real time

Each of these was found the hard way. They are not hypothetical.

**A cast can lie, and hide a broken feature for weeks.**
`rowsOf<Subscription>(tx.execute(sql\`SELECT * ...\`))` returns *snake_case*
columns under a camelCase type. `order.tokenSymbol` was `undefined`, settlement
called `upper(undefined)`, Postgres said *"function upper() does not exist"*.
Live settlement had never worked and `/api/investor/orders` returned snake_case
JSON. Invisible because unit tests mock the repository.
→ **Raw SQL only for shapes you spell out** (`{ id: string }` from a RETURNING).
Use the query builder for any mapped row.

**When adding RLS, ask who WRITES the row — not who owns the feature.**
Four separate migrations fixed this same mistake (050 subscriptions, 052
buyback_sales + manager_votes, 054 admins, and the investor half of 056). It
surfaces as a **500, not a 403**, because an RLS rejection on a write does not
look like a permission error at the API boundary. Give the writer the narrowest
verb that does the job — the investor claiming a distribution gets UPDATE only,
never INSERT (minting yourself a payout) or DELETE (erasing a financial record).

**Postgres rejects bind parameters in `SET LOCAL`.**
Use `SELECT set_config('app.issuer_id', $1, true)`.

**Session-scoped state does not survive a transaction pooler.**
`pg_try_advisory_lock` gave *both* instances the lock on Supabase's Supavisor.
Singleton background work uses the `worker_lease` row (migration 048). Also:
never call Drizzle's `.prepare()`.

**Nest + Fastify body parsers.** `addContentTypeParser` on the Fastify instance
throws `FST_ERR_CTP_ALREADY_PRESENT` (Nest registers its own during `init()`),
and `app.useBodyParser('application/json', …)` **collides with
`@fastify/http-proxy`**, which registers its own to stream bodies through. The
empty-JSON-body tolerance is therefore an `onRequest` hook in `main.ts` that
strips the header — it registers no parser, so both coexist.

**Circular modules need `forwardRef` on BOTH sides.** `OfferingsModule` ↔
`SubscriptionsModule`. One side alone leaves the other `undefined` at scan time.

**`tsx` does not resolve the `@shared/*` path aliases.** One-off probe scripts
must use relative imports or run under vitest.

---

## 5. Data safety — read before touching the database

This is a **live dev database with real seeded state** (11 offerings, 8 deployed
Sepolia tokens, 18 orders, investors with KYC).

> **Delete by explicit primary key only. Never by pattern.**
> `DELETE FROM subscriptions WHERE reference LIKE 'ord_%'` once wiped 18
> pre-existing orders because the pattern matched Express's format too. They were
> reconstructed from `audit_log`, but `payment_ref` and `payment_provider` are
> approximations to this day.
>
> A second incident: a cleanup script that `SELECT`ed all rows and deleted all of
> them removed three pre-existing "Initial valuation at launch" rows. Restored
> from migration 020's definition.

The working pattern: capture the ids you create **at creation time**, print the
rows you are about to delete, then delete by those ids.

---

## 6. What exists

23 modules under `src/modules/`. Migrations `039`–`057` in this repo (`001`–`038`
live in the Express repo and are already applied).

Ported and live: auth, team, issuers, SPV managers, managers, offerings (+
valuations / updates / buyback / governance), tokens, operations (maker-checker),
onboarding, KYC, AML, accreditation, investors, subscriptions (+ escrow +
crypto payment), distributions, cases, portfolio, documents, indexer, webhooks,
audit, health, misc (`/api/config`, `/api/estimate`).

**Never built in either backend** — these are new work, not ports:

| Item | Note |
|---|---|
| Per-issuer policy CRUD | Designed in `../rwa-token-backend/docs/TENANCY_MODEL.md` §9. No code. |
| Bank accounts | Part of the intended fiat flow: signup → KYC → wallet → **bank account** |
| Crypto deposit attribution | Matching an inbound transfer to the sender |
| SPV manager login | `spv_managers.admin_id` and the `spv_manager` role exist; nothing resolves the session |

---

## 7. Rules the user has set

- **Non-custodial stays.** Flow is `signup → KYC → wallet connection`. A move to
  KMS or a 2-of-2 multisig (Lofty-style) is possible later; the flow does not
  change.
- **Supabase is DEV ONLY.** Production is Postgres + the app on EC2. KYC
  documents live on an EC2 volume, never in Postgres and never in Supabase
  storage.
- **Do not delete the Express server.** Stated explicitly during cutover.
- Do not use subagents, workflows, or deep research unless asked.

---

## 8. Where to look

| Question | File |
|---|---|
| How must a module be shaped? | `CLAUDE.md` (this repo) — it is the contract |
| Why is tenancy designed this way? | `../rwa-token-backend/docs/TENANCY_MODEL.md` |
| What does a migration actually do? | `migrations/*.sql` — each explains its reasoning in the header |
| What does an endpoint promise? | The `@ApiOperation` descriptions; Swagger at `:4100/docs` |

Migration and service headers carry the *why*. When something looks
over-careful — an atomic claim, a 404 where 403 seems natural, a check that
looks redundant with RLS — the comment above it says which failure it prevents.
Read it before simplifying.

---

## 9. Suggested next steps

1. ~~Retire Express~~ — DONE 2026-08-23. All routes ported, deploy recovery
   retired, indexer handover confirmed in the Express log
   (`indexer disabled (INDEXER_ENABLED=false)`). Express is an idle fallback;
   stopping its process is now a choice, not a migration step. `LEGACY_API_URL`
   can be unset once you are comfortable dropping the proxy.
2. **New features** (§6) — per-issuer policy is the one the tenancy design is
   already waiting for.
3. **`managers` and `spv_managers` have no scoped login** — the roles exist, the
   sessions do not.
4. Consider an `issuer_admin` account for issuer 2 in dev seeds — several
   issuer-scoped routes (offering delete, asset create as non-platform) cannot
   be exercised with the current seed roster (platform_admin / agent /
   compliance only).
