/**
 * The audit trail.
 *
 * Two rules from TENANCY_MODEL.md that this file exists to enforce:
 *   §5.2 — every issuer-side read of investor PII writes a row here: who
 *          looked, at whose record, when, under which tenant. Regulators ask
 *          for this log, and it is the only forensic trail if an issuer
 *          account is compromised.
 *   §D4  — every platform_admin action writes a row, because that role crosses
 *          tenant boundaries by design.
 *
 * Writes go through the WORKER connection. Audit rows must land even when the
 * caller's own RLS context would not permit inserting them — and an actor must
 * never be able to suppress their own audit trail by manipulating scope.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { auditLog } from '../db/schema';
import type { Principal, TenantContext } from '../auth/tenant-context';

export interface AuditEvent {
  action: string;
  target?: string;
  params?: Record<string, unknown>;
  status?: 'success' | 'failure';
  error?: string;
  txHash?: string;
  /**
   * The legal case this action was taken under.
   *
   * Written to the `case_id` COLUMN, not just into params, because the case
   * detail view joins on it — an action recorded without this is invisible in
   * the trail that justifies it.
   */
  caseId?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DbService) {}

  async record(principal: Principal, tenant: TenantContext, event: AuditEvent): Promise<void> {
    const issuerId = tenant.kind === 'issuer' ? tenant.issuerId : null;

    try {
      await this.db.worker('audit: append', (tx) =>
        tx.insert(auditLog).values({
          actorId: principal.id,
          actorEmail: principal.email ?? null,
          actorRole: principal.role ?? principal.kind,
          issuerId,
          action: event.action,
          target: event.target ?? null,
          params: event.params ?? {},
          status: event.status ?? 'success',
          error: event.error ?? null,
          txHash: event.txHash ?? null,
          caseId: event.caseId ?? null,
        }),
      );
    } catch (err) {
      /*
       * Never fail a read because auditing failed — that would turn a logging
       * outage into an outage of the whole compliance surface. But it MUST be
       * loud: a silently missing audit trail is worse than a noisy one.
       *
       * If this ever fires in production it is an incident, not a warning.
       */
      this.logger.error(
        { err, action: event.action, target: event.target, issuerId },
        'AUDIT WRITE FAILED — action proceeded without an audit record',
      );
    }
  }

  /** Convenience for the PII-access case, which is the most common one. */
  async recordPiiAccess(
    principal: Principal,
    tenant: TenantContext,
    subjectWallet: string,
    fields: string[],
  ): Promise<void> {
    await this.record(principal, tenant, {
      action: 'investor.pii_read',
      target: subjectWallet,
      params: { fields },
    });
  }
}
