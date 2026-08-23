/**
 * Loads the authenticated principal from the database.
 *
 * The token is never trusted as standalone authorization — the admin row is
 * re-read on every request so disabling or deleting an account takes effect
 * immediately rather than at token expiry. Carried over from the Express app's
 * authGuard, and it is a property worth keeping.
 *
 * This lookup is legitimately pre-tenant (we do not yet know the tenant), so it
 * uses db.worker() with an explicit reason.
 */
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { accounts, admins, investors, managers } from '../db/schema';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors/app-error';
import type { AdminRole, Principal } from './tenant-context';

@Injectable()
export class PrincipalService {
  constructor(private readonly db: DbService) {}

  async loadAdmin(adminId: string): Promise<Principal> {
    const [row] = await this.db.worker('auth: resolve admin principal', (tx) =>
      tx.select().from(admins).where(eq(admins.id, adminId)).limit(1),
    );

    if (!row || row.disabled) {
      throw AppError.unauthorized('Account is disabled or no longer exists.');
    }

    /* A 'manager' login is scoped to the manager PROFILE it is linked to, and
       every manager-side route filters by that id. Resolving it here means no
       route has to remember to look it up — and a manager login with no profile
       ends up with an undefined managerId, which the routes refuse, rather than
       silently widening to "all properties". */
    let managerId: string | undefined;
    if (row.role === 'manager') {
      const [m] = await this.db.worker('auth: resolve manager profile', (tx) =>
        tx.select({ id: managers.id }).from(managers).where(eq(managers.adminId, row.id)).limit(1),
      );
      managerId = m?.id;
    }

    return {
      kind: 'admin',
      id: row.id,
      email: row.email,
      role: row.role as AdminRole,
      issuerId: row.issuerId ?? undefined,
      managerId,
    };
  }

  /**
   * An account session — the PERSON, who may have no wallet yet.
   *
   * Re-read on every request like admins, so deleting an account takes effect
   * immediately rather than at token expiry.
   */
  async loadAccount(accountId: string): Promise<Principal> {
    const [row] = await this.db.worker('auth: resolve account principal', (tx) =>
      tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
    );
    if (!row) throw AppError.unauthorized('Account no longer exists.');

    /* Email verification gates the rest of the flow. Enforcing it here means no
       individual route has to remember to check it. */
    if (!row.emailVerified) {
      throw new AppError('EMAIL_NOT_VERIFIED', 403, 'Verify your email address to continue.');
    }

    return { kind: 'account', id: row.id, email: row.email, accountId: row.id };
  }

  /**
   * An investor (wallet) session, established by SIWE.
   *
   * The wallet must still be linked to a person: unlinking must invalidate the
   * session immediately, not at expiry.
   */
  async loadInvestor(wallet: string): Promise<Principal> {
    const [row] = await this.db.worker('auth: resolve investor principal', (tx) =>
      tx
        .select()
        .from(investors)
        .where(sql`lower(${investors.wallet}) = lower(${wallet})`)
        .limit(1),
    );
    if (!row) throw AppError.unauthorized('Wallet is not registered.');

    return {
      kind: 'investor',
      id: row.wallet,
      wallet: row.wallet,
      accountId: row.accountId ?? undefined,
    };
  }
}
