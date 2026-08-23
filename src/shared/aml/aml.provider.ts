/**
 * Wallet AML / sanctions screening — the same seam as the signer, mailer,
 * payment and storage providers.
 *
 * A real integration (Chainalysis KYT, TRM, Elliptic) takes an address and
 * returns a RISK ASSESSMENT of its on-chain history: sanctions-list membership
 * plus exposure to illicit sources (mixers, darknet, ransomware, stolen funds).
 * The provider supplies score + categories; WE map that to a decision, because
 * the risk appetite is ours, not the vendor's.
 *
 * The proper steps, which the mock follows faithfully:
 *   1. Sanctions check   — OFAC SDN / UN / EU membership       (hard block)
 *   2. Risk scoring      — 0..100 from exposure to illicit sources
 *   3. Category exposure — which categories it touched (case file)
 *   4. Decision          — clear / review / blocked
 *   5. Recorded          — every screen is stored append-only and re-runnable
 */
export type AmlDecision = 'clear' | 'review' | 'blocked';
export type AmlRiskLevel = 'low' | 'medium' | 'high' | 'severe';

/** Aggregate across a person's wallets. */
export type AmlStatus = 'unscreened' | AmlDecision;

export interface AmlResult {
  provider: string;
  reference: string;
  riskScore: number;
  riskLevel: AmlRiskLevel;
  sanctioned: boolean;
  categories: string[];
  decision: AmlDecision;
  raw: Record<string, unknown>;
}

export interface AmlProvider {
  readonly name: string;
  /** A hit is a RESULT, never an exception — screening "worked" either way. */
  screenAddress(address: string): Promise<AmlResult>;
}

export const AML_PROVIDER = Symbol('AML_PROVIDER');

/* Score bands. A sanctions match forces `blocked` regardless of score. */
export const REVIEW_AT = 40;
export const BLOCK_AT = 70;

export function levelFor(score: number): AmlRiskLevel {
  if (score >= 90) return 'severe';
  if (score >= BLOCK_AT) return 'high';
  if (score >= REVIEW_AT) return 'medium';
  return 'low';
}

export function decisionFor(score: number, sanctioned: boolean): AmlDecision {
  if (sanctioned || score >= BLOCK_AT) return 'blocked';
  if (score >= REVIEW_AT) return 'review';
  return 'clear';
}

const SEVERITY: Record<AmlStatus, number> = {
  unscreened: 0,
  clear: 1,
  review: 2,
  blocked: 3,
};

/**
 * The WORSE of two decisions.
 *
 * Aggregation must be pessimistic: a person with one clean wallet and one
 * sanctioned wallet is blocked, not clear. Taking the best — or the latest —
 * would let anyone launder a bad address behind a fresh one.
 */
export function worse(a: AmlStatus, b: AmlStatus): AmlStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}
