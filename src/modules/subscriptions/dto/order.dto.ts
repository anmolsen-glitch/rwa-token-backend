import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const CreateOrderSchema = z.object({
  offeringId: z.string().trim().min(1),
  /* Rupees. Coerced from string or number, then floored to whole tokens by the
     service — the authoritative money comparison happens in integer paise. */
  amount: z.coerce.number().positive(),
});
export class CreateOrderDto extends createZodDto(CreateOrderSchema) {}

export const PayCryptoSchema = z.object({
  /** The transfer you already made from your own wallet. Verified on-chain. */
  txHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a transaction hash'),
});
export class PayCryptoDto extends createZodDto(PayCryptoSchema) {}
