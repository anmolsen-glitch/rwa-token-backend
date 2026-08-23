import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { Acceptance, Investor, Subscription } from '@shared/db/schema';
import { InvestorsRepository } from './investors.repository';

/**
 * The non-identifying view. Safe to return in lists — no name, no email, no
 * KYC detail. An issuer browsing its cap table does not need PII for every row,
 * and returning it would generate an audit entry per listing rather than per
 * genuine access.
 */
export interface InvestorSummary {
  wallet: string;
  onchainid: string | null;
  country: number | null;
  kycStatus: string;
  verified: boolean;
  createdAt: string;
}

/** The identifying view. Every read of this is audited. */
export interface InvestorDetail extends InvestorSummary {
  name: string | null;
  email: string | null;
  kycVersion: string;
  kycSubmittedAt: string | null;
  acceptance: AcceptanceView | null;
  subscriptions: Array<{
    reference: string;
    offeringId: string;
    tokenSymbol: string;
    status: string;
    tokens: number;
    amountFiat: string;
    currency: string;
    createdAt: string;
  }>;
}

export interface AcceptanceView {
  issuerId: string;
  status: string;
  kycVersion: string;
  decidedAt: string;
  note: string | null;
  /** True when the KYC has been re-run since this decision — re-confirm. */
  stale: boolean;
}

const PII_FIELDS = ['name', 'email', 'kycSubmittedAt'];

@Injectable()
export class InvestorsService {
  constructor(
    private readonly repo: InvestorsRepository,
    private readonly audit: AuditService,
  ) {}

  private static summary(i: Investor): InvestorSummary {
    return {
      wallet: i.wallet,
      onchainid: i.onchainid,
      country: i.country,
      kycStatus: i.kycStatus,
      verified: i.verified,
      createdAt: i.createdAt.toISOString(),
    };
  }

  private static acceptanceView(a: Acceptance, investorKycVersion: string): AcceptanceView {
    return {
      issuerId: a.issuerId,
      status: a.status,
      kycVersion: a.kycVersion,
      decidedAt: a.decidedAt.toISOString(),
      note: a.note,
      /* TENANCY_MODEL §5.3: an acceptance resting on a superseded verification
         must be visibly stale rather than quietly trusted. */
      stale: BigInt(a.kycVersion) < BigInt(investorKycVersion),
    };
  }

  /**
   * List investors. RLS restricts an issuer to its own cap table (migration
   * 044), so this returns the caller's legitimate slice without an explicit
   * join. Summaries only — no PII, so no audit row per listing.
   */
  async list(tenant: TenantContext): Promise<{ items: InvestorSummary[] }> {
    const rows = await this.repo.list(tenant);
    return { items: rows.map(InvestorsService.summary) };
  }

  /**
   * Full record including PII. THE audited path (TENANCY_MODEL §5.2).
   *
   * An investor reading their own record is not an issuer-side PII access, so
   * it is not audited as one — auditing self-reads would bury the entries that
   * matter in noise.
   */
  async detail(
    principal: Principal,
    tenant: TenantContext,
    wallet: string,
  ): Promise<InvestorDetail> {
    const investor = await this.repo.findByWallet(tenant, wallet);
    /* 404 rather than 403: for an issuer caller, RLS already hid non-cap-table
       investors, and distinguishing "exists but not yours" would disclose that
       the platform knows this wallet. */
    if (!investor) throw AppError.notFound('Investor', wallet);

    if (tenant.kind !== 'investor') {
      await this.audit.recordPiiAccess(principal, tenant, investor.wallet, PII_FIELDS);
    }

    const subs = await this.repo.subscriptionsFor(tenant, investor.wallet);

    let acceptance: AcceptanceView | null = null;
    if (tenant.kind === 'issuer' && investor.accountId) {
      const row = await this.repo.acceptanceFor(tenant, tenant.issuerId, investor.accountId);
      if (row) {
        /* Compare against the PERSON's version — acceptance is keyed on
           accounts.id, so using the wallet row's version would compare two
           different subjects (migration 045). */
        const personVersion =
          (await this.repo.accountKycVersion(investor.accountId)) ?? investor.kycVersion;
        acceptance = InvestorsService.acceptanceView(row, personVersion);
      }
    }

    return {
      ...InvestorsService.summary(investor),
      name: investor.name,
      email: investor.email,
      kycVersion: investor.kycVersion,
      kycSubmittedAt: investor.kycSubmittedAt?.toISOString() ?? null,
      acceptance,
      subscriptions: subs.map(InvestorsService.subscriptionView),
    };
  }

  private static subscriptionView(s: Subscription) {
    return {
      reference: s.reference,
      offeringId: s.offeringId,
      tokenSymbol: s.tokenSymbol,
      status: s.status,
      tokens: s.tokens,
      amountFiat: s.amountFiat,
      currency: s.currency,
      createdAt: s.createdAt.toISOString(),
    };
  }

  /**
   * Record this issuer's reliance decision on the platform's KYC.
   *
   * The issuer is deciding for ITSELF — issuerId comes from the verified tenant
   * context, never from the request. The RLS WITH CHECK on the acceptance table
   * enforces the same thing at the database, so a bug here cannot write a
   * decision on another issuer's behalf.
   */
  async decideAcceptance(
    principal: Principal,
    tenant: TenantContext,
    wallet: string,
    status: 'accepted' | 'rejected' | 'pending_review',
    note?: string,
  ): Promise<AcceptanceView> {
    if (tenant.kind !== 'issuer') {
      throw AppError.forbidden('Only an issuer can record an acceptance decision.');
    }

    const investor = await this.repo.findByWallet(tenant, wallet);
    if (!investor) throw AppError.notFound('Investor', wallet);

    if (!investor.accountId) {
      /* Acceptance is a decision about a PERSON (accounts.id), because one
         person may link several wallets. A wallet with no account cannot be
         accepted without silently deciding about the wrong subject. */
      throw AppError.unprocessable(
        'INVESTOR_HAS_NO_ACCOUNT',
        'This wallet is not linked to an investor account, so an acceptance decision cannot be recorded against a person.',
        { wallet: investor.wallet },
      );
    }

    /* Pin the PERSON's version, not the wallet row's. */
    const personVersion =
      (await this.repo.accountKycVersion(investor.accountId)) ?? investor.kycVersion;

    const saved = await this.repo.upsertAcceptance(tenant, {
      issuerId: tenant.issuerId,
      investorId: investor.accountId,
      status,
      kycVersion: personVersion,
      decidedBy: principal.id,
      note,
    });

    await this.audit.record(principal, tenant, {
      action: 'investor.acceptance_decided',
      target: investor.wallet,
      params: { status, kycVersion: personVersion, note: note ?? null },
    });

    return InvestorsService.acceptanceView(saved, personVersion);
  }
}
