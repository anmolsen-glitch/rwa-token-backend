import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const DeclareDistributionSchema = z.object({
  /** Rupees, as a decimal string — parsed to integer paise, never a float. */
  amount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Must be a decimal amount'),
  note: z.string().trim().max(2000).nullish(),
});
export class DeclareDistributionDto extends createZodDto(DeclareDistributionSchema) {}
