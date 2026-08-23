import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const AccreditationDecisionSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
export class AccreditationDecisionDto extends createZodDto(AccreditationDecisionSchema) {}

/** A revocation without a reason is useless to the investor and to an auditor. */
export const AccreditationRejectSchema = z.object({
  note: z.string().trim().min(1, 'A reason is required').max(2000),
});
export class AccreditationRejectDto extends createZodDto(AccreditationRejectSchema) {}
