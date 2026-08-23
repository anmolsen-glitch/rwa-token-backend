import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { isPlatform, type Principal, type TenantContext } from '@shared/auth/tenant-context';
import type { Issuer } from '@shared/db/schema';
import { OfferingsRepository } from '@modules/offerings/offerings.repository';
import { SpvManagersService } from '@modules/spv-managers/spv-managers.service';
import { ManagersRepository } from '@modules/managers/managers.repository';
import { IssuersRepository } from './issuers.repository';

export interface IssuerView {
  id: string;
  name: string;
  legalEntity: string | null;
  contactEmail: string | null;
  ownerWallet: string | null;
  spvId: string | null;
  spvType: string | null;
  kybStatus: string;
  kybNote: string | null;
  acceptancePolicy: string;
  /** The KYB dossier — representative, UBOs, documents, enquiry fields. */
  details: Record<string, unknown>;
  createdAt: string;
}

/**
 * The closed vocabulary of SPV legal forms.
 *
 * Fixed rather than free text because `spvType` feeds reporting and
 * per-jurisdiction rules — three spellings of "Private Limited" would fragment
 * both, and no migration fixes that retroactively without judgement calls.
 */
export const SPV_TYPES = [
  'Private Limited',
  'Public Limited',
  'LLP',
  'Trust',
  'Fund',
  'REIT',
  'Partnership',
  'Other',
] as const;

@Injectable()
export class IssuersService {
  constructor(
    private readonly repo: IssuersRepository,
    private readonly audit: AuditService,
    /* forwardRef: offerings and spv-managers both import THIS module. */
    @Inject(forwardRef(() => OfferingsRepository))
    private readonly offerings: OfferingsRepository,
    @Inject(forwardRef(() => SpvManagersService))
    private readonly spvManagers: SpvManagersService,
    private readonly managers: ManagersRepository,
  ) {}

  private static view(i: Issuer): IssuerView {
    return {
      id: i.id,
      name: i.name,
      legalEntity: i.legalEntity,
      contactEmail: i.contactEmail,
      ownerWallet: i.ownerWallet,
      spvId: i.spvId,
      spvType: i.spvType,
      kybStatus: i.kybStatus,
      kybNote: i.kybNote,
      acceptancePolicy: i.acceptancePolicy,
      details: (i.details ?? {}) as Record<string, unknown>,
      createdAt: i.createdAt.toISOString(),
    };
  }

  /**
   * Platform admins see every issuer. An issuer admin sees a one-element list
   * containing itself — not an empty list and not a 403, because "the issuers
   * you may see" is a well-defined, non-empty set for them.
   */
  async list(tenant: TenantContext): Promise<{ items: IssuerView[] }> {
    if (isPlatform(tenant)) {
      const rows = await this.repo.listAll(tenant);
      return { items: rows.map(IssuersService.view) };
    }

    if (tenant.kind === 'issuer') {
      const row = await this.repo.findById(tenant, tenant.issuerId);
      return { items: row ? [IssuersService.view(row)] : [] };
    }

    /* Investors have no business enumerating issuers. */
    throw AppError.forbidden('Issuers are not visible to this session type.');
  }

  async findById(tenant: TenantContext, id: string): Promise<IssuerView> {
    if (tenant.kind === 'issuer' && tenant.issuerId !== id) {
      /* 404, not 403 — confirming the id exists would leak the roster. */
      throw AppError.notFound('Issuer', id);
    }
    if (tenant.kind === 'investor') {
      throw AppError.forbidden('Issuers are not visible to this session type.');
    }
    const row = await this.repo.findById(tenant, id);
    if (!row) throw AppError.notFound('Issuer', id);
    return IssuersService.view(row);
  }

  /**
   * Create an issuer — PLATFORM ONLY.
   *
   * Creating an issuer creates a TENANT. Letting an issuer_admin do it would
   * let one tenant mint another, which is the whole boundary this model exists
   * to draw. Always lands `pending_review`: nobody self-approves their own KYB.
   */
  async create(
    principal: Principal,
    tenant: TenantContext,
    input: {
      name: string;
      legalEntity?: string;
      contactEmail?: string;
      ownerWallet?: string;
      spvId?: string | null;
      spvType?: string | null;
      details?: Record<string, unknown>;
    },
  ): Promise<IssuerView> {
    if (!isPlatform(tenant)) {
      throw AppError.forbidden('Only the platform can create an issuer.');
    }
    const row = await this.repo.create(tenant, input);
    await this.audit.record(principal, tenant, {
      action: 'issuer.create',
      target: row.id,
      params: { name: input.name },
    });
    return IssuersService.view(row);
  }

