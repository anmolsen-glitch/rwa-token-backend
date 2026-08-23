import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const money = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Must be a decimal amount');
const wallet = z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 20-byte hex address');

export const ValuationSchema = z.object({
  totalValue: money,
  note: z.string().trim().max(2000).optional(),
  source: z.enum(['launch', 'appraisal', 'avm', 'manual']).optional(),
});
export class ValuationDto extends createZodDto(ValuationSchema) {}

export const UpdatePostSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
});
export class UpdatePostDto extends createZodDto(UpdatePostSchema) {}

export const BuybackSchema = z.object({
  sellerWallet: wallet,
  pricePerToken: money,
  /** Token budget. Omit for unlimited. */
  maxTokens: z.coerce.number().int().positive().optional(),
});
export class BuybackDto extends createZodDto(BuybackSchema) {}

export const ProposeManagerSchema = z.object({
  proposedManagerId: z.string().trim().regex(/^\d+$/, 'Manager id'),
  reason: z.string().trim().max(2000).optional(),
  /* Bounded: a 1-day window is not a vote, and a year-long one never resolves. */
  closesInDays: z.coerce.number().int().min(3).max(90).default(14),
});
export class ProposeManagerDto extends createZodDto(ProposeManagerSchema) {}

export const AssignManagerSchema = z.object({
  managerId: z.string().trim().regex(/^\d+$/).nullable(),
});
export class AssignManagerDto extends createZodDto(AssignManagerSchema) {}

export const VoteSchema = z.object({
  choice: z.enum(['for', 'against']),
});
export class VoteDto extends createZodDto(VoteSchema) {}

export const SellBackSchema = z.object({
  tokenSymbol: z.string().trim().min(1).max(12),
  tokens: z.coerce.number().int().positive(),
  /** The transfer the investor already made from their OWN wallet. Verified. */
  txHash: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a transaction hash'),
});
export class SellBackDto extends createZodDto(SellBackSchema) {}
