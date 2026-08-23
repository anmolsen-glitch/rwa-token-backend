/**
 * Admin lookups for authentication.
 *
 * These run BEFORE a tenant is known — you cannot scope a login by issuer when
 * the issuer is what the login is about to establish. So they use db.worker()
 * with an explicit reason, which is the sanctioned pre-tenant path.
 */
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { admins, type Admin } from '@shared/db/schema';

@Injectable()
export class AuthRepository {
  constructor(private readonly db: DbService) {}

  /** Case-insensitive: emails are identities, not passwords. */
  async findByEmail(email: string): Promise<Admin | undefined> {
    const [row] = await this.db.worker('auth: login lookup by email', (tx) =>
      tx
        .select()
        .from(admins)
        .where(sql`lower(${admins.email}) = lower(${email})`)
        .limit(1),
    );
    return row;
  }

  async findById(id: string): Promise<Admin | undefined> {
    const [row] = await this.db.worker('auth: admin lookup by id', (tx) =>
      tx.select().from(admins).where(eq(admins.id, id)).limit(1),
    );
    return row;
  }
}
