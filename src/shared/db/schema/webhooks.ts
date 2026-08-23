/**
 * Mirrors migrations for webhook_events.
 *
 * The replay ledger. `event_id` is the provider's own id, and the PRIMARY KEY on
 * it is what makes replay protection atomic: an INSERT .. ON CONFLICT DO NOTHING
 * that returns no row means this event was already handled.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const webhookEvents = pgTable('webhook_events', {
  eventId: text('event_id').primaryKey(),
  source: text('source').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WebhookEvent = typeof webhookEvents.$inferSelect;
