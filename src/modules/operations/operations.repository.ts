/**
 * Approval-queue persistence.
 *
 * Tenant-scoped via db.scoped(): the RLS policies from migration 049 mean an
 * issuer sees and touches only requests for ITS OWN tokens. A pending
 * force-transfer names a wallet and an amount — cap-table intelligence about a
 * competitor if it leaked.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import {
  operationApprovals,
  operationRequests,
  type OperationApproval,
  type OperationRequest,
} from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class OperationsRepository {
  constructor(private readonly db: DbService) {}

  async create(
    tenant: TenantContext,
    r: {
      action: string;
      tokenSymbol: string | null;
      params: Record<string, unknown>;
      requiredRole: string;
      approvalsRequired: number;
      requestedBy: string;
      requestedByEmail: string | null;
      caseId?: string | null;
    },
  ): Promise<OperationRequest> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx.insert(operationRequests).values({ ...r, caseId: r.caseId ?? null }).returning(),
    );
    return row;
  }

  async byId(tenant: TenantContext, id: string): Promise<OperationRequest | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx.select().from(operationRequests).where(eq(operationRequests.id, id)).limit(1),
    );
    return row;
  }

  list(tenant: TenantContext, status: string | null, limit: number): Promise<OperationRequest[]> {
    return this.db.scoped(tenant, (tx) => {
      const q = tx.select().from(operationRequests);
      return (status ? q.where(eq(operationRequests.status, status)) : q)
        .orderBy(desc(operationRequests.createdAt))
        .limit(limit);
    });
  }

  /**
   * Record one approval. Returns false if this admin already approved.
   *
   * The (operation_id, approver_id) primary key is what enforces "one approval
   * per admin" — ON CONFLICT DO NOTHING makes a double-click a no-op rather
   * than two votes toward the threshold.
   */
  async addApproval(
    tenant: TenantContext,
    operationId: string,
    approverId: string,
    approverEmail: string | null,
    note: string | null,
  ): Promise<boolean> {
    const rows = await this.db.scoped(tenant, (tx) =>
      tx
        .insert(operationApprovals)
        .values({ operationId, approverId, approverEmail, note })
        .onConflictDoNothing()
        .returning(),
    );
    return rows.length > 0;
  }

  async countApprovals(tenant: TenantContext, operationId: string): Promise<number> {
    const rows = await this.db.scoped(tenant, (tx) =>
      tx
        .select({ id: operationApprovals.approverId })
        .from(operationApprovals)
        .where(eq(operationApprovals.operationId, operationId)),
    );
    return rows.length;
  }

  listApprovals(tenant: TenantContext, operationId: string): Promise<OperationApproval[]> {
    return this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(operationApprovals)
        .where(eq(operationApprovals.operationId, operationId))
        .orderBy(operationApprovals.createdAt),
    );
  }

  /**
   * Atomically claim a request for execution: pending -> executing.
   *
   * THE race that matters. When the threshold is reached, several approvals can
   * land at once; without an atomic conditional UPDATE two of them would each
   * see "threshold met" and both execute the chain write — a double mint.
   * Exactly one caller gets a row back.
   */
  async claimForExecution(tenant: TenantContext, id: string): Promise<boolean> {
    const rows = await this.db.scoped(tenant, (tx) =>
      tx
        .update(operationRequests)
        .set({ status: 'executing', updatedAt: new Date() })
        .where(and(eq(operationRequests.id, id), eq(operationRequests.status, 'pending')))
        .returning({ id: operationRequests.id }),
    );
    return rows.length > 0;
  }

  async setOutcome(
    tenant: TenantContext,
    id: string,
    status: 'executed' | 'failed' | 'rejected',
    extra: { txHash?: string | null; error?: string | null; note?: string | null } = {},
  ): Promise<void> {
    await this.db.scoped(tenant, (tx) =>
      tx
        .update(operationRequests)
        .set({
          status,
          txHash: extra.txHash ?? null,
          error: extra.error ?? null,
          decidedNote: extra.note ?? null,
          updatedAt: new Date(),
        })
        .where(eq(operationRequests.id, id)),
    );
  }

  /** Requests this admin has already approved — for the UI. */
  async approvedByMe(tenant: TenantContext, approverId: string): Promise<string[]> {
    const rows = await this.db.scoped(tenant, (tx) =>
      tx
        .select({ id: operationApprovals.operationId })
        .from(operationApprovals)
        .where(sql`${operationApprovals.approverId} = ${approverId}`),
    );
    return rows.map((r) => r.id);
  }
}
