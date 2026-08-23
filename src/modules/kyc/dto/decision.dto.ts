import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const KycDecisionSchema = z.object({
  /* A rejection without a reason is unusable to the investor and to an auditor,
     so it is required on reject and optional on approve. */
  note: z.string().trim().max(2000).optional(),
});

export class KycDecisionDto extends createZodDto(KycDecisionSchema) {}

export const KycRejectSchema = z.object({
  note: z.string().trim().min(1, 'A rejection reason is required').max(2000),
});

export class KycRejectDto extends createZodDto(KycRejectSchema) {}
