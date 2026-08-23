/**
 * Issuer reads.
 *
 * The scoping rule here is the sharpest in the app: an issuer_admin may read
 * exactly ONE issuer row — its own. Listing all issuers is a platform-only
 * capability, because the roster of issuers is the platform's book of business
 * (TENANCY_MODEL.md §5.1).
 */
import { Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { issuers, type Issuer } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class IssuersRepository {
  constructor(private readonly db: DbService) {}

  async listAll(tenant: TenantContext): Promise<Issuer[]> {
    return this.db.scoped(tenant, (tx) =>
      tx.select().from(issuers).orderBy(desc(issuers.createdAt)),
    );
  }

  async create(
    tenant: TenantContext,
    input: { name: string; legalEntity?: string; contactEmail?: string; ownerWallet?: string },
  ): Promise<Issuer> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx
        .insert(issuers)
        .values({
          name: input.name,
          legalEntity: input.legalEntity ?? null,
          contactEmail: input.contactEmail ?? null,
          ownerWallet: input.ownerWallet ?? null,
          /* Always starts unapproved. An issuer that could self-approve its own
             KYB is not KYB at all. */
          kybStatus: 'pending_review',
        })
        .returning(),
    );
    return row;
  }

  async update(
    tenant: TenantContext,
    id: string,
    patch: { name?: string; legalEntity?: string; contactEmail?: string; ownerWallet?: string },
  ): Promise<Issuer | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.legalEntity !== undefined) set.legalEntity = patch.legalEntity;
    if (patch.contactEmail !== undefined) set.contactEmail = patch.contactEmail;
    if (patch.ownerWallet !== undefined) set.ownerWallet = patch.ownerWallet;

    const [row] = await this.db.scoped(tenant, (tx) =>
      tx.update(issuers).set(set).where(eq(issuers.id, id)).returning(),
    );
    return row;
  }

  /**
   * Record a KYB decision. Platform-only at the service layer; the RLS write
   * policy on `issuers` is platform-only too, so this is enforced twice.
   */
  async setKyb(
    tenant: TenantContext,
    id: string,
    status: 'approved' | 'rejected',
    note: string | null,
  ): Promise<Issuer | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx
        .update(issuers)
        .set({ kybStatus: status, kybNote: note, updatedAt: new Date() })
        .where(eq(issuers.id, id))
        .returning(),
    );
    return row;
  }

  /**
   * Self-service application — no session at all.
   *
   * Uses db.worker() because an applicant has no tenant by definition: they are
   * asking to BECOME one. The row lands as pending_review and can do nothing
   * until a platform admin approves it.
   */
  async applyAsNewIssuer(input: {
    name: string;
    legalEntity?: string;
    contactEmail: string;
  }): Promise<Issuer> {
    const [row] = await this.db.worker('issuers: public application', (tx) =>
      tx
        .insert(issuers)
        .values({
          name: input.name,
          legalEntity: input.legalEntity ?? null,
          contactEmail: input.contactEmail,
          kybStatus: 'pending_review',
        })
        .returning(),
    );
    return row;
  }

  /** Pending applications, for the platform review queue. */
  pendingKyb(tenant: TenantContext): Promise<Issuer[]> {
    return this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(issuers)
        .where(sql`${issuers.kybStatus} = 'pending_review'`)
        .orderBy(desc(issuers.createdAt)),
    );
  }

  async findById(tenant: TenantContext, id: string): Promise<Issuer | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx.select().from(issuers).where(eq(issuers.id, id)).limit(1),
    );
    return row;
  }
}
