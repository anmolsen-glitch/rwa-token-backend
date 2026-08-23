# rwa-token-backend-nest

NestJS rewrite of `../rwa-token-backend`, built **side by side** using the
strangler pattern. Both apps run against the **same Postgres database**, so
routes move across one module at a time with no data migration.

> **This file is the contract.** Every module in this repo looks the same. If
> you are about to write something that does not match a pattern below, the
> pattern is wrong and should be changed here first — do not write the
> one-off. Uniformity is worth more than local cleverness.

---

## 1. Stack — and why

| Concern | Choice | Why this one |
|---|---|---|
| HTTP | **Fastify** (`@nestjs/platform-fastify`) | ~2× Express throughput; first-party `@fastify/*` plugins for helmet, cors, cookies, rate-limit |
| DB | **Drizzle ORM** (`drizzle-orm/node-postgres`) | SQL-first and type-safe. Keeps the existing hand-written `migrations/*.sql`. Transactions expose the raw client, which RLS context (`set_config`) requires |
| Validation | **Zod** via `nestjs-zod` | Already used in `rwa-investor-next` — schemas can be shared. One validation library, not two |
| Config | `@nestjs/config` + Zod schema | Env validated at boot. Bad config fails at startup, never at 3am |
| Logging | `nestjs-pino` | Same pino the Express app uses; structured, with request-id correlation |
| Auth | **Custom guards**, no Passport | The JWT + httpOnly-cookie + CSRF logic already exists and works. Passport adds indirection without adding safety |
| Docs | `@nestjs/swagger` + `nestjs-zod` v5 `cleanupOpenApiDoc()` | OpenAPI generated from the same Zod schemas that validate. Docs cannot drift from reality. (v4's `patchNestJsSwagger` is incompatible with swagger v11) |
| Tests | **Vitest** | Matches the Express repo. One test runner across the monorepo |

**Migrations are owned by this repo.** The Express app reads the same tables but
no longer defines them. Never write a migration in the old repo.

---

## 2. Nest concepts, mapped to this codebase

Read this once. The request lifecycle runs in exactly this order:

```
Request
  → Middleware        (raw, rarely used here)
  → Guards            AuthGuard → TenantGuard → RolesGuard      ← authorization
  → Interceptors      LoggingInterceptor, TransactionInterceptor ← cross-cutting
  → Pipes             ZodValidationPipe                          ← input shape
  → Controller        (HTTP only)
  → Service           (business logic)
  → Repository        (SQL only)
  → Interceptors      (response side)
  → Exception Filter  AppExceptionFilter                         ← error shape
Response
```

- **Module** — a feature boundary. Declares its controllers/providers and what
  it `exports` to other modules.
- **Provider** — anything injectable (services, repositories). Registered in a
  module, injected by constructor.
- **Guard** — answers *may this request proceed?* Returns boolean. Auth lives
  here, never in a controller.
- **Pipe** — transforms/validates input. All validation is one global pipe.
- **Interceptor** — wraps the handler; can act before and after.
- **Exception filter** — turns thrown errors into HTTP responses. One filter,
  one error shape.

Rule of thumb: if you are writing an `if` in a controller, it belongs in a
guard (authorization), a pipe (input shape), or the service (business rule).

---

## 3. Folder structure

```
src/
  main.ts                     # bootstrap: Fastify adapter, plugins, global pipe/filter
  app.module.ts               # imports every feature module + shared
  shared/                     # cross-cutting infra ONLY — no business logic
    config/                   # env schema + ConfigModule
    db/                       # drizzle client, schema/, tenant-scoped connection
    auth/                     # guards, decorators, jwt + cookie/CSRF helpers
    chain/                    # ethers provider, signer (local|KMS), tx submission
    errors/                   # AppError + global exception filter
    logging/                  # pino config, request-id
  modules/
    <domain>/
      <domain>.module.ts
      <domain>.controller.ts
      <domain>.service.ts
      <domain>.repository.ts
      dto/
        <action>.dto.ts       # Zod schema + inferred type, colocated
      <domain>.service.spec.ts
migrations/                   # hand-written .sql — the single source of schema truth
test/                         # e2e / integration
```

Domains mirror `../rwa-token-backend/docs/API_RESTRUCTURE_PLAN.md`:
`auth`, `issuers`, `offerings`, `tokens`, `onboarding`, `investors`,
`subscriptions`, `distributions`, `managers`, `governance`, `buyback`,
`operations`, `cases`, `audit`, `webhooks`, `indexer`.

**Modules talk only through exported services.** Never import another module's
repository. Never import a file that is not exported by that module.

---

## 4. The canonical module

Every module is these four files. No variations.

### 4.1 DTO — Zod schema, colocated

```ts
// modules/offerings/dto/create-offering.dto.ts
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateOfferingSchema = z.object({
  name: z.string().min(1).max(200),
  tokenSymbol: z.string().regex(/^[A-Z0-9]{2,12}$/).optional(),
  pricePerToken: z.coerce.bigint().positive(),   // paise — integer money, never float
  targetRaise: z.coerce.bigint().positive(),
  country: z.number().int(),
});

export class CreateOfferingDto extends createZodDto(CreateOfferingSchema) {}
```

Money is **integer minor units** (paise), never floats. Carried over from the
Express repo's integer-paise decision — do not reintroduce `NUMERIC` floats.

### 4.2 Controller — HTTP only

```ts
// modules/offerings/offerings.controller.ts
@Controller('offerings')
export class OfferingsController {
  constructor(private readonly offerings: OfferingsService) {}

  @Get()
  @Roles('issuer_admin', 'compliance')
  list(@Tenant() tenant: TenantContext) {
    return this.offerings.list(tenant);
  }

  @Post()
  @Roles('issuer_admin')
  create(@Tenant() tenant: TenantContext, @Body() dto: CreateOfferingDto) {
    return this.offerings.create(tenant, dto);
  }
}
```

A controller may **only**: declare the route, declare authorization decorators,
bind params, call exactly one service method, return its result. No `if`, no
`try/catch`, no SQL, no `await` chains. If a controller is longer than ~5 lines
per handler, logic has leaked into it.

### 4.3 Service — business logic, owns transactions

```ts
@Injectable()
export class OfferingsService {
  constructor(
    private readonly repo: OfferingsRepository,
    private readonly policy: PolicyService,
  ) {}

  async create(tenant: TenantContext, dto: CreateOfferingDto) {
    const policy = await this.policy.effective(tenant.issuerId);
    if (dto.targetRaise < policy.minTargetRaise) {
      throw new AppError('OFFERING_BELOW_MINIMUM', 422, 'Target raise is below this issuer’s minimum.');
    }
    return this.repo.insert(tenant, dto);
  }
}
```

Services know nothing about HTTP — no `Request`, no `Response`, no status codes
except via `AppError`. That is what makes them unit-testable without a server.

### 4.4 Repository — SQL only

```ts
@Injectable()
export class OfferingsRepository {
  constructor(private readonly db: DbService) {}

  list(tenant: TenantContext) {
    return this.db.scoped(tenant, (tx) => tx.select().from(offerings));
  }
}
```

Repositories contain **no business rules** — no policy checks, no branching on
domain state. One repository per module; it touches only that module's tables.

---

## 5. Uniform rules (the "unipattern")

These exist so any file is predictable from its name alone.

**Layering.** `controller → service → repository`. Never sideways, never
backwards. A service may call another module's *service* (via its export),
never its repository.

**Validation.** One global `ZodValidationPipe`. Zod schemas only — no
`class-validator`, no manual `if (!body.x)`.

**Errors.** One `AppError(code, status, message, details?)` and one global
filter. Every error response is:

```json
{ "error": { "code": "OFFERING_BELOW_MINIMUM", "message": "…", "details": {} } }
```

`code` is a stable SCREAMING_SNAKE string clients may branch on. `message` is
for humans and may change. Never leak a stack trace or a driver error.

**Success responses are bare resources** — no `{ data: … }` envelope. Lists are
`{ items, nextCursor }`. Pick one and never mix.

**Every route is documented the same way.** `@ApiTags` on the controller,
`@ApiOperation` with a summary on each handler, and error responses from the
shared decorators in `shared/openapi/api-error.decorator.ts` — never a
hand-written `@ApiResponse` for a standard error, because that is how docs drift
from the filter's actual output. `@ApiAuthErrors()` goes on the controller when
every route needs auth; put it on the handler when only some do. Request bodies
document themselves: `createZodDto` + `cleanupOpenApiDoc()` derive the schema
(types, enums, patterns, min/max) from the SAME Zod schema that validates, so
they cannot disagree.

**Route layout — prefixed by AUDIENCE.** The intended caller is visible in the
path, without reading auth decorators:

| Prefix | Audience | Session |
|---|---|---|
| `/api/admin/*` | back-office: platform operators, issuer staff | `admin` |
| `/api/investor/*` | investor self-service | `account` |
| unprefixed | public, no session (`/api/health`, `/api/offerings/public`) | none |

There are two logins and they are NOT interchangeable:
`/api/admin/auth/login` authenticates against `admins`; `/api/investor/login`
against `accounts`. Different credential stores, different cookies, different
`typ`. A token from one is rejected by the other.

The public marketplace lives in its OWN controller
(`PublicOfferingsController`), not as a `@Public()` route hiding inside the
admin one — so `grep "@Controller('admin"` is an accurate list of the
back-office surface.

**Naming.**
- Files `kebab-case.ts`; classes `PascalCase`; everything else `camelCase`.
- Routes are plural nouns: `/offerings`, `/offerings/:id/documents`.
- Non-CRUD actions are sub-resources, not verbs:
  `POST /operations/:id/approvals` — **not** `POST /approveOperation`.
- DB columns `snake_case`; TS properties `camelCase`. Drizzle maps between them
  in the schema file, so the mapping exists in exactly one place.

**Async.** Always `async/await`. No floating promises, no `.then()` chains.

**Types.** `any` is banned. Use `unknown` and narrow. Types are inferred from
Zod schemas and Drizzle schemas — do not hand-write a type that already exists.

---

## 6. Auth and tenancy

Implements `../rwa-token-backend/docs/TENANCY_MODEL.md`. Read it before touching
anything in `shared/auth` or `shared/db`.

### Session types

Three, distinguished by the JWT `typ` claim and by cookie:

| Session | Cookie | `typ` | Who |
|---|---|---|---|
| `admin` | `rwa_admin_token` | `admin` | Back-office operators |
| `account` | `rwa_account_token` | `account` | The investor as a PERSON (pre-wallet) |
| `investor` | `rwa_investor_token` | `investor` | A proven wallet, via SIWE |

A route declares what it accepts with `@Session('account')`. **Absent, it
defaults to `admin`** — the back office stays locked down by omission rather
than by remembering to annotate.

All three are signed with the same secret, so **`typ` is the only thing keeping
them apart**: verifying against the required type is what stops an investor
token being replayed on an admin route. Token extraction also never falls back
to another type's cookie — a browser can legitimately hold two at once, and
picking the wrong one would authenticate the wrong principal.

Three guards, always in this order, applied globally and opted out of with
`@Public()`:

1. **`AuthGuard`** — verifies the JWT from the httpOnly cookie, checks CSRF on
   mutations, populates `req.principal`.
2. **`TenantGuard`** — resolves `TenantContext` from the principal. Sets
   *exactly one* of `issuerId` (issuer-side caller) or `investorWallet`
   (investor-side caller). `platform_admin` gets `{ platform: true }`.
3. **`RolesGuard`** — enforces `@Roles(...)`.

```ts
export type TenantContext =
  | { kind: 'issuer';   issuerId: string }
  | { kind: 'investor'; investorWallet: string }
  | { kind: 'account';  accountId: string }   // person, pre-wallet
  | { kind: 'platform' };
```

`account` exists because the investor flow is **sign up → KYC → connect
wallet**: for steps 1–2 there is a signed-in person with no wallet to scope by.

**Never read `issuerId` from the request body or a query param.** It comes from
the verified token, only, always. This is the single most important security
rule in this repo.

`platform_admin` bypasses tenant scoping by design, so every `platform` request
writes an audit row. No exceptions.

---

## 7. Database access

**`DbService.scoped(tenant, fn)` is the only way to get a connection.** There is
no exported pool and no unscoped query method. This is deliberate: an unscoped
query is a cross-tenant leak, so the unsafe path must not exist.

```ts
// The RLS context is set for you; `tx` is a normal drizzle query handle.
return this.db.scoped(tenant, (tx) => tx.select().from(offerings));
```

RLS context requires a transaction, so `scoped()` opens one and sets exactly one
of `app.issuer_id` / `app.investor_wallet` / `app.is_platform` before running
your callback. There is no chained `scoped(tenant).select()` form — that would
imply a connection you can hold onto outside a transaction.

Background workers use `db.worker(reason, fn)`, which is cross-tenant by design
and logs the supplied reason. It is unreachable from an HTTP request.

`SET LOCAL` (not `SET`) is mandatory — it is scoped to the transaction, so
context cannot leak into the next checkout of a pooled connection. **This is the
classic RLS + pooling bug.** There is a required regression test for it
(§9).

Three DB roles, per the tenancy doc: `app_tenant` (RLS enforced), `app_platform`
(policy bypass, audited), `app_worker` (`BYPASSRLS`, for the indexer and webhook
consumers only — no human ever authenticates as this role).

**Transactions belong to services**, never repositories. A repository method
must be composable inside a caller's transaction.

**Migrations are hand-written SQL** in `migrations/`, numbered sequentially,
continuing from the Express repo's `038`. Drizzle schema files in
`shared/db/schema/` describe the *existing* tables for typing — they do not
generate DDL. If schema and migration disagree, the migration is correct.

### 7.1 Environments

**Supabase is DEV ONLY.** Production is Postgres and the app on **EC2**. Keep
that split in mind when reading the constraints below: some are Supabase
artifacts that disappear in production, and some are design rules that hold
everywhere.

| | Dev | Production |
|---|---|---|
| Postgres | Supabase free tier, `ap-southeast-1` | EC2 / RDS |
| Connection | Supavisor transaction pooler, port 6543 | direct |
| KYC documents | local disk | EC2 volume (EBS) |

**Holds everywhere:** `set_config(..., true)` for RLS context, the
`app_tenant` / `app_worker` / owner role split, and never running the app as a
table owner. Production is in fact *easier* — you control the roles outright
instead of working around a managed `postgres` superuser.

**Supabase-only:** the free-tier 500 MB cap, the IPv6-only direct connection,
and the pooler quirks below.

### 7.2 Supabase specifics (dev)

The dev database is reached through the **Supavisor transaction pooler on port
6543** — the same URL the Express app uses. Four consequences:

**1. `SET LOCAL` is the only thing that works.** In transaction-pooling mode a
client does not keep a dedicated backend between transactions, so a session-level
`SET` is silently discarded and every RLS policy would see an unset context.
`SET LOCAL` is transaction-scoped and therefore correct. This is not a style
preference here — plain `SET` produces an app where RLS appears configured and
enforces nothing.

**1b. Session-scoped state is meaningless here — and that includes locks.**
The same reason `SET LOCAL` is required also breaks `pg_try_advisory_lock`:
Supavisor multiplexes sessions across backends, so two processes can BOTH
acquire the same advisory lock (measured 2026-08-22 — they landed on different
backends). Use the `worker_lease` row (migration 048) for singleton background
work instead; it is pooling-agnostic and self-heals when a holder dies.

**2. Never call Drizzle's `.prepare()`.** Named prepared statements do not
survive transaction pooling. Plain queries use the unnamed statement path and
are fine; `.prepare()` will fail intermittently under load, which is the worst
way to find out.

**3. RLS is live (migration 042), and the connection role is what makes it
work.** The `postgres` role owns every table AND has `BYPASSRLS`, which
overrides `FORCE ROW LEVEL SECURITY` — connecting as `postgres` makes every
policy decorative. So the app uses three distinct connections:

| Env var | Role | RLS | Used by |
|---|---|---|---|
| `DATABASE_URL` | `app_tenant_login` | **enforced** | every HTTP request |
| `DATABASE_WORKER_URL` | `app_worker_login` | bypassed | `db.worker()` only — indexer, webhooks, pre-tenant auth lookup |
| `DATABASE_ADMIN_URL` | `postgres` | bypassed | `db:migrate` / `db:setup-roles` **only**, never the running app |

Two traps, both silent:

- **Role attributes are not inherited.** `GRANT app_worker TO app_worker_login`
  passes on privileges but NOT `BYPASSRLS`/`SUPERUSER`/`CREATEDB`. Those must be
  set on the login role directly. `db:setup-roles` sets and then asserts this in
  both directions.
- **Never give the tenant role `BYPASSRLS`.** The worker getting it wrong fails
  loudly (reads nothing, auth breaks). The tenant role getting it wrong fails
  silently — it reads everything and no test notices. `test/tenant-isolation.spec.ts`
  asserts `rolbypassrls = false` for exactly this reason.

Tables under RLS today: `offerings`, `issuers`, `admins`, `tokens`,
`investors`, `subscriptions`, `balances`, `transfers`,
`issuer_investor_acceptance`. Each future module brings its own tables under
policy as it migrates.

**Dual-axis tables** (`subscriptions`, `balances`, `transfers`) have two-branch
policies: an investor matches on their wallet across every issuer, an issuer
matches through `offerings`/`tokens` across every investor. Cap-table membership
is centralised in the `app_issuer_sees_investor(wallet)` SQL function —
`SECURITY DEFINER`, because it must read the underlying tables without the
caller's own RLS filtering them first, which would make membership
self-referential.

**4. Direct connections (port 5432) are IPv6-only** on new Supabase projects.
Use the pooler URL everywhere — local dev, CI, production.

**Free-tier limits (dev only):** 500 MB of database storage, and projects pause
after 7 days of inactivity.

### 7.3 KYC document storage

Migration 046 moved documents OUT of Postgres. `kyc_documents.content` held
base64 (~33% inflation on already-large scans); the table went from ~8.5 MB to
184 kB. That was never really about the free tier — identity documents in the
row bloat every backup, every replica, and every `SELECT *` that forgets to
exclude the column.

Bytes now go through the seam in `shared/storage/`. `LocalDiskStorage` is the
EC2 target; S3 later is a new implementation of `DocumentStorage`, not a change
at any call site.

Four properties, all tested in `local-disk.storage.spec.ts`:

- **AES-256-GCM at rest.** A mislaid EBS snapshot must not be a pile of readable
  passports. GCM is authenticated, so a tampered file throws instead of
  decrypting to altered bytes. `DOCUMENT_ENCRYPTION_KEY` (32 bytes, base64) is
  **required in production** — StorageModule refuses to boot without it.
- **Server-generated opaque keys** (`<accountId>/<random>`). The user's filename
  never touches the path, which removes traversal as a category rather than
  sanitising for it. Sharding by account also makes an erasure request a
  directory removal.
- **Never served statically.** No public route reaches the storage root; every
  read goes through an authenticated endpoint, and every reviewer read writes a
  `kyc.document_read` audit row.
- **0600 files, 0700 directories.**

**Two operational limits, stated plainly:**

1. Local disk is tied to ONE instance — a second app server cannot read what the
   first wrote. Run one instance, or move to S3/EFS before scaling out.
2. These files are **not in the Postgres backup**. They need their own EBS
   snapshot schedule, or a database restore yields rows pointing at missing
   documents.

---

## 8. Security baseline

Non-negotiable, verified in review:

- Secrets from env only, validated by the Zod config schema at boot. Nothing
  secret in code, logs, or error responses.
- Every mutating route requires CSRF; every route is authenticated unless
  explicitly `@Public()`.
- Rate limiting per issuer and per IP (`@fastify/rate-limit`). Quotas are
  platform-set, never issuer-configurable.
- PII (`investors`, `kyc_documents`, `aml_screenings`) is read only through a
  dedicated service method that writes an audit row. Never a bare select.
  Implemented: `InvestorsService.detail()` calls `AuditService.recordPiiAccess`
  for every non-self read. List endpoints return summaries with no PII, so
  browsing does not flood the audit trail and hide the reads that matter.
  Audit writes go through the WORKER connection so an actor can never suppress
  their own trail by manipulating tenant scope.
- Chain writes go through `TxService.submit()` and the approval-threshold flow.
  Under `SIGNER_TYPE=kms` no private key ever reaches this process.
  `SignerService` REFUSES to boot in production while any role would fall back
  to a Hardhat dev key — those are published keys, and booting mainnet with one
  hands mint/freeze/forced-transfer to anyone. Asserted in
  `signer.service.spec.ts`.
- Never log a signer address alongside its role in a way that maps keys to
  powers; `signerMode()` reports the mode only.
- Log structured, never log a token, cookie, signature, or document body.

---

## 9. Testing

- **Unit** — services with mocked repositories. The bulk of the tests.
- **Integration** — repositories against real Postgres.
- **Required regression test:** two requests for different tenants routed
  through the same pooled connection; assert the second cannot see the first's
  rows. This test is the reason RLS exists — it must never be skipped.
- Ported hardened logic (escrow races, webhook replay, indexer reorg, KMS
  signer) keeps its **existing tests passing unchanged**. Those tests are the
  safety net for the whole migration; if one needs editing to pass, the port is
  wrong.
  Done so far: `kms-signer.ts` copied VERBATIM and its test carried over with
  only the import path changed (`test/kms-signer.spec.ts`); it stays gated
  behind `RUN_KMS_TESTS`. `signer.service.spec.ts` additionally pins the
  Hardhat addresses each dev role must derive to, which catches a port that
  swapped or mangled a key — the silent failure mode of this kind of migration.

---

## 10. Deliberately NOT doing

Over-engineering is the main risk in a Nest codebase. These are out of scope
until a concrete need appears — and "we might need it" is not one:

- **CQRS / event sourcing / `@nestjs/cqrs`.** A REST API over Postgres.
- **Microservices, gRPC, message brokers.** One deployable.
- **Generic `BaseService<T>` / `BaseRepository<T>` abstractions.** They save a
  few lines and destroy readability. Every module writes its own four files.
- **Passport.** Custom guards, already justified above.
- **GraphQL.** The Next BFF consumes REST.
- **BullMQ / job queues.** The indexer is a scheduled service until there is a
  measured reason otherwise.
- **Repository interfaces with a single implementation.** Add the interface when
  the second implementation exists.
- **Barrel files everywhere.** Only module-level `index.ts` for the public API.

---

## 11. Migration order

Follow `TENANCY_MODEL.md` §6 for backfill. Route order:

1. Scaffold + Fastify + global pipe/filter/guards; Nest proxies unmatched routes
   to the Express app. Everything keeps working from day one.
2. `auth` + tenancy — everything downstream depends on the JWT shape.
3. `issuers`, `offerings`, `tokens` — read-heavy and low-risk; learn the
   patterns on cheap code.
4. `investors`, `onboarding`, `subscriptions` — PII and money.
5. `operations`, `webhooks`, `indexer` — the hardened logic. Port, do not
   rewrite.

A route is "migrated" only when its Express counterpart is **deleted**. Two
implementations of one route is the failure mode this whole plan exists to
avoid.

---

## 12. Custody model

Decided 2026-08-20: **non-custodial + platform-managed compliance + independent
claim issuer.** Every chain-touching module must respect all three.

### Non-custodial
The investor's wallet is the MANAGEMENT key of their own ONCHAINID. The platform
deploys the identity contract and pays gas, but holds no key that can act as the
investor. Consequences:

- The platform **signs claims off-chain** and returns them; the investor calls
  `addClaim` from their own wallet. Hence the two-phase
  `prepare` → (investor submits) → `confirm` flow in `modules/onboarding`.
- `getInvestorSigner` from the Express app (which derived an investor key from
  the Hardhat mnemonic) is **deliberately not ported**. Do not reintroduce it.
  If a flow seems to need it, the flow is wrong.

### Platform-managed compliance
The platform keeps ERC-3643 **agent** powers — `registerIdentity`, freeze,
forced-transfer — so it can meet regulatory obligations and honour court orders.
That is control over compliance, not custody: agent powers cannot move tokens to
an arbitrary destination outside the compliance rules, and the investor's
holdings stay in the investor's wallet.

### Independent claim issuer
The attesting key is HOT (signs on every KYC approval); the deployer/agent keys
hold mint and freeze. They must not be the same key, or one compromise of the
busiest signing path yields token control too.

ERC-734 provides the split: a cold **MANAGEMENT** key (purpose 1) that can add
and remove keys, and a hot **CLAIM** key (purpose 3) that only attests.

> **The trap:** OnchainID's `keyHasPurpose()` returns true for a MANAGEMENT key
> on ANY purpose. A setup with ZERO purpose-3 keys therefore looks perfectly
> healthy — claims sign, verify, and onboard without error. The missing
> separation is invisible unless you check for it, which is why
> `ClaimIssuerService.verifyIndependence()` exists, runs at boot, and reports on
> `/health`. "It can sign claims" proves nothing about independence.

**Status on sepolia (rotated 2026-08-21).** A dedicated purpose-3 CLAIM key
`0xFE960Daf…` is registered on ClaimIssuer `0x69E99ca4…`
(tx `0xf0de2ff0…`, block 11537201) and `CLAIMISSUER_PRIVATE_KEY` points at it.
`/health` reports `claimIssuer.independent: true`.

Rotate with `npm run chain:rotate-claim-key -- --confirm` (dry-runs without the
flag). The claim key **never sends a transaction**, so it needs no ETH — which
is also why rotating it is cheap and has no funds to sweep. Adding a claim key
is additive: claims already signed by the management key stay valid, verified
via `isClaimValid`.

**Residual risk, deliberately accepted for now:** `0xb475…` remains the
MANAGEMENT key, so it can still sign claims and can re-add itself at any time.
Full separation needs that key moved to a multisig. Until then "independent"
means the *configured attesting key* is scoped to attestation — not that the
platform is incapable of attesting by other means.
