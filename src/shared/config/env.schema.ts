/**
 * Environment schema.
 *
 * Every env var the app reads is declared here once, with a type and a default.
 * `validateEnv` runs at boot — a bad or missing value crashes the process at
 * startup rather than surfacing as a confusing 500 at 3am.
 *
 * Rule: nothing in this repo reads `process.env` directly. Inject ConfigService
 * and read a typed key instead. Grep for `process.env` outside this file — any
 * hit is a bug.
 */
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.toLowerCase() === 'true'));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),

  /* Shared with the Express app — same database, per the strangler plan.
     On Supabase use the TRANSACTION POOLER (port 6543), not a direct 5432
     connection: direct connections are IPv6-only on new projects and the free
     tier's connection budget is small. See CLAUDE.md §7.1. */
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  /* Supabase terminates TLS and requires SSL. 'no-verify' skips CA validation
     (fine for the pooler, which presents a cert for a different hostname);
     supply DATABASE_CA_CERT to verify properly. */
  /* Cross-tenant connection for background workers and pre-tenant auth
     lookups. Authenticates as app_worker_login (BYPASSRLS). If unset, worker
     queries fall back to DATABASE_URL — correct only before migration 042,
     since after it the tenant role cannot read unscoped. */
  DATABASE_WORKER_URL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined))
    .pipe(z.string().url().optional()),

  DATABASE_SSL: z.enum(['disable', 'no-verify', 'verify']).default('no-verify'),
  DATABASE_CA_CERT: z.string().optional(),

  /* Keep modest: the Express app holds its own pool against the same Supabase
     project, and the free tier's budget is shared between them. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(20).default(5),

  /* Must match the Express app exactly, or sessions break when a user's
     request lands on the other service mid-migration. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  INVESTOR_JWT_EXPIRES_IN: z.string().default('7d'),

  COOKIE_SECURE: bool(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(102_400),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  TRUST_PROXY: bool(false),

  /* Strangler: anything this app has not implemented yet is proxied to the
     Express backend. Unset it once every route has been migrated.
     An empty string counts as unset — shells and CI often pass "" for absent. */
  LEGACY_API_URL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined))
    .pipe(z.string().url().optional()),

  /* --- chain ------------------------------------------------------------ */
  NETWORK: z.string().default('localhost'),
  /** Block-explorer base for tx/address links. Empty on local Hardhat. */
  EXPLORER_URL: z.string().default(''),
  /** Valuation estimator seam — see shared/valuation. */
  ESTIMATOR_PROVIDER: z.string().default('mock'),
  RPC_URL: z.string().url().default('http://127.0.0.1:8545'),

  /* Separate connection for indexer log scanning so backfill traffic and the
     request path cannot starve each other's rate budget. */
  INDEXER_RPC_URL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined))
    .pipe(z.string().url().optional()),

  /* ethers' default is ~5 MINUTES. A throttled RPC sits on requests rather than
     refusing them, which once held /health open for 281s. Fail fast instead. */
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /* local = plain keys (DEV ONLY). kms = keys never leave AWS KMS.
     SignerService refuses to boot in production with dev keys. */
  /* Compliance module addresses, from the contracts deploy. */
  MAXHOLDERS_MODULE: z.string().optional(),
  LOCKUP_MODULE: z.string().optional(),

  /* Payment rail. */
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe', 'stablecoin']).default('mock'),
  /* How long a reservation holds supply before it is released. */
  ORDER_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  /* Where crypto payments are sent when an offering has no seller wallet. */
  /**
   * Order sweeper (abandoned reservations + stuck settlements).
   *
   * DEFAULT OFF, exactly like INDEXER_ENABLED, and for the same reason: the
   * Express app is still sweeping the same database during the strangler
   * migration. Both are idempotent — every transition is a conditional UPDATE,
   * so nothing corrupts — but two sweepers means two sets of audit rows and no
   * single owner of the schedule. Turn this on in the same change that turns
   * Express's off.
   */
  SWEEPER_ENABLED: z.coerce.boolean().default(false),
  CRYPTO_PAYTO_WALLET: z.string().default('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),

  /* Maker-checker thresholds. 0 = execute immediately (no four-eyes).
     force-transfer defaults to 2 because it moves someone else's holdings
     without their consent — the most dangerous power the platform has. */
  APPROVAL_THRESHOLD: z.coerce.number().int().min(0).default(1),
  APPROVAL_THRESHOLD_FORCE_TRANSFER: z.coerce.number().int().min(0).default(2),

  /* Indexer. DISABLED BY DEFAULT: during the strangler migration Express is
     still indexing, and two indexers on one database double the RPC load (the
     2026-07-24 saturation incident) and fight over the same cursor. */
  INDEXER_ENABLED: bool(false),
  INDEXER_POLL_MS: z.coerce.number().int().min(1000).default(10_000),
  INDEXER_CHUNK: z.coerce.number().int().positive().default(2000),
  INDEXER_START_BLOCK: z.coerce.number().int().default(-1),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(0),
  INDEXER_REORG_DEPTH: z.coerce.number().int().positive().default(12),
  INDEXER_HASH_RETENTION: z.coerce.number().int().positive().default(500),
  INDEXER_RESET_CONFIRM_MS: z.coerce.number().int().positive().default(120_000),

  /* Webhooks. Providers sign the RAW body with this shared secret. */
  WEBHOOK_SECRET: z.string().default('dev-only-webhook-secret'),

  /* AML screening seam. The demo watchlists let a sanctions block and a
     manual-review case be demonstrated deliberately. */
  AML_PROVIDER: z.enum(['mock', 'chainalysis', 'trm']).default('mock'),
  AML_SANCTIONED: z.string().default(''),
  AML_REVIEW: z.string().default(''),

  /* Document storage. Local disk is the EC2 deployment target; the seam in
     shared/storage/ makes S3 a new implementation, not a call-site change. */
  DOCUMENT_STORAGE_BACKEND: z.enum(['local-disk', 's3']).default('local-disk'),
  DOCUMENT_STORAGE_ROOT: z.string().default('./var/kyc-documents'),

  /* 32 bytes, base64. REQUIRED in production: unencrypted identity documents on
     an EBS volume are a breach waiting for a mislaid snapshot. */
  DOCUMENT_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined)),

  DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  /* Image uploads (offering photos). Public + rate-limited: a prospective
     seller uploads before applying, so there is no session to require. Local
     disk is the seam, same as documents — S3 is a new backend, not a call-site
     change. Base URL is what the returned image links are built from; it must
     be the FRONT DOOR (this app), not the legacy one. */
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:4100')
    .transform((s) => s.replace(/\/+$/, '')),
  UPLOADS_DIR: z.string().default('./uploads'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(6 * 1024 * 1024),
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  /* Email seam. 'mock' logs the body (including one-time codes) and is refused
     in production by MailModule. */
  MAIL_PROVIDER: z.enum(['mock', 'ses', 'sendgrid']).default('mock'),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  SIGNER_TYPE: z.enum(['local', 'kms']).default('local'),

  /* SIWE (EIP-4361). Server-controlled, never request-supplied — a wallet shows
     these to the user, so a phishing origin displays as a mismatch. */
  SIWE_DOMAIN: z.string().default('localhost:5174'),
  SIWE_URI: z.string().default('http://localhost:5174'),
  SIWE_CHAIN_ID: z.coerce.number().int().default(31337),
  NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /* Operational signing keys, one per role. Optional: absent means the local
     path falls back to a Hardhat DEV key, which SignerService refuses in
     production. Declared here because nothing in this repo may read
     process.env directly — and a key that is silently not picked up is exactly
     the bug that omission caused. */
  DEPLOYER_PRIVATE_KEY: z.string().optional(),
  AGENT_PRIVATE_KEY: z.string().optional(),
  CLAIMISSUER_PRIVATE_KEY: z.string().optional(),

  KMS_KEY_ID_DEPLOYER: z.string().optional(),
  KMS_KEY_ID_AGENT: z.string().optional(),
  KMS_KEY_ID_CLAIMISSUER: z.string().optional(),

  /* Deployed-contract address book written by the contracts project. */
  ADDRESSES_FILE: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined)),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
