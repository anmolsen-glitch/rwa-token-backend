import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const LoginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Must be a valid email'),
  /* No max/complexity rules here: this validates a LOGIN attempt, not a new
     password. Rejecting a malformed existing password would leak policy. */
  password: z.string().min(1, 'Password is required'),
});

export class LoginDto extends createZodDto(LoginSchema) {}
