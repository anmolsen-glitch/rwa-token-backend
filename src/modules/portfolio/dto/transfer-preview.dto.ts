import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/* Whole tokens only — every asset is 0-decimal by rule, and supply accounting
   works in whole units. The recipient's checksum is verified in the service so
   the failure reads as "bad address", not a generic validation error. */
export const TransferPreviewSchema = z.object({
  tokenSymbol: z.string().min(1),
  to: z.string().min(1),
  amount: z.number().int().positive(),
});

export class TransferPreviewDto extends createZodDto(TransferPreviewSchema) {}
