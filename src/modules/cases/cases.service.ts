/**
 * Legal cases — the off-chain order behind a privileged action.
 *
 * Open a case (court order, sanctions, fraud, recovery), then take actions —
 * freeze, force-transfer, burn — referencing it. The case detail aggregates
 * every approval request and audit row tagged with the case, which is the
 * defensible trail of WHO did WHAT, WHY, and with what result.
 *
 * Ported from ../rwa-token-backend/src/services/cases.service.ts.
 *
 * This module holds no powers of its own. `recover` ORCHESTRATES existing ones
 * and that is deliberate: every step it takes is a step an operator could take
 * by hand, with the same guards, the same audit rows and the same four-eyes
 * requirement on the dangerous one. A recovery flow with its own privileged
 * path would be a second way to move someone's tokens.
 */
import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { ChainService } from '@shared/chain/chain.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { LegalCase } from '@shared/db/schema';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { TokenOperationsService } from '@modules/tokens/token-operations.service';
import { ApprovalsService } from '@modules/operations/approvals.service';
import { OnboardingService } from '@modules/onboarding/onboarding.service';
import { CasesRepository } from './cases.repository';

const TYPES = ['court_order', 'sanctions', 'fraud', 'recovery', 'dispute', 'other'] as const;
export type CaseType = (typeof TYPES)[number];

@Injectable()
export class CasesService {
  constructor(
    private readonly repo: CasesRepository,
    private readonly tokens: TokensRepository,
    private readonly ops: TokenOperationsService,
    private readonly approvals: ApprovalsService,
    private readonly onboarding: OnboardingService,
    private readonly chain: ChainService,
    private readonly audit: AuditService,
  ) {}

  private static issuerIdOf(tenant: TenantContext): string {
    if (tenant.kind !== 'issuer') {
      throw AppError.forbidden('Only issuer compliance staff can open a case.');
    }
    return tenant.issuerId;
  }

  private static view(c: LegalCase) {
    return {
      id: c.id,
      reference: c.reference,
      type: c.type,
      subjectWallet: c.subjectWallet,
      description: c.description,
      documentUrl: c.documentUrl,
      status: c.status,
      openedByEmail: c.openedByEmail,
      createdAt: c.createdAt.toISOString(),
      closedAt: c.closedAt?.toISOString() ?? null,
    };
  }

  async list(tenant: TenantContext, status: string | null) {
    const rows = await this.repo.list(tenant, status);
    return { items: rows.map(CasesService.view) };
  }

  private async require(tenant: TenantContext, id: string): Promise<LegalCase> {
    const row = await this.repo.findById(tenant, id);
    /* 404 for another issuer's case: the existence of an investigation is
       itself sensitive, so it must not be confirmable. */
    if (!row) throw AppError.notFound('Case', id);
    return row;
  }

