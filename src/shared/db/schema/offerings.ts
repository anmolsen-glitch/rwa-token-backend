/**
 * Mirrors migrations/004_multiasset.sql + 011 (issuer_id) + later additions.
 *
 * Money columns are NUMERIC in Postgres and read as `string` here — never as
 * `number`. Float money is how you lose paise. Convert to bigint minor units at
 * the repository edge (CLAUDE.md §4.1).
 */
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { bigintId } from './columns';

export const offerings = pgTable('offerings', {
  id: text('id').primaryKey(),
  tokenSymbol: text('token_symbol'),
  issuerId: bigintId('issuer_id').notNull(), // NOT NULL since migration 043
  managerId: bigintId('manager_id'),
  name: text('name').notNull(),
  location: text('location'),
  assetType: text('asset_type'),
  image: text('image'),
  description: text('description'),
  currency: text('currency').notNull().default('INR'),
  pricePerToken: numeric('price_per_token').notNull(),
  minInvestment: numeric('min_investment').notNull(),
  targetRaise: numeric('target_raise').notNull(),
  yieldPct: numeric('yield_pct'),
  country: integer('country').notNull(),
  status: text('status').notNull().default('coming_soon'),
  /**
   * 'public' | 'private'. SEPARATE from status: an offering can be `open` and
   * still not be listed publicly (a private placement shown only to invited
   * investors). Every sessionless read must filter on BOTH — status alone puts
   * a private placement on the marketplace.
   */
  visibility: text('visibility').notNull().default('public'),
  /* Deploy inputs. NOT the source of truth for accreditation — see below. */
  tokenPlan: jsonb('token_plan'),

  /*
   * THE authoritative accredited-only flag. `token_plan` also carries a
   * `requiresAccreditation` key on some rows and the two DISAGREE (goa-villa:
   * column true, plan false), so reading the plan silently drops the gate.
   */
  requiresAccreditation: boolean('requires_accreditation').notNull().default(false),

  /* Per-investor caps, expressed in CURRENCY. Divided by price_per_token to get
     a token cap — the unit the limit rules work in. null = uncapped. */
  maxInvestment: numeric('max_investment'),
  accreditedMaxInvestment: numeric('accredited_max_investment'),
  minimumRaise: numeric('minimum_raise'),
  /** Where a crypto payment for this asset goes — the seller's own wallet. */
  sellerWallet: text('seller_wallet'),

  /* Property taxonomy + listing detail (migrations 020/029/031). */
  propertyType: text('property_type'),
  cashFlowing: boolean('cash_flowing').notNull().default(false),
  occupancyPct: numeric('occupancy_pct'),
  ownerOccupied: boolean('owner_occupied').notNull().default(false),
  retainedPct: numeric('retained_pct'),
  currentValuation: numeric('current_valuation'),
  valuationUpdatedAt: timestamp('valuation_updated_at', { withTimezone: true }),
  images: text('images').array(),
  /** [{ type, name?, url? }] — the wizard's required listing documents. */
  documents: jsonb('documents'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Offering = typeof offerings.$inferSelect;
export type NewOffering = typeof offerings.$inferInsert;
