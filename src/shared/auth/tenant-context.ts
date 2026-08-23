/**
 * Who the caller is, for data-scoping purposes.
 *
 * Implements TENANCY_MODEL.md §2.4: the platform has two crossing axes, not a
 * tenant tree. An issuer-side caller scopes by issuer; an investor-side caller
 * scopes by wallet, across all issuers. A discriminated union makes it
 * impossible to hold both at once — that ambiguity is the bug class this type
 * exists to prevent.
 *
 * TenantContext is derived from the verified JWT by TenantGuard and nothing
 * else. It is NEVER read from a body, query param, or header.
 */
export type TenantContext =
  | { readonly kind: 'issuer'; readonly issuerId: string }
  | { readonly kind: 'investor'; readonly investorWallet: string }
  /* A signed-in PERSON who may not have connected a wallet yet. The flow is
     sign up -> KYC -> connect wallet, so this is the context for steps 1-2
     (migration 045). It scopes to accounts.id, never to issuer data. */
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'platform' };

export const isIssuer = (t: TenantContext): t is Extract<TenantContext, { kind: 'issuer' }> =>
  t.kind === 'issuer';

export const isInvestor = (t: TenantContext): t is Extract<TenantContext, { kind: 'investor' }> =>
  t.kind === 'investor';

export const isAccount = (t: TenantContext): t is Extract<TenantContext, { kind: 'account' }> =>
  t.kind === 'account';

export const isPlatform = (t: TenantContext): t is Extract<TenantContext, { kind: 'platform' }> =>
  t.kind === 'platform';

/** Admin roles, per TENANCY_MODEL.md §3. */
export type AdminRole =
  | 'platform_admin'
  | 'issuer_admin'
  | 'compliance'
  | 'agent'
  | 'manager'
  | 'spv_manager';

/**
 * Which session a route requires. The JWT `typ` claim must match, so an
 * investor token cannot be replayed against an admin route and vice versa.
 */
export type SessionType = 'admin' | 'account' | 'investor';

/** The authenticated caller, before tenancy is resolved. */
export interface Principal {
  readonly kind: SessionType;
  readonly id: string;
  readonly email?: string;
  readonly role?: AdminRole;
  readonly issuerId?: string;
  readonly wallet?: string;
  readonly managerId?: string;
  /** Set for account sessions; also set on investor sessions once linked. */
  readonly accountId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    tenant?: TenantContext;
  }
}
