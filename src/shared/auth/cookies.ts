/**
 * Session cookie names and CSRF constants. Values match the Express app exactly
 * (src/lib/cookies.ts) — both services read the same browser cookies during the
 * migration.
 *
 * Why httpOnly + double-submit CSRF: JS cannot read an httpOnly cookie, so XSS
 * cannot exfiltrate the session. But cookies ride along automatically, which
 * reopens CSRF — so mutating requests must echo the JS-readable `rwa_csrf`
 * cookie in the `x-csrf-token` header. A cross-site form can send the session
 * cookie but cannot read the CSRF cookie to forge the header.
 */
export const ADMIN_COOKIE = 'rwa_admin_token';
export const INVESTOR_COOKIE = 'rwa_investor_token';
export const ACCOUNT_COOKIE = 'rwa_account_token';
export const CSRF_COOKIE = 'rwa_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const SESSION_COOKIES = [ADMIN_COOKIE, INVESTOR_COOKIE, ACCOUNT_COOKIE] as const;

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Parse a JWT-style duration ("12h", "7d", "30m", "45s", bare seconds) to ms. */
export function durationMs(s: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(s.trim());
  if (!m) return 12 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const mult = { d: 86400, h: 3600, m: 60, s: 1 }[m[2] ?? 's'] ?? 1;
  return n * mult * 1000;
}