  /**
   * Update issuer details.
   *
   * An issuer_admin may edit its OWN record; the platform may edit any. The KYB
   * status is deliberately NOT patchable here — it moves only through
   * decideKyb, so an issuer cannot approve itself by sending a field.
   */
  async update(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    patch: {
      name?: string;
      legalEntity?: string;
      contactEmail?: string;
      ownerWallet?: string;
      spvId?: string | null;
      spvType?: string | null;
      details?: Record<string, unknown>;
    },
  ): Promise<IssuerView> {
    if (tenant.kind === 'issuer' && tenant.issuerId !== id) {
      throw AppError.notFound('Issuer', id);
    }
    if (tenant.kind === 'investor' || tenant.kind === 'account') {
      throw AppError.forbidden('Issuers are not editable by this session type.');
    }
    const row = await this.repo.update(tenant, id, patch);
    if (!row) throw AppError.notFound('Issuer', id);

    await this.audit.record(principal, tenant, {
      action: 'issuer.update',
      target: id,
      params: { fields: Object.keys(patch) },
    });
    return IssuersService.view(row);
  }

  /** Applications awaiting KYB review — platform only. */
  async pendingKyb(tenant: TenantContext): Promise<{ items: IssuerView[] }> {
    if (!isPlatform(tenant)) throw AppError.forbidden('Platform only.');
    const rows = await this.repo.pendingKyb(tenant);
    return { items: rows.map(IssuersService.view) };
  }

  /**
   * Approve or reject KYB — PLATFORM ONLY.
   *
   * KYB is the platform's determination that this legal entity may issue
   * securities here. An issuer deciding its own would be self-certification.
   */
  async decideKyb(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    approve: boolean,
    note?: string,
  ): Promise<IssuerView> {
    if (!isPlatform(tenant)) {
      throw AppError.forbidden('Only the platform can decide KYB.');
    }
    const existing = await this.repo.findById(tenant, id);
    if (!existing) throw AppError.notFound('Issuer', id);

    const status = approve ? 'approved' : 'rejected';
    /* Idempotent: re-approving is a no-op rather than a second audit entry
       implying a fresh decision was taken. */
    if (existing.kybStatus === status) return IssuersService.view(existing);

    const row = await this.repo.setKyb(tenant, id, status, note ?? null);
    if (!row) throw AppError.notFound('Issuer', id);

    await this.audit.record(principal, tenant, {
      action: approve ? 'issuer.kyb_approve' : 'issuer.kyb_reject',
      target: id,
      params: { from: existing.kybStatus, to: status, note: note ?? null },
    });
    return IssuersService.view(row);
  }

  /**
   * Public self-service application. No session.
   *
   * Returns only an acknowledgement, never the created row: an unauthenticated
   * caller must not learn internal ids, and echoing the record back would let
   * anyone probe whether a company is already registered.
   */
  async apply(input: {
    name: string;
    legalEntity?: string;
    contactEmail: string;
    details?: Record<string, unknown>;
  }): Promise<{ ok: true; status: 'pending_review' }> {
    await this.repo.applyAsNewIssuer(input);
    return { ok: true, status: 'pending_review' };
  }

  /**
   * The full SPV panel: the issuer plus its assets and its management layer.
   *
   * Composed here (issuers is the tenant root) from the offerings and manager
   * modules — the module cycle this creates is broken with forwardRef, same as
   * offerings <-> subscriptions.
   */
  async detail(tenant: TenantContext, id: string) {
    if (tenant.kind === 'issuer' && tenant.issuerId !== id) {
      throw AppError.notFound('Issuer', id);
    }
    const issuer = await this.repo.findById(tenant, id);
    if (!issuer) throw AppError.notFound('Issuer', id);

    const [offerings, spvRows, managerRows] = await Promise.all([
      this.offerings.listForIssuer(tenant, id),
      this.spvManagers.list(tenant, id),
      this.managers.listForIssuer(tenant, id),
    ]);

    const managerRef = (m: (typeof managerRows)[number]) => ({
      id: m.id,
      name: m.name,
      company: m.company,
      contactEmail: m.contactEmail,
      status: m.status,
      hasLogin: m.adminId != null,
      spvManagerId: m.spvManagerId,
    });

    return {
      issuer: IssuersService.view(issuer),
      assets: offerings.map((o) => ({
        id: o.id,
        name: o.name,
        tokenSymbol: o.tokenSymbol,
        status: o.status,
        location: o.location,
        managerId: o.managerId ?? null,
      })),
      spvManagers: spvRows.items.map((s) => ({
        ...s,
        managers: managerRows
          .filter((m) => String(m.spvManagerId) === String(s.id))
          .map(managerRef),
      })),
      /* Managers running this SPV's assets not under any SPV manager yet. */
      unassignedManagers: managerRows.filter((m) => m.spvManagerId == null).map(managerRef),
    };
  }
}
