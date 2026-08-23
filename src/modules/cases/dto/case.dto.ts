import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const wallet = z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a wallet address');

export const OpenCaseSchema = z.object({
  reference: z.string().trim().min(1).max(120),
  type: z
    .enum(['court_order', 'sanctions', 'fraud', 'recovery', 'dispute', 'other'])
    .default('court_order'),
  subjectWallet: wallet.nullish(),
  description: z.string().trim().max(10000).nullish(),
  documentUrl: z.string().trim().url().max(500).nullish(),
});
export class OpenCaseDto extends createZodDto(OpenCaseSchema) {}

export const RecoverSchema = z.object({
  oldWallet: wallet,
  newWallet: wallet,
  tokenSymbol: z.string().trim().min(1).max(12),
});
export class RecoverDto extends createZodDto(RecoverSchema) {}
