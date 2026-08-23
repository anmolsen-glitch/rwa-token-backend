/**
 * SPV managers — the layer between the platform operator and per-property
 * managers.
 *
 * An SPV manager belongs to exactly ONE issuer and oversees the property
 * managers running that SPV's assets: it can create them, place them under
 * itself, release them, and suspend them. It cannot reach another SPV's
 * managers, approve KYB, deploy tokens, or touch the chain.
 *
 * Ported from ../rwa-token-backend/src/services/spvManagers.service.ts. The
 * Express version enforced scope with `assertIssuerScope`, an in-service check
 * against the actor's optional issuerId. Under tenancy that check is no longer
 * the primary control — RLS is — so it is replaced by resolving every row
 * through the tenant. The Express rule "an actor carrying an issuerId can never
 * widen it" is kept and strengthened: an issuer caller cannot even NAME another
 * issuer in the path.
 */
import { Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import type { Manager, SpvManager } from '@shared/db/schema';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { IssuersRepository } from '@modules/issuers/issuers.repository';
import { ManagersService } from '@modules/managers/managers.service';
import { SpvManagersRepository } from './spv-managers.repository';

export interface SpvManagerView {
  id: string;
  issuerId: string;
  name: string;
  company: string | null;
  contactEmail: string | null;
  phone: string | null;
  status: string;
  /** Whether a scoped login exists. Not wired yet — always false today. */
  hasLogin: boolean;
  createdAt: string;
}

@Injectable()
export class SpvManagersService {
  constructor(
    private readonly repo: SpvManagersRepository,
    private readonly issuers: IssuersRepository,
    private readonly managers: ManagersService,
    private readonly audit: AuditService,
  ) {}

  private static view(s: SpvManager): SpvManagerView {
    return {
      id: s.id,
      issuerId: s.issuerId,
      name: s.name,
      company: s.company,
      contactEmail: s.contactEmail,
      phone: s.phone,
      status: s.status,
      hasLogin: s.adminId != null,
      createdAt: s.createdAt.toISOString(),
    };
  }

  /**
   * Resolve the issuer named in the PATH against the caller's tenant.
   *
   * The path segment is a FILTER, never a source of authority: an issuer caller
   * may only name its own id, and a platform caller may name any (that is the
   * only way the operator can act on a specific SPV, and it writes an audit row
   * like every platform action). Reading the id straight from the path would be
   * the exact mistake CLAUDE.md §6 forbids for bodies and query params.
   */
  private async requireIssuer(tenant: TenantContext, issuerId: string): Promise<void> {
    if (tenant.kind === 'issuer' && tenant.issuerId !== issuerId) {
      /* 404, not 403: "that issuer exists but is not yours" is a disclosure. */
      throw AppError.notFound('Issuer', issuerId);
    }
    if (tenant.kind !== 'issuer' && tenant.kind !== 'platform') {
      throw AppError.forbidden('Only issuer or platform staff can manage SPV managers.');
    }
    const issuer = await this.issuers.findById(tenant, issuerId);
    if (!issuer) throw AppError.notFound('Issuer', issuerId);
  }

  /** An SPV manager the caller may see, or a 404. */
  private async require(tenant: TenantContext, id: string): Promise<SpvManager> {
    const row = await this.repo.findById(tenant, id);
    if (!row) throw AppError.notFound('SPV manager', id);
    return row;
  }

  async list(tenant: TenantContext, issuerId: string): Promise<{ items: SpvManagerView[] }> {
    await this.requireIssuer(tenant, issuerId);
    const rows = await this.repo.list(tenant, issuerId);
    return { items: rows.map(SpvManagersService.view) };
  }

  async get(tenant: TenantContext, id: string) {
    const row = await this.require(tenant, id);
    const reports = await this.repo.reports(tenant, id);
    return {
      ...SpvManagersService.view(row),
      managers: reports.map((m) => ({ id: m.id, name: m.name, company: m.company, status: m.status })),
    };
  }

  async create(
    principal: Principal,
    tenant: TenantContext,
    issuerId: string,
    input: { name: string; company?: string | null; contactEmail?: string | null; phone?: string | null },
  ): Promise<SpvManagerView> {
    await this.requireIssuer(tenant, issuerId);
    const row = await this.repo.create(tenant, issuerId, input);
    await this.audit.record(principal, tenant, {
      action: 'spv_manager.create',
      target: row.id,
      params: { issuerId, name: row.name },
    });
    return SpvManagersService.view(row);
  }

  async update(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    fields: {
      name?: string;
      company?: string | null;
      contactEmail?: string | null;
      phone?: string | null;
      status?: 'active' | 'suspended';
    },
  ): Promise<SpvManagerView> {
    await this.require(tenant, id);
    const row = await this.repo.update(tenant, id, fields);
    if (!row) throw AppError.notFound('SPV manager', id);

    await this.audit.record(principal, tenant, {
      action: 'spv_manager.update',
      target: id,
      params: { fields: Object.keys(fields), status: fields.status ?? null },
    });
    return SpvManagersService.view(row);
  }

  /** Property managers this SPV manager could take on. */
  async eligible(tenant: TenantContext, id: string): Promise<{ items: unknown[] }> {
    const sm = await this.require(tenant, id);
    const rows = await this.repo.eligible(tenant, sm.issuerId, id);
    return {
      items: rows.map((m) => ({
        id: m.id,
        name: m.name,
        company: m.company,
        status: m.status,
        reportsToThis: m.spvManagerId === id,
      })),
    };
  }

  /**
   * Create a property manager directly under this SPV manager.
   *
   * Delegates the profile to ManagersService so there is ONE implementation of
   * what a manager is — including the login rules and the audit row — then
   * adopts it. Duplicating the create here is how the two would drift.
   */
  async createManager(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    input: {
      name: string;
      company?: string | null;
      bio?: string | null;
      contactEmail?: string | null;
      loginEmail?: string | null;
      loginPassword?: string | null;
    },
  ) {
    const sm = await this.require(tenant, id);
    if (sm.status !== 'active') {
      throw AppError.conflict(
        'SPV_MANAGER_SUSPENDED',
        'A suspended SPV manager cannot take on new property managers.',
      );
    }

    const created = await this.managers.create(principal, tenant, input);
    await this.repo.setReportsTo(tenant, created.id, id);
    await this.audit.record(principal, tenant, {
      action: 'spv_manager.adopt_manager',
      target: id,
      params: { managerId: created.id, created: true },
    });
    return { ...created, spvManagerId: id };
  }

  /**
   * Place an existing property manager under this SPV manager, or release it.
   *
   * Attaching is restricted to the issuer's OWN managers — otherwise an SPV
   * manager could adopt, and then suspend, a rival SPV's operator. RLS already
   * hides other issuers' managers, and `managers_spv_same_issuer` rejects the
   * pairing at the database; this check exists so the caller gets a 404 that
   * says what happened rather than a constraint violation.
   */
  async setReportsTo(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    managerId: string,
    attach: boolean,
  ) {
    const sm = await this.require(tenant, id);
    const manager = await this.findManagerInScope(tenant, sm.issuerId, managerId);

    if (attach) {
      if (sm.status !== 'active') {
        throw AppError.conflict(
          'SPV_MANAGER_SUSPENDED',
          'A suspended SPV manager cannot take on property managers.',
        );
      }
      if (manager.spvManagerId && manager.spvManagerId !== id) {
        /* Silently re-parenting would move a manager out from under another
           SPV manager without that one ever seeing it. Release first. */
        throw AppError.conflict(
          'ALREADY_REPORTS',
          'That property manager already reports to another SPV manager. Release them first.',
        );
      }
    } else if (manager.spvManagerId !== id) {
      throw AppError.conflict(
        'NOT_REPORTING',
        "That property manager doesn't report to this SPV manager.",
      );
    }

    await this.repo.setReportsTo(tenant, managerId, attach ? id : null);
    await this.audit.record(principal, tenant, {
      action: attach ? 'spv_manager.adopt_manager' : 'spv_manager.release_manager',
      target: id,
      params: { managerId, manager: manager.name },
    });
    return { spvManagerId: attach ? id : null, managerId };
  }

  private async findManagerInScope(
    tenant: TenantContext,
    issuerId: string,
    managerId: string,
  ): Promise<Manager> {
    const found = await this.repo.findManager(tenant, managerId);
    /* Two cases collapse into one 404, deliberately: RLS hides another issuer's
       manager entirely, so from here it is indistinguishable from one that does
       not exist. The explicit issuerId comparison covers the PLATFORM caller,
       who sees every row and could otherwise pair across tenants. */
    if (!found || found.issuerId !== issuerId) {
      throw AppError.notFound('Property manager', managerId);
    }
    return found;
  }
}
