/**
 * Persistence for legal cases and their action trail.
 *
 * Tenant-scoped; migration 057's policies are the backstop. The trail joins
 * `operation_requests` and `audit_log`, both already scoped by their own
 * policies — so a case detail can never surface another tenant's actions even
 * if a case id were guessed.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { auditLog, legalCases, operationRequests, type LegalCase } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class CasesRepository {
  constructor(private readonly db: DbService) {}

  list(t: TenantContext, status: string | null): Promise<LegalCase[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(legalCases)
        .where(status ? eq(legalCases.status, status) : sql`true`)
        .orderBy(desc(legalCases.createdAt)),
    );
  }

  async findById(t: TenantContext, id: string): Promise<LegalCase | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.select().from(legalCases).where(eq(legalCases.id, id)).limit(1),
    );
    return row;
  }

  async findByReference(t: TenantContext, issuerId: string, reference: string) {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .select({ id: legalCases.id })
        .from(legalCases)
        .where(
          and(
            eq(legalCases.issuerId, issuerId),
            sql`lower(${legalCases.reference}) = lower(${reference})`,
          ),
        )
        .limit(1),
    );
    return row;
  }

  async create(
    t: TenantContext,
    issuerId: string,
    input: {
      reference: string;
      type: string;
      subjectWallet: string | null;
      description: string | null;
      documentUrl: string | null;
      openedBy: string | null;
      openedByEmail: string | null;
    },
  ): Promise<LegalCase> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.insert(legalCases).values({ issuerId, ...input }).returning(),
    );
    return row;
  }

  /** Atomic close: only one request may transition open -> closed. */
  async close(t: TenantContext, id: string): Promise<boolean> {
    const rows = await this.db.scoped(t, (tx) =>
      tx
        .update(legalCases)
        .set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(legalCases.id, id), eq(legalCases.status, 'open')))
        .returning({ id: legalCases.id }),
    );
    return rows.length > 0;
  }

  /** Every approval request raised under this case. */
  operations(t: TenantContext, caseId: string) {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(operationRequests)
        .where(eq(operationRequests.caseId, caseId))
        .orderBy(desc(operationRequests.createdAt)),
    );
  }

  /** Every audited action tagged with this case. */
  audit(t: TenantContext, caseId: string) {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.caseId, caseId))
        .orderBy(desc(auditLog.createdAt)),
    );
  }
}
