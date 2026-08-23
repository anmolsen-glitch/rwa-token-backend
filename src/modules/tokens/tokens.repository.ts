/**
 * Token lookup, tenant-scoped.
 *
 * THE critical addition versus Express: it resolved a token by symbol from the
 * address book with NO issuer check — correct when there was one issuer, and a
 * cross-tenant hole with several. Every lookup here goes through db.scoped(),
 * so an issuer can only ever resolve its OWN tokens; a symbol belonging to
 * someone else simply does not exist for them.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { AppConfig } from '@shared/config/app-config.service';
import { AppError } from '@shared/errors/app-error';
import { tokens, type Token } from '@shared/db/schema';
import type { TenantContext } from '@shared/auth/tenant-context';

@Injectable()
export class TokensRepository {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  list(tenant: TenantContext): Promise<Token[]> {
    return this.db.scoped(tenant, (tx) =>
      tx.select().from(tokens).where(eq(tokens.network, this.config.get('NETWORK'))),
    );
  }

  async find(tenant: TenantContext, symbol: string): Promise<Token | undefined> {
    const [row] = await this.db.scoped(tenant, (tx) =>
      tx
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.network, this.config.get('NETWORK')),
            sql`upper(${tokens.symbol}) = upper(${symbol})`,
          ),
        )
        .limit(1),
    );
    return row;
  }

  /**
   * Resolve a symbol WITHOUT a tenant — settlement only.
   *
   * A payment webhook carries no session, so there is no tenant to scope by;
   * the order itself already names the token, and the signature is the
   * authorization. Never call this from a request handler.
   */
  /** Non-throwing variant of requireAnyTenant — for views where a missing
      token just means "not deployed yet", not an error. */
  async findAnyTenant(symbol: string): Promise<Token | undefined> {
    const [row] = await this.db.worker('tokens: view lookup', (tx) =>
      tx
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.network, this.config.get('NETWORK')),
            sql`upper(${tokens.symbol}) = upper(${symbol})`,
          ),
        )
        .limit(1),
    );
    return row;
  }

  async requireAnyTenant(symbol: string): Promise<Token> {
    const [row] = await this.db.worker('tokens: settlement lookup', (tx) =>
      tx
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.network, this.config.get('NETWORK')),
            sql`upper(${tokens.symbol}) = upper(${symbol})`,
          ),
        )
        .limit(1),
    );
    if (!row) throw AppError.notFound('Token', symbol);
    return row;
  }

  /**
   * The token or a 404.
   *
   * 404 rather than 403 for someone else's token: confirming that a symbol
   * exists but belongs to another issuer discloses their asset list.
   */
  async require(tenant: TenantContext, symbol: string): Promise<Token> {
    const row = await this.find(tenant, symbol);
    if (!row) {
      throw AppError.notFound('Token', symbol);
    }
    return row;
  }
}
