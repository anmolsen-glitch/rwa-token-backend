/**
 * Accreditation review.
 *
 * Ported from ../rwa-token-backend/src/services/accreditation.service.ts, with
 * the subject moved to the PERSON (migration 047) and the on-chain half
 * rewritten for the non-custodial model.
 *
 * THE ASYMMETRY THAT MATTERS. The Express version attached the on-chain
 * ACCREDITED claim on approval, using the investor's key. Non-custodially the
 * platform has no such key, so the two directions are NOT mirror images:
 *
 *   GRANT  — off-chain only. The claim is signed later, at
 *            POST /api/admin/onboarding/prepare, and submitted by the investor from
 *            their own wallet. `prepare` already requires ACCREDITED for
 *            accredited-only tokens and refuses when this flag is not set, so
 *            granting here is exactly what unlocks it.
 *
 *   REVOKE — on-chain, immediately. Revocation calls
 *            ClaimIssuer.revokeClaimBySignature, which the PLATFORM can do
 *            because it is revoking its OWN attestation. It needs no
 *            cooperation from the investor — which is the whole point: an
 *            investor must not be able to keep a privilege by declining to
 *            sign.
 *
 * Gated on KYC: a person must be KYC-approved before accreditation, because
 * accreditation is an assertion about a verified human.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { InfraService } from '@shared/chain/infra.service';
import { IdentityService, ACCREDITED_TOPIC } from '@shared/chain/identity.service';
import { SignerService } from '@shared/chain/signer.service';
import { TxService } from '@shared/chain/tx.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { Account } from '@shared/db/schema';
import { KycRepository } from '@modules/kyc/kyc.repository';
import { ComplianceRepository } from './compliance.repository';

export interface AccreditationCandidate {
  accountId: string;
  email: string;
  name: string | null;
  country: number | null;
  kycStatus: string;
  amlStatus: string;
  accreditationStatus: string;
}

export interface AccreditationResult {
  accountId: string;
  accreditationStatus: string;
  /** What happened on-chain, in plain words. Never silently empty. */
  onchain: string;
}

@Injectable()
export class AccreditationService {
  private readonly logger = new Logger(AccreditationService.name);

  constructor(
    private readonly repo: ComplianceRepository,
    private readonly audit: AuditService,
    private readonly infra: InfraService,
    private readonly identities: IdentityService,
    private readonly signers: SignerService,
    private readonly tx: TxService,
    private readonly kyc: KycRepository,
  ) {}

  private static candidate(a: Account): AccreditationCandidate {
    return {
      accountId: a.id,
      email: a.email,
      name: a.name,
      country: a.country,
      kycStatus: a.kycStatus,
      amlStatus: a.amlStatus,
      accreditationStatus: a.accreditationStatus,
    };
  }

  async candidates(
    principal: Principal,
    tenant: TenantContext,
  ): Promise<{ items: AccreditationCandidate[] }> {
    const rows = await this.repo.candidates();
    /* The list carries name/email/country — PII, so the read is audited like
       any other (TENANCY_MODEL.md §5.2). */
    await this.audit.record(principal, tenant, {
      action: 'accreditation.queue_read',
      params: { count: rows.length },
    });
    return { items: rows.map(AccreditationService.candidate) };
  }

  async decide(
    principal: Principal,
    tenant: TenantContext,
    accountId: string,
    approve: boolean,
    note?: string,
  ): Promise<AccreditationResult> {
    /* The admin console addresses people by WALLET; accept either, same as
       the KYC decision routes' :subject. */
    const resolved = await this.kyc.resolveSubject(accountId);
    if (!resolved) throw AppError.notFound('Account', accountId);
    accountId = resolved.id;
    const account = await this.repo.accountById(accountId);
    if (!account) throw AppError.notFound('Account', accountId);

    if (approve) {
      if (account.kycStatus !== 'completed') {
        throw AppError.conflict(
          'KYC_NOT_APPROVED',
          'KYC must be approved before granting accreditation.',
          { kycStatus: account.kycStatus },
        );
      }
      if (account.amlStatus === 'blocked') {
        /* Not in the Express version. Granting a privilege to someone blocked
           by sanctions screening is precisely the thing AML exists to stop. */
        throw AppError.conflict(
          'AML_BLOCKED',
          'This person is blocked by AML screening and cannot be accredited.',
          { amlStatus: account.amlStatus },
        );
      }
    }

    const status = approve ? 'accredited' : 'rejected';
    await this.repo.setAccreditation(accountId, status, note ?? null);

    const onchain = approve
      ? 'Granted off-chain. The ACCREDITED claim is signed at /api/admin/onboarding/prepare and submitted by the investor from their own wallet.'
      : await this.revokeOnChain(accountId);

    await this.audit.record(principal, tenant, {
      action: approve ? 'accreditation.approve' : 'accreditation.reject',
      target: accountId,
      params: { from: account.accreditationStatus, to: status, note: note ?? null, onchain },
    });

    return { accountId, accreditationStatus: status, onchain };
  }

  /**
   * Revoke the on-chain ACCREDITED claim for every wallet the person controls.
   *
   * Best-effort: a chain hiccup must NOT roll back the off-chain decision we
   * already recorded, or an operator who revoked accreditation would be told it
   * failed while the person keeps the privilege off-chain too. The outcome is
   * returned and audited so a failure is visible and re-runnable.
   */
  private async revokeOnChain(accountId: string): Promise<string> {
    const infra = this.infra.get();
    if (!infra) return 'No chain infrastructure on this network — nothing revoked.';

    const wallets = await this.repo.walletsForAccount(accountId);
    if (wallets.length === 0) return 'No wallets linked — no on-chain claim to revoke.';

    const revoked: string[] = [];
    const failures: string[] = [];

    for (const wallet of wallets) {
      try {
        const identity = await this.identities
          .idFactory(infra.idFactory)
          .getIdentity(ethers.getAddress(wallet));
        if (!identity || identity === ethers.ZeroAddress) continue;

        const signature = await this.identities.claimSignature(
          identity as string,
          infra.claimIssuer,
          ACCREDITED_TOPIC,
        );
        if (!signature) continue;

        const issuer = this.identities.claimIssuer(
          infra.claimIssuer,
          this.signers.get('claimIssuer'),
        );
        if (await issuer.isClaimRevoked(signature)) continue;

        await this.tx.submit(`revoke ACCREDITED ${wallet}`, () =>
          issuer.revokeClaimBySignature(signature) as Promise<ethers.ContractTransactionResponse>,
        );
        revoked.push(wallet);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ err, wallet }, 'accreditation: on-chain revoke failed');
        failures.push(`${wallet}: ${message}`);
      }
    }

    if (failures.length) {
      return `Revoked ${revoked.length}; FAILED for ${failures.length} — retry: ${failures.join('; ')}`;
    }
    return revoked.length
      ? `Revoked the ACCREDITED claim for ${revoked.length} wallet(s).`
      : 'No live ACCREDITED claim found — nothing to revoke.';
  }
}
