/**
 * Which tokens to index.
 *
 * CHANGED FROM THE EXPRESS VERSION: it read `listTokens()` from the
 * deployed-addresses.json address book. Since migration 039 the `tokens` TABLE
 * is authoritative for token -> issuer, and it is network-keyed — so the
 * indexer now reads the table and can never index a token from the wrong chain,
 * which the address book made possible by returning whatever section was loaded.
 */
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppConfig } from '@shared/config/app-config.service';
import { DbService } from '@shared/db/db.service';
import { tokens } from '@shared/db/schema';

export interface IndexedToken {
  symbol: string;
  address: string;
  issuerId: string;
}

@Injectable()
export class IndexerTokensRepository {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  async list(): Promise<IndexedToken[]> {
    const rows = await this.db.worker('indexer: list tokens for network', (tx) =>
      tx
        .select({ symbol: tokens.symbol, address: tokens.address, issuerId: tokens.issuerId })
        .from(tokens)
        .where(eq(tokens.network, this.config.get('NETWORK'))),
    );
    return rows;
  }
}
