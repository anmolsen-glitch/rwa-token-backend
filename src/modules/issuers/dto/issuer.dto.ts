import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const wallet = z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 20-byte hex address');

export const CreateIssuerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  legalEntity: z.string().trim().max(300).optional(),
  contactEmail: z.string().trim().email().optional(),
  /* The token OWNER wallet — a multisig in production. */
  ownerWallet: wallet.optional(),
  /* kybStatus is deliberately absent: it moves only through the KYB endpoints,
     so an issuer cannot approve itself by sending a field. */
});
export class CreateIssuerDto extends createZodDto(CreateIssuerSchema) {}

export const UpdateIssuerSchema = CreateIssuerSchema.partial();
export class UpdateIssuerDto extends createZodDto(UpdateIssuerSchema) {}

export const KybDecisionSchema = z.object({ note: z.string().trim().max(2000).optional() });
export class KybDecisionDto extends createZodDto(KybDecisionSchema) {}

export const KybRejectSchema = z.object({
  note: z.string().trim().min(1, 'A reason is required').max(2000),
});
export class KybRejectDto extends createZodDto(KybRejectSchema) {}

/** Public application — contact email is required so there is someone to reply to. */
export const ApplySchema = z.object({
  name: z.string().trim().min(1).max(200),
  legalEntity: z.string().trim().max(300).optional(),
  contactEmail: z.string().trim().email(),
});
export class ApplyDto extends createZodDto(ApplySchema) {}
