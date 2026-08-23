/**
 * Team management — an issuer's own back-office staff.
 *
 * Ported from ../rwa-token-backend/src/services/auth.service.ts (createAdmin /
 * updateAdmin / listAdmins). Both Express guardrails are kept:
 *
 *   - you cannot disable or demote your OWN account;
 *   - you cannot disable or demote the LAST active issuer_admin.
 *
 * Both exist to stop an issuer locking itself out of its own tenant, which is
 * unrecoverable without the platform operator.
 *
 * TWO THINGS CHANGE UNDER TENANCY:
 *
 * 1. The "last active issuer_admin" count is PER ISSUER. The Express version
 *    counted platform-wide, which would have let one issuer lock itself out
 *    while a different company still had admins.
 *
 * 2. `platform_admin` cannot be created here at all. An issuer minting a
 *    superuser is the escalation this module has to be judged against, and it
 *    is refused in the DATABASE too (migration 054) — this check exists to
 *    return a clean 403 rather than an RLS rejection surfacing as a 500.
 */
import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import type { AdminRole, Principal, TenantContext } from '@shared/auth/tenant-context';
import { TeamRepository, type TeamRow } from './team.repository';

const BCRYPT_ROUNDS = 12;
/* The password floor lives in the DTO (min 10), so it is enforced once and
   documented in the OpenAPI schema rather than duplicated here. */

/**
 * Roles an issuer may assign to its own staff.
 *
 * `platform_admin` is absent because a tenant must not mint a superuser.
 * `manager` is absent for a different reason: a manager's login only makes
 * sense alongside a manager PROFILE, so it is created through the managers
 * module. Allowing it here would produce a login with no profile — which
 * `principal.managerId` resolves to undefined, and every manager route refuses.
 */
const ASSIGNABLE_ROLES: AdminRole[] = ['issuer_admin', 'compliance', 'agent', 'spv_manager'];

export interface TeamMemberView {
  id: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  /** Set when this login belongs to a property manager — see `update`. */
  managerId: string | null;
  createdAt: string;
}

@Injectable()
export class TeamService {
  constructor(
    private readonly repo: TeamRepository,
    private readonly audit: AuditService,
  ) {}

  private static view(a: TeamRow): TeamMemberView {
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      role: a.role,
      disabled: a.disabled,
      managerId: a.managerId,
      createdAt: a.createdAt.toISOString(),
      /* passwordHash is deliberately absent, and this is the only place the
         shape is built — there is no spread of the raw row anywhere. */
    };
  }

  /** Creating staff needs an issuer to attach them to, so it is issuer-only. */
  private static issuerIdOf(tenant: TenantContext): string {
    if (tenant.kind !== 'issuer') {
      throw AppError.forbidden('Only an issuer can add to its own team.');
    }
    return tenant.issuerId;
  }

  /**
   * Reads and edits also allow the PLATFORM operator.
   *
   * Not a convenience: the last-issuer_admin guard below says losing that
   * account is unrecoverable without the operator, so the operator has to be
   * able to reach this endpoint or the claim is false. Every platform action
   * writes an audit row.
   */
  private static assertCanManage(tenant: TenantContext): void {
    if (tenant.kind !== 'issuer' && tenant.kind !== 'platform') {
      throw AppError.forbidden('Only issuer or platform staff can manage a team.');
    }
  }

  private static assertAssignable(role: AdminRole): void {
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw AppError.forbidden(
        role === 'manager'
          ? 'Create a property manager with a login instead — that is what makes a manager account.'
          : `You cannot assign the "${role}" role.`,
      );
    }
  }

  async list(tenant: TenantContext): Promise<{ items: TeamMemberView[] }> {
    TeamService.assertCanManage(tenant);
    const rows = await this.repo.list(tenant);
    return { items: rows.map(TeamService.view) };
  }

  async create(
    principal: Principal,
    tenant: TenantContext,
    input: { email: string; password: string; name?: string | null; role: AdminRole },
  ): Promise<TeamMemberView> {
    const issuerId = TeamService.issuerIdOf(tenant);
    TeamService.assertAssignable(input.role);

    const email = input.email.trim().toLowerCase();
    if (await this.repo.emailTaken(email)) {
      throw AppError.conflict('EMAIL_TAKEN', 'An account with that email already exists.');
    }

    const row = await this.repo.create(tenant, issuerId, {
      email,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      name: input.name ?? null,
      role: input.role,
    });

    await this.audit.record(principal, tenant, {
      action: 'admin.create',
      target: row.id,
      /* The role is the security-relevant fact. The password never appears. */
      params: { email, role: input.role },
    });
    return TeamService.view({ ...row, managerId: null });
  }

  /**
   * Change a colleague's role, or disable/re-enable them.
   *
   * Disabling takes effect on the NEXT REQUEST, not at token expiry, because
   * PrincipalService re-reads the row every time. That is what makes this a
   * real control rather than a flag.
   */
  async update(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    changes: { role?: AdminRole; disabled?: boolean },
  ): Promise<TeamMemberView> {
    TeamService.assertCanManage(tenant);

    const target = await this.repo.findById(tenant, id);
    /* 404 rather than 403 for another issuer's staff: RLS already hid the row,
       and confirming it exists discloses a competitor's headcount. */
    if (!target) throw AppError.notFound('Team member', id);

    if (changes.role !== undefined) TeamService.assertAssignable(changes.role);

    /* A manager's login is owned by their PROFILE — suspending the manager is
       what disables it. Editing it from both places gives one account two
       sources of truth for whether it works. */
    if (target.managerId) {
      throw AppError.conflict(
        'MANAGED_ELSEWHERE',
        'This login belongs to a property manager. Change it on the manager instead.',
        { managerId: target.managerId },
      );
    }

    const disabling = changes.disabled === true && !target.disabled;
    const demoting =
      changes.role !== undefined && changes.role !== 'issuer_admin' && target.role === 'issuer_admin';

    if ((disabling || demoting) && target.id === principal.id) {
      throw new AppError(
        'SELF_LOCKOUT',
        400,
        "You can't disable or demote your own account.",
      );
    }

    if ((disabling || demoting) && target.role === 'issuer_admin' && !target.disabled) {
      /* Counted within the TARGET's issuer, not the caller's scope — for a
         platform caller those are not the same thing. */
      if ((await this.repo.countOtherActiveIssuerAdmins(tenant, target.issuerId!, id)) === 0) {
        /* Losing the last one is unrecoverable without the platform operator. */
        throw new AppError(
          'LAST_ISSUER_ADMIN',
          400,
          "Can't disable or demote the last active issuer_admin.",
        );
      }
    }

    const row = await this.repo.update(tenant, id, changes);
    if (!row) throw AppError.notFound('Team member', id);

    await this.audit.record(principal, tenant, {
      action: 'admin.update',
      target: id,
      params: { role: changes.role ?? null, disabled: changes.disabled ?? null },
    });
    return TeamService.view({ ...row, managerId: null });
  }
}
