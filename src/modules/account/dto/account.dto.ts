import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const AccountLoginSchema = z.object({
  email: z.string().trim().min(1).email('Must be a valid email'),
  password: z.string().min(1, 'Password is required'),
});
export class AccountLoginDto extends createZodDto(AccountLoginSchema) {}

export const SubmitKycSchema = z.object({
  /* ISO-3166 numeric, matching offerings.country and investors.country. */
  country: z.coerce.number().int().min(1).max(999).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});
export class SubmitKycDto extends createZodDto(SubmitKycSchema) {}

const address = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 20-byte hex address');

export const NonceSchema = z.object({ address });
export class NonceDto extends createZodDto(NonceSchema) {}

export const SiweVerifySchema = z.object({
  address,
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/, 'Must be a hex signature'),
});
export class SiweVerifyDto extends createZodDto(SiweVerifySchema) {}

export const SignupSchema = z.object({
  email: z.string().trim().min(1).email('Must be a valid email'),
  /* Length only. Composition rules push people toward predictable patterns and
     are no longer recommended (NIST SP 800-63B). */
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  name: z.string().trim().min(1).max(200).optional(),
});
export class SignupDto extends createZodDto(SignupSchema) {}

export const VerifyEmailSchema = z.object({
  email: z.string().trim().min(1).email(),
  code: z.string().trim().regex(/^\d{6}$/, 'Must be a 6-digit code'),
});
export class VerifyEmailDto extends createZodDto(VerifyEmailSchema) {}

export const ResendSchema = z.object({ email: z.string().trim().min(1).email() });
export class ResendDto extends createZodDto(ResendSchema) {}

export const ForgotPasswordSchema = z.object({
  email: z.string().trim().min(1).email(),
});
export class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}

export const ResetPasswordSchema = z.object({
  email: z.string().trim().min(1).email(),
  code: z.string().trim().regex(/^\d{6}$/, 'Must be a 6-digit code'),
  /* Same rule as signup — length only (NIST SP 800-63B). */
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
});
export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
