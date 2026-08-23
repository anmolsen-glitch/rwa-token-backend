/**
 * Maker-checker approval workflow for sensitive chain writes.
 *
 * Ported from ../rwa-token-backend/src/services/approvals.service.ts.
 *
 * Sensitive actions (mint, burn, force-transfer, pause) are SUBMITTED rather
 * than executed. A request sits `pending` until enough DISTINCT admins other
 * than the requester approve it, then executes.
 *
 *   threshold 0 -> no four-eyes; the requester's action runs immediately
 *   threshold 1 -> maker + one checker
 *   threshold 2 -> the default for force-transfer, the most dangerous power
 *
 * The rules, all carried over:
 *   - a requester cannot approve their own request,
 *   - an approver must hold the role the action requires,
 *   - each admin may approve a given request only once,
 *   - exactly ONE approval triggers execution (atomic pending->executing claim).
 *
 * NEW UNDER MULTI-TENANCY: every read and write is tenant-scoped, so an issuer
 * can neither see nor approve another issuer's request. Without that, the
 * four-eyes rule would be satisfiable by an unrelated company's staff — which
 * is worse than having no second signature, because it looks like control.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { AppConfig } from '@shared/config/app-config.service';
import { ChainService } from '@shared/chain/chain.service';
import type { AdminRole, Principal, TenantContext } from '@shared/auth/tenant-context';
import type { OperationRequest } from '@shared/db/schema';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { TokenOperationsService } from '@modules/tokens/token-operations.service';
import { OperationsRepository } from './operations.repository';

/** The approvable actions, and the role an actor must hold. */
const REQUIRED_ROLE: Record<string, AdminRole> = {
  mint: 'agent',
  burn: 'agent',
  'force-transfer': 'agent',
  pause: 'issuer_admin',
};

export type ApprovableAction = keyof typeof REQUIRED_ROLE;

