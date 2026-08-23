/**
 * KYC review: the platform's verification decision.
 *
 * Ported from ../rwa-token-backend/src/services/kyc.service.ts (startVerifying,
 * decide, listPending).
 *
 * TWO DELIBERATE CHANGES FROM THE EXPRESS VERSION:
 *
 * 0. THE SUBJECT IS THE PERSON (accounts), not a wallet. The flow is sign up ->
 *    KYC -> connect wallet, so KYC must exist before any wallet does
 *    (migration 045). A wallet in the URL is resolved through to its account.
 *
 * 1. PLATFORM-ONLY. The Express app let any `compliance` admin approve KYC.
 *    Under multi-tenancy that is wrong: verification is performed ONCE by the
 *    platform and relied upon by every issuer (TENANCY_MODEL.md §D2). If issuer
 *    A's compliance officer could approve, they would be verifying an investor
 *    on behalf of issuers B and C too. Issuers make ACCEPTANCE decisions
 *    (PUT /api/admin/investors/:wallet/acceptance); the platform makes VERIFICATION
 *    decisions. The role split is enforced in the controller.
 *
 * 2. APPROVAL BUMPS kyc_version. A fresh verification supersedes every issuer's
 *    prior reliance, so their acceptance surfaces as `stale: true` until they
 *    re-confirm (§5.3). Without this, an issuer keeps relying on a verification
 *    that has since been redone — possibly with a different outcome.
 *
 * NO CHAIN WRITES HAPPEN HERE. Approving KYC does not attach an on-chain claim:
 * under the non-custodial model the claim is signed at
 * POST /api/admin/onboarding/prepare and submitted by the investor themselves
 * (CLAUDE.md §12). Approval is what makes that step permissible.
 */
import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { Account } from '@shared/db/schema';
import { KycRepository, REVIEW_STATUSES } from './kyc.repository';

export interface KycQueueItem {
  accountId: string;
  email: string;
  name: string | null;
  country: number | null;
  kycStatus: string;
  kycVersion: string;
  /** 0 until the person reaches step 3 — KYC no longer requires a wallet. */
  walletCount: number;
  submittedAt: string | null;
  updatedAt: string;
}

export interface KycDecisionResult {
  accountId: string;
  email: string;
  kycStatus: string;
  kycVersion: string;
}

@Injectable()
export class KycService {
  constructor(
    private readonly repo: KycRepository,
    private readonly audit: AuditService,
  ) {}

  private static queueItem(a: Account, walletCount: number): KycQueueItem {
    return {
      accountId: a.id,
      email: a.email,
      name: a.name,
      country: a.country,
      kycStatus: a.kycStatus,
      kycVersion: a.kycVersion,
      walletCount,
      submittedAt: a.kycSubmittedAt?.toISOString() ?? null,
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  /** Submissions awaiting a decision: 'applied' and 'verifying'. */
  async pending(
    principal: Principal,
    tenant: TenantContext,
  ): Promise<{ items: KycQueueItem[] }> {
    const rows = await this.repo.listPending();

    /* The queue exposes name, email and country — PII, so the read is audited
       like any other (TENANCY_MODEL.md §5.2). */
    await this.audit.record(principal, tenant, {
      action: 'kyc.queue_read',
      params: { count: rows.length },
    });

    const items = await Promise.all(
      rows.map(async (a) => KycService.queueItem(a, await this.repo.walletCount(a.id))),
    );
    return { items };
  }

  /**
   * Apply a verified KYC-provider decision webhook.
   *
   * Ported from ../rwa-token-backend/src/services/kyc.service.ts. Translates
   * vendor language (approved/rejected) to ours (completed/rejected), matched
   * by the provider's check reference.
   *
   * IDEMPOTENT: if the decision is already applied it returns ok without
   * touching anything — providers retry, and re-applying an approval would bump
   * kyc_version again and needlessly stale every issuer's acceptance.
   *
   * There is no Principal here: the actor is the provider, not a human.
   */
  async applyProviderDecision(
    checkRef: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const account = await this.repo.byKycRef(checkRef);
    if (!account) return { ok: false, reason: 'unknown check ref' };

    const status = decision === 'approved' ? 'completed' : 'rejected';
    if (account.kycStatus === status) return { ok: true };

    await this.repo.setDecision(account.id, status, reason ?? null, decision === 'approved');

    await this.audit.record(
      { kind: 'admin', id: '0', email: null as unknown as undefined, role: undefined },
      { kind: 'platform' },
      {
        action: decision === 'approved' ? 'kyc.approve' : 'kyc.reject',
        target: account.id,
        params: { via: 'webhook', ref: checkRef, reason: reason ?? null },
      },
    );

    return { ok: true };
  }

  /** 'applied' → 'verifying'. Signals a human has picked the case up. */
  async startVerifying(
    principal: Principal,
    tenant: TenantContext,
    subject: string,
  ): Promise<KycDecisionResult> {
    const account = await this.repo.resolveSubject(subject);
    if (!account) throw AppError.notFound('KYC submission', subject);

    if (!REVIEW_STATUSES.includes(account.kycStatus as (typeof REVIEW_STATUSES)[number])) {
      throw AppError.conflict(
        'KYC_NOT_AWAITING_REVIEW',
        `KYC is '${account.kycStatus}', not awaiting review.`,
        { kycStatus: account.kycStatus },
      );
    }

    await this.repo.setDecision(account.id, 'verifying', account.kycNote, false);
    await this.audit.record(principal, tenant, { action: 'kyc.verifying', target: account.id });

    return {
      accountId: account.id,
      email: account.email,
      kycStatus: 'verifying',
      kycVersion: account.kycVersion,
    };
  }

  /**
   * Approve or reject.
   *
   * Approving lets the investor self-onboard; rejecting records the reason and
   * stamps the re-apply cooldown.
   */
  async decide(
    principal: Principal,
    tenant: TenantContext,
    subject: string,
    approve: boolean,
    note?: string,
  ): Promise<KycDecisionResult> {
    const account = await this.repo.resolveSubject(subject);

    /* Unlike the Express version this refuses to create a record from a
       decision. Approving someone who never submitted means attesting to
       identity documents that do not exist — and the platform is the obliged
       entity for that attestation (§D2). */
    if (!account) throw AppError.notFound('KYC submission', subject);

    const status = approve ? 'completed' : 'rejected';

    /* Idempotent: re-approving must NOT bump kyc_version, or every issuer's
       acceptance would go stale for nothing. */
    if (account.kycStatus === status) {
      return {
        accountId: account.id,
        email: account.email,
        kycStatus: status,
        kycVersion: account.kycVersion,
      };
    }

    await this.repo.setDecision(account.id, status, note ?? null, approve);

    const after = await this.repo.getByAccountId(account.id);
    await this.audit.record(principal, tenant, {
      action: approve ? 'kyc.approve' : 'kyc.reject',
      target: account.id,
      params: {
        note: note ?? null,
        from: account.kycStatus,
        to: status,
        kycVersion: after?.kycVersion ?? account.kycVersion,
        /* Recorded because approval is what unlocks wallet connection + on-chain
           claims; the absence of a wallet at this point is normal, not an error. */
        walletsLinked: await this.repo.walletCount(account.id),
      },
    });

    return {
      accountId: account.id,
      email: account.email,
      kycStatus: status,
      kycVersion: after?.kycVersion ?? account.kycVersion,
    };
  }
}
