import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const profile = {
  company: z.string().trim().max(200).nullish(),
  contactEmail: z.string().trim().email().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
};

export const CreateSpvManagerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  ...profile,
});
export class CreateSpvManagerDto extends createZodDto(CreateSpvManagerSchema) {}

export const UpdateSpvManagerSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    ...profile,
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });
export class UpdateSpvManagerDto extends createZodDto(UpdateSpvManagerSchema) {}

/** Creating a property manager UNDER an SPV manager. Same shape as the direct
 *  create, minus the issuer — that comes from the SPV manager's own row. */
export const CreateReportSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    company: z.string().trim().max(200).nullish(),
    bio: z.string().trim().max(5000).nullish(),
    contactEmail: z.string().trim().email().max(200).nullish(),
    loginEmail: z.string().trim().email().max(200).nullish(),
    loginPassword: z.string().min(10).max(200).nullish(),
  })
  .refine((v) => !v.loginEmail || !!v.loginPassword, {
    message: 'A login email needs a password.',
    path: ['loginPassword'],
  });
export class CreateReportDto extends createZodDto(CreateReportSchema) {}
