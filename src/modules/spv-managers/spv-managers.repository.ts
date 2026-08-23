/**
 * Persistence for SPV managers.
 *
 * Tenant-scoped throughout; migration 055's policies are the backstop, and
 * `managers_spv_same_issuer` stops a property manager being placed under
 * another issuer's SPV manager even by the platform admin.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { managers, spvManagers, type Manager, type SpvManager } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class SpvManagersRepository {
  constructor(private readonly db: DbService) {}

  list(t: TenantContext, issuerId: string): Promise<SpvManager[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(spvManagers)
        .where(eq(spvManagers.issuerId, issuerId))
        .orderBy(desc(spvManagers.createdAt)),
    );
  }

  async findById(t: TenantContext, id: string): Promise<SpvManager | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.select().from(spvManagers).where(eq(spvManagers.id, id)).limit(1),
    );
    return row;
  }

  async create(
    t: TenantContext,
    issuerId: string,
    input: { name: string; company?: string | null; contactEmail?: string | null; phone?: string | null },
  ): Promise<SpvManager> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .insert(spvManagers)
        .values({
          issuerId,
          name: input.name,
          company: input.company ?? null,
          contactEmail: input.contactEmail ?? null,
          phone: input.phone ?? null,
        })
        .returning(),
    );
    return row;
  }

  async update(
    t: TenantContext,
    id: string,
    fields: Partial<Pick<SpvManager, 'name' | 'company' | 'contactEmail' | 'phone' | 'status'>>,
  ): Promise<SpvManager | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx
        .update(spvManagers)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(spvManagers.id, id))
        .returning(),
    );
    return row;
  }

  /** The property managers reporting to this SPV manager. */
  reports(t: TenantContext, spvManagerId: string): Promise<Manager[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(managers)
        .where(eq(managers.spvManagerId, spvManagerId))
        .orderBy(desc(managers.createdAt)),
    );
  }

  /**
   * Property managers this SPV manager could take on: the issuer's own, and
   * only those not already reporting elsewhere.
   *
   * In the Express version this was a relational query joining offerings and
   * spv_managers, because `managers` had no issuer_id. Migration 053 gave it
   * one, so eligibility is now a plain column filter that RLS also enforces.
   */
  eligible(t: TenantContext, issuerId: string, spvManagerId: string): Promise<Manager[]> {
    return this.db.scoped(t, (tx) =>
      tx
        .select()
        .from(managers)
        .where(
          and(
            eq(managers.issuerId, issuerId),
            or(isNull(managers.spvManagerId), eq(managers.spvManagerId, spvManagerId)),
          ),
        )
        .orderBy(desc(managers.createdAt)),
    );
  }

  /**
   * One property manager, within the caller's scope.
   *
   * This module owns the manager <-> spv_manager RELATION, so it reads both
   * sides of it. It does not otherwise touch manager business rules — creating
   * a manager still goes through ManagersService.
   */
  async findManager(t: TenantContext, managerId: string): Promise<Manager | undefined> {
    const [row] = await this.db.scoped(t, (tx) =>
      tx.select().from(managers).where(eq(managers.id, managerId)).limit(1),
    );
    return row;
  }

  /** Place a property manager under an SPV manager, or release it (null). */
  async setReportsTo(t: TenantContext, managerId: string, spvManagerId: string | null): Promise<void> {
    await this.db.scoped(t, (tx) =>
      tx.update(managers).set({ spvManagerId }).where(eq(managers.id, managerId)),
    );
  }
}
