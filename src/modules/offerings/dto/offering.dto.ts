import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/* Money stays a STRING end to end: NUMERIC in Postgres, compared in integer
   paise. A JS number here would round before it ever reached the money helpers. */
const money = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Must be a decimal amount');

export const CreateOfferingSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Lowercase slug, e.g. `bandra-tower-a`'),
  name: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).optional(),
  assetType: z.string().trim().max(80).optional(),
  image: z.string().trim().max(500).optional(),
  description: z.string().trim().max(5000).optional(),
  currency: z.string().trim().length(3).default('INR'),
  pricePerToken: money,
  minInvestment: money,
  targetRaise: money,
  yieldPct: money.optional(),
  country: z.coerce.number().int().min(1).max(999),
  /* Per-investor caps, in currency. Absent = uncapped. */
  maxInvestment: money.optional(),
  accreditedMaxInvestment: money.optional(),
  minimumRaise: money.optional(),
  /* THE authoritative accredited-only flag — never token_plan. */
  requiresAccreditation: z.boolean().default(false),
});
export class CreateOfferingDto extends createZodDto(CreateOfferingSchema) {}

/* `id` and `issuerId` are not patchable: the slug is referenced by orders, and
   the issuer comes from the caller's tenant. */
export const UpdateOfferingSchema = CreateOfferingSchema.omit({ id: true }).partial();
export class UpdateOfferingDto extends createZodDto(UpdateOfferingSchema) {}

export const DeployTokenSchema = z.object({
  symbol: z.string().trim().regex(/^[A-Z0-9]{2,12}$/, 'Uppercase alphanumeric, 2-12 chars'),
  /* Whole tokens only — the payout allocator assumes decimals === 0. */
  decimals: z.coerce.number().int().min(0).max(0).default(0),
  /* Absent = the create-asset wizard's recorded token plan, then 500 / 0. */
  maxHolders: z.coerce.number().int().positive().optional(),
  lockupDays: z.coerce.number().int().min(0).optional(),
});
export class DeployTokenDto extends createZodDto(DeployTokenSchema) {}

export const StatusSchema = z.object({
  status: z.enum(['open', 'coming_soon', 'funded']),
});
export class StatusDto extends createZodDto(StatusSchema) {}
