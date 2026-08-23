import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const LinkWalletSchema = z.object({
  address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a wallet address'),
  /** Signature over the nonce message — proves control of `address`. */
  signature: z.string().trim().min(1),
});
export class LinkWalletDto extends createZodDto(LinkWalletSchema) {}
