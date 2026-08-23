import { Injectable } from '@nestjs/common';
import { DbService } from '@shared/db/db.service';
import { webhookEvents } from '@shared/db/schema';

/**
 * Uses db.worker(): a webhook arrives from a PROVIDER, not a session, so there
 * is no tenant to scope by. It is also the connection with BYPASSRLS, which the
 * downstream handlers need in order to write across tenants.
 */
@Injectable()
export class WebhooksRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Claim an event id. Returns false if it was already handled.
   *
   * PORTED VERBATIM (db.recordWebhookEvent). The atomicity is the whole point:
   * INSERT .. ON CONFLICT DO NOTHING RETURNING lets exactly one caller win, even
   * when a provider retries concurrently. A SELECT-then-INSERT would let two
   * simultaneous deliveries both pass the check and double-apply a payment.
   */
  async claim(eventId: string, source: string): Promise<boolean> {
    const rows = await this.db.worker('webhooks: claim event id', (tx) =>
      tx.insert(webhookEvents).values({ eventId, source }).onConflictDoNothing().returning(),
    );
    return rows.length > 0;
  }
}