  /**
   * A case plus its full action trail.
   *
   * Both halves are read through the tenant, so even a guessed case id cannot
   * surface another tenant's operations or audit rows.
   */
  async detail(tenant: TenantContext, id: string) {
    const c = await this.require(tenant, id);
    const [operations, audit] = await Promise.all([
      this.repo.operations(tenant, id),
      this.repo.audit(tenant, id),
    ]);
    return {
      ...CasesService.view(c),
      operations: operations.map((o) => ({
        id: o.id,
        action: o.action,
        tokenSymbol: o.tokenSymbol,
        params: o.params,
        status: o.status,
        txHash: o.txHash,
        error: o.error,
        requestedByEmail: o.requestedByEmail,
        createdAt: o.createdAt.toISOString(),
      })),
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        target: a.target,
        actorEmail: a.actorEmail,
        status: a.status,
        txHash: a.txHash,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  async open(
    principal: Principal,
    tenant: TenantContext,
    input: {
      reference: string;
      type?: CaseType;
      subjectWallet?: string | null;
      description?: string | null;
      documentUrl?: string | null;
    },
  ) {
    const issuerId = CasesService.issuerIdOf(tenant);

    if (input.subjectWallet && !ethers.isAddress(input.subjectWallet)) {
      throw new AppError('INVALID_WALLET', 400, 'Subject wallet is not a valid address.');
    }
    /* References are unique WITHIN an issuer (migration 057). Checking here
       gives a readable 409 instead of a raw constraint violation. */
    if (await this.repo.findByReference(tenant, issuerId, input.reference)) {
      throw AppError.conflict('REFERENCE_TAKEN', 'A case with that reference already exists.');
    }

    const row = await this.repo.create(tenant, issuerId, {
      reference: input.reference.trim(),
      type: input.type ?? 'court_order',
      subjectWallet: input.subjectWallet?.toLowerCase() ?? null,
      description: input.description ?? null,
      documentUrl: input.documentUrl ?? null,
      openedBy: principal.id,
      openedByEmail: principal.email ?? null,
    });

    await this.audit.record(principal, tenant, {
      action: 'case.open',
      target: row.subjectWallet ?? undefined,
      params: { reference: row.reference, type: row.type },
      /* Tagged with itself: a case whose own opening is missing from its trail
         is a trail with a hole exactly where it starts. */
      caseId: row.id,
    });
    return CasesService.view(row);
  }

  /**
   * Close a case.
   *
   * The transition is atomic on `status = 'open'`, so two concurrent closes
   * cannot both record one. Closing does NOT undo anything the case
   * authorised — a freeze stays frozen — it records that the matter is done.
   */
  async close(principal: Principal, tenant: TenantContext, id: string) {
    const c = await this.require(tenant, id);
    if (!(await this.repo.close(tenant, id))) {
      throw AppError.conflict('NOT_OPEN', `Case is already ${c.status}.`);
    }
    await this.audit.record(principal, tenant, {
      action: 'case.close',
      target: c.subjectWallet ?? undefined,
      params: {},
      caseId: id,
    });
    return { id, status: 'closed' as const };
  }

  /**
   * Guided lost-key recovery, under an open case.
   *
   *   1. link the new wallet to the same person (admin override — identity was
   *      proved off-chain, so no on-chain signature is required),
   *   2. register the new wallet for the token, reusing the person's ONCHAINID,
   *   3. freeze the old wallet,
   *   4. SUBMIT a force-transfer old -> new for the full balance.
   *
   * Step 4 is submitted for approval, never executed here. Moving someone's
   * entire holding is the most dangerous power in the system, and a recovery
   * flow that skipped four-eyes would be the easiest way to steal a position:
   * claim a lost key, point it at your own wallet. The default threshold for
   * force-transfer is TWO checkers.
   *
   * The steps are ordered so a failure part-way is safe to re-run: linking and
   * registering are idempotent, and the freeze precedes the transfer so a
   * compromised key cannot move funds while approval is pending.
   */
  async recover(
    principal: Principal,
    tenant: TenantContext,
    caseId: string,
    input: { oldWallet: string; newWallet: string; tokenSymbol: string },
  ) {
    const c = await this.require(tenant, caseId);
    if (c.status !== 'open') {
      throw AppError.conflict('CASE_CLOSED', 'Case is closed.');
    }
    if (!ethers.isAddress(input.oldWallet) || !ethers.isAddress(input.newWallet)) {
      throw new AppError('INVALID_WALLET', 400, 'Invalid wallet address.');
    }
    const oldWallet = input.oldWallet.toLowerCase();
    const newWallet = input.newWallet.toLowerCase();
    if (oldWallet === newWallet) {
      throw new AppError('SAME_WALLET', 400, 'The new wallet must differ from the old one.');
    }

    /* Tenant check: another issuer's token 404s before anything is touched. */
    const token = await this.tokens.require(tenant, input.tokenSymbol);
    const steps: string[] = [];

    // 1. Link the new wallet to the same person.
    const primary = await this.onboarding.resolvePrimaryWallet(oldWallet);
    const linked = await this.onboarding.walletsForPerson(primary);
    if (linked.includes(newWallet)) {
      steps.push('new wallet already linked');
    } else {
      await this.onboarding.adminLinkWallet(principal, tenant, primary, newWallet);
      steps.push('linked the new wallet to the investor');
    }

    // 2. Register it for this asset, reusing the ONCHAINID.
    await this.onboarding.confirm(principal, tenant, newWallet, token.symbol);
    steps.push(`registered the new wallet for ${token.symbol}`);

    // 3. Freeze the compromised wallet, under this case.
    await this.ops.setAddressFrozen(principal, tenant, token.symbol, oldWallet, true, caseId);
    steps.push('froze the old wallet');

    // 4. Submit the force-transfer for approval.
    const reader = this.chain.token(token.address);
    const decimals = Number(await reader.decimals());
    const balance = ethers.formatUnits((await reader.balanceOf(oldWallet)) as bigint, decimals);

    let forceTransfer: unknown = null;
    if (Number(balance) > 0) {
      forceTransfer = await this.approvals.submit(
        principal,
        tenant,
        'force-transfer',
        token.symbol,
        { from: oldWallet, to: newWallet, amount: balance },
        caseId,
      );
      steps.push(`submitted a force-transfer of ${balance} ${token.symbol} for approval`);
    } else {
      steps.push('old wallet holds nothing — no transfer needed');
    }

    await this.audit.record(principal, tenant, {
      action: 'case.recover',
      target: oldWallet,
      params: { newWallet, token: token.symbol, balance },
      caseId,
    });

    return {
      caseId,
      oldWallet,
      newWallet,
      tokenSymbol: token.symbol,
      balance,
      steps,
      forceTransfer,
    };
  }
}
