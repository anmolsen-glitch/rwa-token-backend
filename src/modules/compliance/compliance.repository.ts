/**
 * AML + accreditation persistence.
 *
 * db.worker() throughout: both are platform-level determinations about a person
 * who may belong to no issuer's cap table. Authorization is @Roles; every
 * decision is audited by the service.
 *
 * DUAL-WRITE, TEMPORARY: the Express app still reads investors.aml_status and
 * investors.accreditation_status. Delete the mirrors when its routes go.
 */
import { Injectable } from '@nestjs/common';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import {
  accounts,
  amlScreenings,
  investors,
  type Account,
  type AmlScreening,
} from '@shared/db/schema';

@Injectable()
export class ComplianceRepository {
  constructor(private readonly db: DbService) {}

  async accountById(id: string): Promise<Account | undefined> {
    const [row] = await this.db.worker('compliance: load account', (tx) =>
      tx.select().from(accounts).where(eq(accounts.id, id)).limit(1),
    );
    return row;
  }

  /** Lower-cased wallets the person controls. */
  async walletsForAccount(accountId: string): Promise<string[]> {
    const rows = await this.db.worker('compliance: wallets for account', (tx) =>
      tx.select({ w: investors.wallet }).from(investors).where(eq(investors.accountId, accountId)),
    );
    return rows.map((r) => r.w.toLowerCase());
  }

  async insertScreening(s: {
    wallet: string;
    person: string;
    provider: string;
    reference: string;
    riskScore: number;
    riskLevel: string;
    sanctioned: boolean;
    categories: string[];
    decision: string;
    raw: Record<string, unknown>;
    screenedBy: string | null;
  }): Promise<void> {
    await this.db.worker('compliance: insert screening', (tx) =>
      tx.insert(amlScreenings).values(s),
    );
  }

  async latestScreening(wallet: string): Promise<AmlScreening | undefined> {
    const [row] = await this.db.worker('compliance: latest screening', (tx) =>
      tx
        .select()
        .from(amlScreenings)
        .where(sql`lower(${amlScreenings.wallet}) = lower(${wallet})`)
        .orderBy(desc(amlScreenings.screenedAt))
        .limit(1),
    );
    return row;
  }

  async screeningsForWallets(wallets: string[]): Promise<AmlScreening[]> {
    if (wallets.length === 0) return [];
    return this.db.worker('compliance: screening history', (tx) =>
      tx
        .select()
        .from(amlScreenings)
        .where(inArray(amlScreenings.wallet, wallets))
        .orderBy(desc(amlScreenings.screenedAt)),
    );
  }

  async setAmlStatus(accountId: string, status: string): Promise<void> {
    await this.db.worker('compliance: set aml status', async (tx) => {
      await tx
        .update(accounts)
        .set({ amlStatus: status, updatedAt: new Date() })
        .where(eq(accounts.id, accountId));
      /* Express mirror. */
      await tx
        .update(investors)
        .set({ amlStatus: status, updatedAt: new Date() })
        .where(eq(investors.accountId, accountId));
    });
  }

  async setAccreditation(accountId: string, status: string, note: string | null): Promise<void> {
    await this.db.worker('compliance: set accreditation', async (tx) => {
      await tx
        .update(accounts)
        .set({
          accreditationStatus: status,
          accreditationNote: note,
          accreditationDecidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));
      /* Express mirror. */
      await tx
        .update(investors)
        .set({ accreditationStatus: status, accreditationNote: note, updatedAt: new Date() })
        .where(eq(investors.accountId, accountId));
    });
  }

  /** KYC-approved people who are not yet accredited — the review candidates. */
  candidates(): Promise<Account[]> {
    return this.db.worker('compliance: accreditation candidates', (tx) =>
      tx
        .select()
        .from(accounts)
        .where(
          sql`${accounts.kycStatus} = 'completed' AND ${accounts.accreditationStatus} <> 'accredited'`,
        )
        .orderBy(desc(accounts.updatedAt)),
    );
  }
}
