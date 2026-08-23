/**
 * Property managers.
 *
 * A manager is the firm that OPERATES an asset day to day. It is two things in
 * one record: a public profile investors see on the asset page, and an optional
 * login giving a scoped portal over only that manager's properties.
 *
 * The role is DELEGATED AUTHORITY, not ownership: a manager can post updates
 * and declare distributions for properties they operate, and nothing else. They
 * cannot mint, freeze, force-transfer, touch KYC, or see another manager's
 * assets — which is the whole reason the role exists separately from
 * issuer_admin.
 *
 * Ported from ../rwa-token-backend/src/services/managers.service.ts, with the
 * registry now issuer-owned (migration 053).
 */
import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import type { Manager, Offering } from '@shared/db/schema';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { ManagersRepository } from './managers.repository';

const BCRYPT_ROUNDS = 12;
/** Long enough to matter for an account that can move rent money. */
const MIN_LOGIN_PASSWORD = 10;

export interface ManagerView {
  id: string;
  name: string;
  company: string | null;
  bio: string | null;
  logoUrl: string | null;
  contactEmail: string | null;
  status: string;
  /** Whether a portal login exists. The login's EMAIL is never exposed here. */
  hasLogin: boolean;
  createdAt: string;
}

@Injectable()
export class ManagersService {
  constructor(
    private readonly repo: ManagersRepository,
    private readonly audit: AuditService,
  ) {}

  private static view(m: Manager): ManagerView {
    return {
      id: m.id,
      name: m.name,
      company: m.company,
      bio: m.bio,
      logoUrl: m.logoUrl,
      contactEmail: m.contactEmail,
      status: m.status,
      hasLogin: m.adminId != null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** The issuer that owns this write, or a 403. */
  private static issuerIdOf(tenant: TenantContext): string {
    if (tenant.kind !== 'issuer') {
      throw AppError.forbidden('Only an issuer can manage its property managers.');
    }
    return tenant.issuerId;
  }

  async list(tenant: TenantContext): Promise<{ items: ManagerView[] }> {
    const rows = await this.repo.list(tenant);
    return { items: rows.map(ManagersService.view) };
  }

  async findById(tenant: TenantContext, id: string): Promise<ManagerView> {
    const row = await this.repo.findById(tenant, id);
    /* 404 rather than 403 for another issuer's manager: confirming the id
       exists would disclose that a competitor employs it. */
    if (!row) throw AppError.notFound('Manager', id);
    return ManagersService.view(row);
  }

  /**
   * A manager's PUBLIC profile plus the properties it operates.
   *
   * Suspended managers 404 here even though they still exist: the profile is
   * marketing surface, and showing a suspended operator alongside live assets
   * misrepresents who is running them.
   */
  async publicProfile(id: string): Promise<ManagerView & { properties: unknown[] }> {
    const platform: TenantContext = { kind: 'platform' };
    const row = await this.repo.findById(platform, id);
    if (!row || row.status !== 'active') throw AppError.notFound('Manager', id);

    const properties = await this.repo.listOfferings(platform, id);
    return {
      ...ManagersService.view(row),
      properties: properties
        .filter((o) => o.visibility === 'public')
        .map(ManagersService.propertyView),
    };
  }

  private static propertyView(o: Offering) {
    return {
      id: o.id,
      name: o.name,
      status: o.status,
      location: o.location,
      country: o.country,
      tokenSymbol: o.tokenSymbol,
      image: o.image,
    };
  }

  /**
   * Create a manager profile, optionally with a portal login.
   *
   * The login is an `admins` row with role 'manager' carrying THIS issuer's id,
   * so a manager account is never platform-wide. Creating it is optional
   * precisely because most managers start as a profile on the asset page and
   * only later need to sign in.
   */
  async create(
    principal: Principal,
    tenant: TenantContext,
    input: {
      name: string;
      company?: string | null;
      bio?: string | null;
      logoUrl?: string | null;
      contactEmail?: string | null;
      loginEmail?: string | null;
      loginPassword?: string | null;
    },
  ): Promise<ManagerView> {
    const issuerId = ManagersService.issuerIdOf(tenant);

    let adminId: string | null = null;
    if (input.loginEmail?.trim()) {
      const email = input.loginEmail.trim().toLowerCase();
      if (!input.loginPassword || input.loginPassword.length < MIN_LOGIN_PASSWORD) {
        throw new AppError(
          'WEAK_PASSWORD',
          400,
          `A manager login needs a password of at least ${MIN_LOGIN_PASSWORD} characters.`,
        );
      }
      if (await this.repo.emailTaken(email)) {
        throw AppError.conflict('EMAIL_TAKEN', 'That email already has a login.');
      }
      const login = await this.repo.createLogin(tenant, issuerId, {
        email,
        passwordHash: await bcrypt.hash(input.loginPassword, BCRYPT_ROUNDS),
        name: input.name,
      });
      adminId = login.id;
    }

    const row = await this.repo.create(tenant, issuerId, { ...input, adminId });
    await this.audit.record(principal, tenant, {
      action: 'manager.create',
      target: row.id,
      /* Record THAT a login was created, never the credential. */
      params: { name: row.name, withLogin: adminId != null },
    });
    return ManagersService.view(row);
  }

  /**
   * Update a manager profile.
   *
   * SUSPENDING ALSO REVOKES THE LOGIN, and reactivating restores it. Without
   * that, a suspended manager keeps full access to their properties — they can
   * still post updates and declare distributions — and "suspended" would mean
   * nothing more than a label on a profile page.
   */
  async update(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    fields: {
      name?: string;
      company?: string | null;
      bio?: string | null;
      logoUrl?: string | null;
      contactEmail?: string | null;
      status?: 'active' | 'suspended';
    },
  ): Promise<ManagerView> {
    const existing = await this.repo.findById(tenant, id);
    if (!existing) throw AppError.notFound('Manager', id);

    const row = await this.repo.update(tenant, id, fields);
    if (!row) throw AppError.notFound('Manager', id);

    if (fields.status && existing.adminId) {
      await this.repo.setLoginDisabled(tenant, existing.adminId, fields.status === 'suspended');
    }

    await this.audit.record(principal, tenant, {
      action: 'manager.update',
      target: id,
      params: { fields: Object.keys(fields), status: fields.status ?? null },
    });
    return ManagersService.view(row);
  }

  /** The caller's own properties — the manager portal. */
  async myProperties(principal: Principal, tenant: TenantContext) {
    const managerId = principal.managerId;
    if (!managerId) {
      throw AppError.forbidden('This login is not linked to a manager profile.');
    }
    const rows = await this.repo.listOfferings(tenant, managerId);
    return { items: rows.map(ManagersService.propertyView) };
  }

  /**
   * May this principal act on this property?
   *
   * The guard behind manager-delegated writes. An issuer_admin may act on any
   * of its own offerings (the tenant check already ran); a manager may act only
   * on the ones assigned to them, and only while active — a suspended manager
   * whose login has not yet been revoked must still be refused here.
   */
  async assertOperates(
    principal: Principal,
    tenant: TenantContext,
    offering: { id: string; managerId: string | null },
  ): Promise<void> {
    if (principal.role !== 'manager') return;

    const managerId = principal.managerId;
    if (!managerId) {
      throw AppError.forbidden('This login is not linked to a manager profile.');
    }
    const manager = await this.repo.findById(tenant, managerId);
    if (!manager || manager.status !== 'active') {
      throw AppError.forbidden('This manager account is not active.');
    }
    if (offering.managerId !== managerId) {
      throw AppError.forbidden('You do not manage this property.');
    }
  }
}
