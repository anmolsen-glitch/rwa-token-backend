/**
 * Staff accounts for one issuer.
 *
 * Distinct from AuthRepository, which reads `admins` PRE-tenant (during login,
 * before an issuer is known) and therefore uses db.worker(). Everything here
 * runs inside the caller's tenant, so migration 054's policies apply: an issuer
 * sees and writes only its own staff, and can never create a `platform_admin`
 * or a row with a NULL issuer_id.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { admins, managers, type Admin } from '@shared/db/schema';
import type { AdminRole, TenantContext } from '@shared/auth/tenant-context';

/** A staff row plus whether it is a property manager's portal login. */
export interface TeamRow extends Admin {
  managerId: string | null;
}

@Injectable()
export class TeamRepository {
  constructor(private readonly db: DbService) {}

  /**
   * The issuer's staff, each flagged with the manager profile it belongs to.
   *
   * The LEFT JOIN is the point: a manager's login is an `admins` row like any
   * other, and without knowing which rows those are the caller cannot tell why
   * editing some of them is refused.
   */
  list(t: TenantContext): Promise<TeamRow[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select({
          id: admins.id,
          email: admins.email,
          passwordHash: admins.passwordHash,
          name: admins.name,
          role: admins.role,
          issuerId: admins.issuerId,
          disabled: admins.disabled,
          createdAt: admins.createdAt,
          updatedAt: admins.updatedAt,
          managerId: managers.id,
        })
        .from(admins)
        .leftJoin(managers, eq(managers.adminId, admins.id))
        .orderBy(asc(admins.id)),
    );
  }

  async findById(t: TenantContext, id: string): Promise<TeamRow | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .select({
          id: admins.id,
          email: admins.email,
          passwordHash: admins.passwordHash,
          name: admins.name,
          role: admins.role,
          issuerId: admins.issuerId,
          disabled: admins.disabled,
          createdAt: admins.createdAt,
          updatedAt: admins.updatedAt,
          managerId: managers.id,
        })
        .from(admins)
        .leftJoin(managers, eq(managers.adminId, admins.id))
        .where(eq(admins.id, id))
        .limit(1),
    );
    return row;
  }

  /** Global, deliberately: an email identifies one person across the platform. */
  async emailTaken(email: string): Promise<boolean> {
    const rows = await this.db.worker('team: admin email uniqueness', (tx) =>
      tx
        .select({ id: admins.id })
        .from(admins)
        .where(sql`lower(${admins.email}) = lower(${email})`)
        .limit(1),
    );
    return rows.length > 0;
  }

  async create(
    t: TenantContext,
    issuerId: string,
    input: { email: string; passwordHash: string; name: string | null; role: AdminRole },
  ): Promise<Admin> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(admins)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          name: input.name,
          role: input.role,
          issuerId,
        })
        .returning(),
    );
    return row;
  }

  async update(
    t: TenantContext,
    id: string,
    fields: { role?: AdminRole; disabled?: boolean },
  ): Promise<Admin | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .update(admins)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(admins.id, id))
        .returning(),
    );
    return row;
  }

  /**
   * How many ACTIVE issuer_admins one issuer has, excluding a given id.
   *
   * `issuerId` is passed EXPLICITLY rather than left to RLS, because the caller
   * that most needs this answer is the PLATFORM operator — whose scope spans
   * every issuer, so an unfiltered count would tally unrelated companies'
   * admins and conclude the tenant is fine when it is about to be locked out.
   *
   * Per-issuer either way, unlike the Express version's platform-wide count.
   */
  async countOtherActiveIssuerAdmins(
    t: TenantContext,
    issuerId: string,
    excludeId: string,
  ): Promise<number> {
    const rows = await this.db.scoped(t, (tx) =>
      tx
        .select({ id: admins.id })
        .from(admins)
        .where(
          and(
            eq(admins.issuerId, issuerId),
            eq(admins.role, 'issuer_admin'),
            eq(admins.disabled, false),
            ne(admins.id, excludeId),
          ),
        ),
    );
    return rows.length;
  }
}
