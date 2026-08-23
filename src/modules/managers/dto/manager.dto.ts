import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const profile = {
  company: z.string().trim().max(200).nullish(),
  bio: z.string().trim().max(5000).nullish(),
  logoUrl: z.string().trim().url().max(500).nullish(),
  contactEmail: z.string().trim().email().max(200).nullish(),
};

export const CreateManagerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    ...profile,
    /** Optional portal login. Both fields or neither. */
    loginEmail: z.string().trim().email().max(200).nullish(),
    loginPassword: z.string().min(10).max(200).nullish(),
  })
  .refine((v) => !v.loginEmail || !!v.loginPassword, {
    message: 'A login email needs a password.',
    path: ['loginPassword'],
  });
export class CreateManagerDto extends createZodDto(CreateManagerSchema) {}

export const UpdateManagerSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    ...profile,
    /* Suspending also revokes the portal login — see ManagersService.update. */
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });
export class UpdateManagerDto extends createZodDto(UpdateManagerSchema) {}
