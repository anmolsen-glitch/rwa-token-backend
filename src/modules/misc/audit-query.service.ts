/**
 * Reading the audit trail.
 *
 * Deliberately read-only and in its own service: the WRITE path lives in
 * AuditService and goes through the worker connection so an actor can never
 * suppress their own trail. Keeping the reader separate means no code path
 * exists that both writes and edits it.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { auditLog } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class AuditQueryService {
  constructor(private readonly db: DbService) {}

  async list(tenant: TenantContext, opts: { limit: number; action: string | null }) {
    /* Bounded regardless of what the caller asks for — an unbounded audit
       export is both a performance and a disclosure problem. */
    const limit = Math.min(Math.max(opts.limit, 1), 1000);
    const where = opts.action
      ? and(sql`${auditLog.action} LIKE ${`${opts.action}%`}`)
      : undefined;

    const rows = await this.db.scoped(tenant, (tx) =>
      tx.select().from(auditLog).where(where).orderBy(desc(auditLog.createdAt)).limit(limit),
    );

    return {
      items: rows.map((a) => ({
        id: a.id,
        actorEmail: a.actorEmail,
        actorRole: a.actorRole,
        action: a.action,
        target: a.target,
        params: a.params,
        status: a.status,
        txHash: a.txHash,
        error: a.error,
        caseId: a.caseId,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }
}
