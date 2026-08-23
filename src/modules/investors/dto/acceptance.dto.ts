import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const AcceptanceDecisionSchema = z.object({
  status: z.enum(['accepted', 'rejected', 'pending_review']),
  note: z.string().trim().max(1000).optional(),
});

export class AcceptanceDecisionDto extends createZodDto(AcceptanceDecisionSchema) {}
