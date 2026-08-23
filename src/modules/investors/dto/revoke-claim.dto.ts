import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const RevokeClaimSchema = z.object({
  /** The legal case authorising this. Optional, but strongly encouraged. */
  caseId: z.string().trim().regex(/^\d+$/).nullish(),
});
export class RevokeClaimDto extends createZodDto(RevokeClaimSchema) {}
