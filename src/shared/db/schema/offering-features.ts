/**
 * Tables that hang off an offering: valuations, manager updates, the buyback
 * bid and its sales, and manager-change governance.
 *
 * All scope through offering_id -> offerings.issuer_id (migration 051).
 */
import { bigint, pgTable, primaryKey, numeric, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bigintId } from './columns';

export const valuations = pgTable('valuations', {
  id: bigintId('id').primaryKey().default(sql`nextval('valuations_id_seq'::regclass)`),
  offeringId: text('offering_id').notNull(),
  totalValue: numeric('total_value').notNull(),
  note: text('note'),
  /** 'launch' | 'appraisal' | 'avm' | 'manual' */
  source: text('source'),
  createdByEmail: text('created_by_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const propertyUpdates = pgTable('property_updates', {
  id: bigintId('id').primaryKey().default(sql`nextval('property_updates_id_seq'::regclass)`),
  offeringId: text('offering_id').notNull(),
  managerId: bigintId('manager_id'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One standing bid per offering — the offering id IS the primary key. */
export const buybackOffers = pgTable('buyback_offers', {
  offeringId: text('offering_id').primaryKey(),
  sellerWallet: text('seller_wallet').notNull(),
  pricePerToken: numeric('price_per_token').notNull(),
  /** null = unlimited budget. */
  maxTokens: bigint('max_tokens', { mode: 'number' }),
  tokensBought: bigint('tokens_bought', { mode: 'number' }).notNull().default(0),
  status: text('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const buybackSales = pgTable('buyback_sales', {
  id: bigintId('id').primaryKey().default(sql`nextval('buyback_sales_id_seq'::regclass)`),
  offeringId: text('offering_id').notNull(),
  wallet: text('wallet').notNull(),
  tokens: bigint('tokens', { mode: 'number' }).notNull(),
  pricePerToken: numeric('price_per_token').notNull(),
  amountFiat: numeric('amount_fiat').notNull(),
  txHash: text('tx_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const managerProposals = pgTable('manager_proposals', {
  id: bigintId('id').primaryKey().default(sql`nextval('manager_proposals_id_seq'::regclass)`),
  offeringId: text('offering_id').notNull(),
  proposedManagerId: bigintId('proposed_manager_id').notNull(),
  reason: text('reason'),
  status: text('status').notNull().default('open'),
  opensAt: timestamp('opens_at', { withTimezone: true }).notNull().defaultNow(),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
  createdBy: bigintId('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const managerVotes = pgTable(
  'manager_votes',
  {
    proposalId: bigintId('proposal_id').notNull(),
    /** The voter's PRIMARY wallet — one person, one vote, however many wallets. */
    wallet: text('wallet').notNull(),
    /** On-chain token balance AT VOTE TIME, captured so a later sale cannot
        retroactively change a recorded tally. */
    weight: numeric('weight').notNull(),
    choice: text('choice').notNull(),
    votedAt: timestamp('voted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.wallet] })],
);

export type Valuation = typeof valuations.$inferSelect;
export type PropertyUpdate = typeof propertyUpdates.$inferSelect;
export type BuybackOffer = typeof buybackOffers.$inferSelect;
export type BuybackSale = typeof buybackSales.$inferSelect;
export type ManagerProposal = typeof managerProposals.$inferSelect;
export type ManagerVote = typeof managerVotes.$inferSelect;
