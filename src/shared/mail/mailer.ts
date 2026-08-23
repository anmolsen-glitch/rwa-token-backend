/**
 * Email seam — same shape as the payment / KYC / AML seams.
 *
 * Callers ask for a Mailer and call send(); they never learn whether it goes to
 * a log, SES, or SendGrid. Swapping providers is config, not code.
 *
 *   MAIL_PROVIDER=mock   -> log only (DEV)
 *   MAIL_PROVIDER=ses|…  -> implement before production
 *
 * Ported from ../rwa-token-backend/src/lib/mailer.ts.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly name: string;
  send(mail: Mail): Promise<void>;
}

/** Injection token — see mail.module.ts. */
export const MAILER = Symbol('MAILER');
