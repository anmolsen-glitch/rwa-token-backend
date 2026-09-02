import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/* The wizard sends money as JS numbers; the backend keeps money as STRINGS
   (NUMERIC in Postgres, integer paise in the money helpers). Convert at the
   boundary and validate the decimal shape — never carry a float further in. */
const money = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Must be a decimal amount'));

export const PROPERTY_TYPES = [
  'single_family',
  'multi_family',
  'vacation_rental',
  'commercial',
  'owner_occupied',
] as const;

/**
 * The asset-creation wizard's full payload: listing + property detail + the
 * token PLAN. Creating an asset never touches the chain — the deploy is a
 * separate, explicitly retryable step (POST /api/admin/offerings/:id/deploy-token).
 */
export const CreateAssetSchema = z.object({
  // token plan — all optional: an asset can be created without a token plan.
  // Token config is set later from the Offerings detail page before deploying.
  symbol: z.string().trim().regex(/^[A-Z0-9]{2,12}$/, 'Uppercase alphanumeric, 2-12 chars').nullish(),
  tokenName: z.string().trim().max(200).nullish(),
  /* Shown by the wizard, never stored — cross-checked against targetRaise /
     pricePerToken in the service so UI and enforcement cannot disagree. */
  totalTokens: z.number().int().positive().nullish(),
  /* Whole-unit security tokens only — supply accounting assumes 0 decimals. */
  decimals: z.literal(0).optional(),
  maxHolders: z.number().int().positive().nullish(),
  lockupDays: z.number().int().min(0).nullish(),
  requiresAccreditation: z.boolean().optional(),

  // listing
  name: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).nullish(),
  assetType: z.string().trim().max(80).nullish(),
  image: z.string().trim().max(500).nullish(),
  images: z.array(z.string().trim().max(500)).max(30).optional(),
  description: z.string().trim().max(5000).nullish(),
  documents: z
    .array(
      z.object({
        type: z.string().trim().min(1).max(80),
        name: z.string().trim().max(200).nullish(),
        url: z.string().trim().max(500).nullish(),
      }),
    )
    .max(30)
    .optional(),
  currency: z.string().trim().length(3).default('INR'),
  pricePerToken: money.nullish(),
  minInvestment: money,
  maxInvestment: money.nullish(),
  accreditedMaxInvestment: money.nullish(),
  targetRaise: money,
  minimumRaise: money.nullish(),
  yieldPct: money.nullish(),
  country: z.coerce.number().int().min(1).max(999),
  status: z.enum(['open', 'coming_soon']).nullish(),
  visibility: z.enum(['public', 'private']).nullish(),

  // property detail
  propertyType: z.enum(PROPERTY_TYPES).nullish(),
  propertyValue: money.nullish(),
  occupancyPct: money.nullish(),
  ownerOccupied: z.boolean().optional(),
  sellerWallet: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a wallet address')
    .nullish(),
  retainedPct: money.nullish(),

  /* The Express one-shot deploy flag. Deliberately refused here — see service. */
  deployNow: z.boolean().optional(),
});

export class CreateAssetDto extends createZodDto(CreateAssetSchema) {}