export interface SubmitResult {
  status: 'pending' | 'executed';
  id?: string;
  action: string;
  approvals?: number;
  approvalsRequired?: number;
  result?: unknown;
}

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly repo: OperationsRepository,
    private readonly tokensRepo: TokensRepository,
    private readonly ops: TokenOperationsService,
    private readonly chain: ChainService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  static isApprovable(action: string): action is ApprovableAction {
    return action in REQUIRED_ROLE;
  }

  /** Per-action override, else the base threshold. */
  thresholdFor(action: string): number {
    return this.config.approvalThresholds[action] ?? this.config.get('APPROVAL_THRESHOLD');
  }

  /**
   * issuer_admin satisfies any role within its own issuer.
   *
   * NOTE this is scoped by the tenant guard, so it is NOT the platform-wide
   * superuser the Express version implied — an issuer_admin can only satisfy
   * roles for their own issuer's requests.
   */
  private static roleSatisfies(actor: AdminRole | undefined, required: string): boolean {
    return actor === 'issuer_admin' || actor === required;
  }

  /**
   * Reject requests that can never execute, BEFORE they enter the queue.
   *
   * A force-transfer to an unverified recipient reverts on-chain ("Transfer not
   * possible"). Catching it here saves the four-eyes cycle and the gas, and
   * tells the operator something actionable instead of a revert string two
   * approvals later.
   */
  private async validateSubmit(
    tenant: TenantContext,
    action: string,
    symbol: string | null,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (action !== 'force-transfer') return;

    const to = String(params.to ?? '');
    if (!ethers.isAddress(to)) {
      throw new AppError('INVALID_RECIPIENT', 400, 'Recipient is not a valid wallet address.');
    }
    if (!symbol) {
      throw new AppError('SYMBOL_REQUIRED', 400, 'A token symbol is required for a force-transfer.');
    }

    const token = await this.tokensRepo.require(tenant, symbol);
    const irAddress: string = await this.chain.token(token.address).identityRegistry();
    const verified = (await this.chain.identityRegistry(irAddress).isVerified(to)) as boolean;
    if (!verified) {
      throw new AppError(
        'RECIPIENT_NOT_VERIFIED',
        400,
        `Recipient ${to} is not a verified investor for ${token.symbol}. Onboard them before a force-transfer.`,
        { to, symbol: token.symbol },
      );
    }
  }

  private execute(
    principal: Principal,
    tenant: TenantContext,
    action: string,
    symbol: string,
    p: Record<string, string & boolean>,
  ) {
    switch (action) {
      case 'mint':
        return this.ops.mint(principal, tenant, symbol, p.investor, p.amount);
      case 'burn':
        return this.ops.burn(principal, tenant, symbol, p.wallet, p.amount);
      case 'force-transfer':
        return this.ops.forcedTransfer(principal, tenant, symbol, p.from, p.to, p.amount);
      case 'pause':
        return this.ops.setPaused(principal, tenant, symbol, Boolean(p.paused));
      default:
        throw new AppError('UNKNOWN_ACTION', 400, `Unknown approvable action "${action}".`);
    }
  }

  async submit(
    principal: Principal,
    tenant: TenantContext,
    action: string,
    symbol: string,
    params: Record<string, unknown>,
    caseId?: string,
  ): Promise<SubmitResult> {
    const requiredRole = REQUIRED_ROLE[action];
    if (!requiredRole) {
      throw new AppError('NOT_APPROVABLE', 400, `Action "${action}" does not support approval.`);
    }
    if (!ApprovalsService.roleSatisfies(principal.role, requiredRole)) {
      throw AppError.forbidden(`This action requires the "${requiredRole}" role.`);
    }

    /* Resolve the token FIRST: this is the tenant check. A symbol belonging to
       another issuer 404s here rather than entering their approval queue. */
    await this.tokensRepo.require(tenant, symbol);
    await this.validateSubmit(tenant, action, symbol, params);

    const threshold = this.thresholdFor(action);
    if (threshold === 0) {
      const result = await this.execute(
        principal, tenant, action, symbol, params as Record<string, string & boolean>,
      );
      return { status: 'executed', action, result };
    }

    const req = await this.repo.create(tenant, {
      action,
      tokenSymbol: symbol,
      params,
      requiredRole,
      approvalsRequired: threshold,
      requestedBy: principal.id,
      requestedByEmail: principal.email ?? null,
      caseId,
    });

    await this.audit.record(principal, tenant, {
      action: `request:${action}`,
      target: symbol,
      params: { ...params, operationId: req.id },
      caseId,
    });

    return {
      status: 'pending',
      id: req.id,
      action,
      approvals: 0,
      approvalsRequired: threshold,
    };
  }

  async approve(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    note?: string,
  ): Promise<SubmitResult & { id: string }> {
    const req = await this.requirePending(tenant, id);

    if (req.requestedBy === principal.id) {
      /* The whole point of four-eyes. */
      throw AppError.forbidden('You cannot approve your own request (four-eyes rule).');
    }
    if (!ApprovalsService.roleSatisfies(principal.role, req.requiredRole)) {
      throw AppError.forbidden('You do not have the role required to approve this action.');
    }

    const added = await this.repo.addApproval(
      tenant, id, principal.id, principal.email ?? null, note ?? null,
    );
    if (!added) {
      throw AppError.conflict('ALREADY_APPROVED', 'You have already approved this request.');
    }

    await this.audit.record(principal, tenant, {
      action: `approve:${req.action}`,
      target: req.tokenSymbol ?? undefined,
      params: { operationId: id },
    });

    const approvals = await this.repo.countApprovals(tenant, id);
    if (approvals < req.approvalsRequired) {
      return { status: 'pending', id, action: req.action, approvals, approvalsRequired: req.approvalsRequired };
    }

    /* Threshold reached. Claim atomically so concurrent approvals cannot both
       execute — that would be a double mint. */
    if (!(await this.repo.claimForExecution(tenant, id))) {
      const current = await this.repo.byId(tenant, id);
      return {
        status: (current?.status ?? 'executing') as 'pending' | 'executed',
        id,
        action: req.action,
        approvals,
      };
    }

    try {
      const result = await this.execute(
        principal, tenant, req.action, req.tokenSymbol!,
        (req.params ?? {}) as Record<string, string & boolean>,
      );
      await this.repo.setOutcome(tenant, id, 'executed', {
        txHash: (result as { tx?: { hash?: string } }).tx?.hash ?? null,
      });
      return { status: 'executed', id, action: req.action, approvals, result };
    } catch (err) {
      /* Record the REAL reason, not the generic wrapper — a queue full of
         "mint failed" with no detail is unusable to whoever retries it. */
      const e = err as AppError & { details?: { detail?: string } };
      const reason = e.details?.detail ? `${e.message}: ${e.details.detail}` : e.message;
      await this.repo.setOutcome(tenant, id, 'failed', { error: reason });
      this.logger.error({ err, operationId: id }, 'approved operation failed on-chain');
      throw err;
    }
  }

  async reject(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    note?: string,
  ): Promise<{ status: 'rejected'; id: string }> {
    const req = await this.requirePending(tenant, id);

    /* A requester may always cancel their own; otherwise the role is needed. */
    if (
      req.requestedBy !== principal.id &&
      !ApprovalsService.roleSatisfies(principal.role, req.requiredRole)
    ) {
      throw AppError.forbidden('You do not have permission to reject this request.');
    }

    await this.repo.setOutcome(tenant, id, 'rejected', { note: note ?? null });
    await this.audit.record(principal, tenant, {
      action: `reject:${req.action}`,
      target: req.tokenSymbol ?? undefined,
      params: { operationId: id, note: note ?? null },
    });
    return { status: 'rejected', id };
  }

  private async requirePending(tenant: TenantContext, id: string): Promise<OperationRequest> {
    const req = await this.repo.byId(tenant, id);
    /* 404 covers both "no such request" and "another issuer's request" — RLS
       already hid the latter, and distinguishing them would disclose it. */
    if (!req) throw AppError.notFound('Operation request', id);
    if (req.status !== 'pending') {
      throw AppError.conflict('NOT_PENDING', `Request is already ${req.status}.`, {
        status: req.status,
      });
    }
    return req;
  }

  async get(tenant: TenantContext, id: string) {
    const req = await this.repo.byId(tenant, id);
    if (!req) throw AppError.notFound('Operation request', id);
    return { ...req, approvals: await this.repo.listApprovals(tenant, id) };
  }

  async list(tenant: TenantContext, status: string | null, limit: number) {
    const items = await this.repo.list(tenant, status, limit);
    return { items };
  }
}
