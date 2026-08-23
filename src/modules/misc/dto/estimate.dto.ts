import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const EstimateSchema = z.object({
  address: z.string().trim().max(500).nullish(),
  propertyType: z.enum([
    'single_family',
    'multi_family',
    'vacation_rental',
    'commercial',
    'owner_occupied',
  ]),
  sqft: z.coerce.number().positive().max(10_000_000),
  beds: z.coerce.number().int().min(0).max(100).nullish(),
  baths: z.coerce.number().min(0).max(100).nullish(),
  yearBuilt: z.coerce.number().int().min(1800).max(2100).nullish(),
  condition: z.enum(['excellent', 'good', 'fair', 'poor']).nullish(),
});
export class EstimateDto extends createZodDto(EstimateSchema) {}
