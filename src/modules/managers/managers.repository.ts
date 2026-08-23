/**
 * Persistence for property managers and their optional portal logins.
 *
 * Everything is tenant-scoped; the RLS policies from migration 053 are the
 * backstop, and `offerings_manager_same_issuer` stops a manager being paired
 * with another issuer's asset even by the platform admin.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { admins, managers, offerings, type Admin, type Manager, type Offering } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class ManagersRepository {
  constructor(private readonly db: DbService) {}

  list(t: TenantContext): Promise<Manager[]> {
    return this.db.scoped(t, (tx) =>
      tx.select().from(managers).orderBy(desc(managers.createdAt)),
    );
  }

  /** One issuer's managers — an explicit filter so a PLATFORM caller viewing a
      specific SPV does not receive every tenant's roster. */
  listForIssuer(t: TenantContext, issuerId: string): Promise<Manager[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(managers)
        .where(eq(managers.issuerId, issuerId))
        .orderBy(desc(managers.createdAt)),
    );
  }

  async findById(t: TenantContext, id: string): Promise<Manager | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.select().from(managers).where(eq(managers.id, id)).limit(1),
    );
    return row;
  }

  /**
   * Which manager profile a portal login belongs to.
   *
   * Pre-tenant by necessity: this runs while RESOLVING the caller's own scope,
   * so there is no tenant context to scope it with yet. It is keyed on the
   * admin's own id, which the JWT already proved, so it cannot be used to read
   * another issuer's manager.
   */
  async findByAdminId(adminId: string): Promise<Manager | undefined> {
    const [row] = await this.db.worker('auth: resolve manager profile for login', (tx) =>
      tx.select().from(managers).where(eq(managers.adminId, adminId)).limit(1),
    );
    return row;
  }

  async create(
    t: TenantContext,
    issuerId: string,
    input: {
      name: string;
      company?: string | null;
      bio?: string | null;
      logoUrl?: string | null;
      contactEmail?: string | null;
      adminId?: string | null;
    },
  ): Promise<Manager> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(managers)
        .values({
          issuerId,
          name: input.name,
          company: input.company ?? null,
          bio: input.bio ?? null,
          logoUrl: input.logoUrl ?? null,
          contactEmail: input.contactEmail ?? null,
          adminId: input.adminId ?? null,
        })
        .returning(),
    );
    return row;
  }

  async update(
    t: TenantContext,
    id: string,
    fields: Partial<Pick<Manager, 'name' | 'company' | 'bio' | 'logoUrl' | 'contactEmail' | 'status'>>,
  ): Promise<Manager | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.update(managers).set(fields).where(eq(managers.id, id)).returning(),
    );
    return row;
  }

  /** The properties a manager operates. */
  listOfferings(t: TenantContext, managerId: string): Promise<Offering[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(offerings)
        .where(eq(offerings.managerId, managerId))
        .orderBy(asc(offerings.sortOrder), desc(offerings.createdAt)),
    );
  }

  /* ---- portal logins ---------------------------------------------------- */

  /**
   * Create the manager's login as an `admins` row with role 'manager'.
   *
   * The login is created INSIDE the caller's tenant scope and carries the same
   * issuer_id, so a manager login is never a platform-wide account.
   */
  async createLogin(
    t: TenantContext,
    issuerId: string,
    input: { email: string; passwordHash: string; name: string },
  ): Promise<Admin> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(admins)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          name: input.name,
          role: 'manager',
          issuerId,
        })
        .returning(),
    );
    return row;
  }

  async emailTaken(email: string): Promise<boolean> {
    /* Uniqueness is global across admins, so this cannot be tenant-scoped —
       otherwise two issuers could create the same login and the second would
       fail at the index with a 500 instead of a clean message. */
    const rows = await this.db.worker('managers: admin email uniqueness', (tx) =>
      tx
        .select({ id: admins.id })
        .from(admins)
        .where(sql`lower(${admins.email}) = lower(${email})`)
        .limit(1),
    );
    return rows.length > 0;
  }

  /**
   * Enable or disable a manager's login.
   *
   * Scoped AND pinned to role 'manager': this must never be able to disable an
   * issuer_admin or a compliance officer by passing their id.
   */
  async setLoginDisabled(t: TenantContext, adminId: string, disabled: boolean): Promise<void> {
    await this.db.scoped(t, (tx) =>
      tx
        .update(admins)
        .set({ disabled, updatedAt: new Date() })
        .where(and(eq(admins.id, adminId), eq(admins.role, 'manager'))),
    );
  }
}
