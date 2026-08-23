import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/** Roles an issuer may assign. `platform_admin` and `manager` are absent by
 *  design — see ASSIGNABLE_ROLES in team.service.ts. */
const AssignableRole = z.enum(['issuer_admin', 'compliance', 'agent', 'spv_manager']);

export const CreateTeamMemberSchema = z.object({
  email: z.string().trim().email().max(200),
  /** Same floor as a manager login: this account can move money. */
  password: z.string().min(10).max(200),
  name: z.string().trim().max(200).nullish(),
  role: AssignableRole,
});
export class CreateTeamMemberDto extends createZodDto(CreateTeamMemberSchema) {}

export const UpdateTeamMemberSchema = z
  .object({
    role: AssignableRole.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, {
    message: 'Provide "role" and/or "disabled" to update.',
  });
export class UpdateTeamMemberDto extends createZodDto(UpdateTeamMemberSchema) {}
