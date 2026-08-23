import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const address = z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 20-byte hex address');
/* Decimal string, never a JS number: token amounts are parsed with
   parseUnits against the token's own decimals, and a float would round. */
const amount = z.string().trim().regex(/^\d+(\.\d+)?$/, 'Must be a decimal amount');

export const MintSchema = z.object({ investor: address, amount });
export class MintDto extends createZodDto(MintSchema) {}

export const BurnSchema = z.object({ wallet: address, amount });
export class BurnDto extends createZodDto(BurnSchema) {}

export const FreezeSchema = z.object({ wallet: address, frozen: z.boolean() });
export class FreezeDto extends createZodDto(FreezeSchema) {}

export const FreezePartialSchema = z.object({ wallet: address, amount, freeze: z.boolean() });
export class FreezePartialDto extends createZodDto(FreezePartialSchema) {}

export const ForceTransferSchema = z.object({
  from: address,
  to: address,
  amount,
  /* Ties the action to a legal case. Not required by the schema, but an
     unexplained forced transfer is the one an auditor will ask about. */
  caseId: z.string().trim().optional(),
});
export class ForceTransferDto extends createZodDto(ForceTransferSchema) {}

export const PauseSchema = z.object({ paused: z.boolean() });
export class PauseDto extends createZodDto(PauseSchema) {}
