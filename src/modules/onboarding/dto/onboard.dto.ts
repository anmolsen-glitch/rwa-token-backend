import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const wallet = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 20-byte hex address');

const tokenSymbol = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,12}$/, 'Must be an alphanumeric token symbol');

export const OnboardRequestSchema = z.object({ wallet, tokenSymbol });
export class OnboardRequestDto extends createZodDto(OnboardRequestSchema) {}

/**
 * The investor's own onboarding request — token symbol ONLY.
 *
 * Deliberately has no `wallet`: it comes from the verified token. Accepting one
 * and ignoring it would invite the belief that it does something.
 */
export const InvestorOnboardSchema = z.object({ tokenSymbol });
export class InvestorOnboardDto extends createZodDto(InvestorOnboardSchema) {}
