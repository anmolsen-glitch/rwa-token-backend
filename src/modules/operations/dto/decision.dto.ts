import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const ApprovalNoteSchema = z.object({ note: z.string().trim().max(2000).optional() });
export class ApprovalNoteDto extends createZodDto(ApprovalNoteSchema) {}

/** A rejection without a reason is useless to the requester and to an auditor. */
export const RejectSchema = z.object({ note: z.string().trim().min(1, 'A reason is required').max(2000) });
export class RejectDto extends createZodDto(RejectSchema) {}
