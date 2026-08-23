/**
 * AML / sanctions screening.
 *
 * Ported from ../rwa-token-backend/src/services/aml.service.ts, with the
 * subject moved to the PERSON (migration 047).
 *
 * The split that matters:
 *   - A SCREENING is per wallet. That is what a provider actually assesses: an
 *     address's on-chain history. Screenings are append-only evidence.
 *   - The STATUS is per person: the WORST decision across every wallet they
 *     control. That is what gates KYC and onboarding.
 *
 * Aggregation is pessimistic on purpose. One clean wallet and one sanctioned
 * wallet is `blocked`, not `clear` — taking the best, or the most recent, would
 * let anyone launder a flagged address behind a fresh one.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import {
  AML_PROVIDER,
  worse,
  type AmlProvider,
  type AmlResult,
  type AmlStatus,
} from '@shared/aml/aml.provider';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { AmlScreening } from '@shared/db/schema';
import { ComplianceRepository } from './compliance.repository';

export interface ScreeningView {
  id: string;
  wallet: string;
  provider: string;
  reference: string | null;
  riskScore: number;
  riskLevel: string;
  sanctioned: boolean;
  categories: string[];
  decision: string;
  screenedBy: string | null;
  screenedAt: string;
}

@Injectable()
export class AmlService {
  constructor(
    private readonly repo: ComplianceRepository,
    private readonly audit: AuditService,
    @Inject(AML_PROVIDER) private readonly provider: AmlProvider,
  ) {}

  private static view(s: AmlScreening): ScreeningView {
    return {
      id: s.id,
      wallet: s.wallet,
      provider: s.provider,
      reference: s.reference,
      riskScore: s.riskScore,
      riskLevel: s.riskLevel,
      sanctioned: s.sanctioned,
      categories: Array.isArray(s.categories) ? (s.categories as string[]) : [],
      decision: s.decision,
      screenedBy: s.screenedBy,
      screenedAt: s.screenedAt.toISOString(),
    };
  }

  /** Screen one wallet and record the result. Does NOT recompute the aggregate. */
  private async screenAndRecord(
    wallet: string,
    person: string,
    screenedBy: string | null,
  ): Promise<AmlResult> {
    const result = await this.provider.screenAddress(wallet);
    await this.repo.insertScreening({
      wallet: wallet.toLowerCase(),
      person: person.toLowerCase(),
      provider: result.provider,
      reference: result.reference,
      riskScore: result.riskScore,
      riskLevel: result.riskLevel,
      sanctioned: result.sanctioned,
      categories: result.categories,
      decision: result.decision,
      raw: result.raw,
      screenedBy,
    });
    return result;
  }

  /**
   * Screen a wallet that is about to be LINKED to an existing person.
   *
   * Returns the decision so the caller can refuse the link outright on a
   * sanctions or severe-risk hit — a person must not be able to attach a
   * tainted address to their verified identity and inherit its standing. The
   * attempt is recorded either way: a blocked link is exactly the event a
   * compliance team needs to see.
   */
  async screenForLink(wallet: string, accountId: string, screenedBy: string | null) {
    const result = await this.screenAndRecord(wallet, accountId, screenedBy);
    return { decision: result.decision, riskLevel: result.riskLevel, sanctioned: result.sanctioned };
  }

  /**
   * Recompute the person's aggregate from the latest screening of each wallet.
   *
   * A person with NO wallets is `unscreened`, not `clear`: nothing has been
   * checked, and treating that as a pass would let someone sail through KYC
   * before any address exists to screen.
   */
  async recomputeStatus(accountId: string): Promise<AmlStatus> {
    const wallets = await this.repo.walletsForAccount(accountId);

    let status: AmlStatus = 'unscreened';
    for (const wallet of wallets) {
      const latest = await this.repo.latestScreening(wallet);
      if (!latest) continue;
      status = worse(status, latest.decision as AmlStatus);
    }

    await this.repo.setAmlStatus(accountId, status);
    return status;
  }

  /**
   * Admin-triggered re-screen — ongoing monitoring, or an investor disputing a
   * flag. Re-screens every wallet the person controls, then re-aggregates.
   */
  async rescreen(
    principal: Principal,
    tenant: TenantContext,
    accountId: string,
  ): Promise<{ accountId: string; amlStatus: AmlStatus; screened: number }> {
    const account = await this.repo.accountById(accountId);
    if (!account) throw AppError.notFound('Account', accountId);

    const wallets = await this.repo.walletsForAccount(accountId);
    for (const wallet of wallets) {
      await this.screenAndRecord(wallet, wallets[0] ?? wallet, principal.email ?? null);
    }

    const amlStatus = await this.recomputeStatus(accountId);

    await this.audit.record(principal, tenant, {
      action: 'aml.rescreen',
      target: accountId,
      params: { wallets: wallets.length, from: account.amlStatus, to: amlStatus },
    });

    return { accountId, amlStatus, screened: wallets.length };
  }

  /** The screening history for a person — the compliance case file. */
  async history(accountId: string): Promise<{ amlStatus: string; items: ScreeningView[] }> {
    const account = await this.repo.accountById(accountId);
    if (!account) throw AppError.notFound('Account', accountId);

    const wallets = await this.repo.walletsForAccount(accountId);
    const rows = await this.repo.screeningsForWallets(wallets);
    return { amlStatus: account.amlStatus, items: rows.map(AmlService.view) };
  }
}
