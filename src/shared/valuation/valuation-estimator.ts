/**
 * PORTED from ../rwa-token-backend/src/lib/valuation-estimator.ts.
 *
 * The provider seam is unchanged — mock is a deterministic, explainable model
 * so the flow demos with no vendor and no randomness; a real integration is an
 * AVM (HouseCanary / ATTOM). Only the config import differs: the provider name
 * is passed in rather than read from a module-level env import, so the class
 * stays pure and testable.
 */
/**
 * Valuation estimator — the same provider seam as the signer, payments, KYC, and
 * AML. A seller on "list your property" enters a few property attributes and gets
 * an instant estimated value + rent + suggested tokenization terms, BEFORE any
 * formal appraisal. (Lofty shows calculators up front, then does a real appraisal.)
 *
 * A real integration is an Automated Valuation Model (HouseCanary / Zillow Zestimate
 * / ATTOM): address + attributes -> estimated value + rent + a confidence band. The
 * mock reproduces the shape with a deterministic, explainable model so the flow is
 * demoable with no vendor and no randomness.
 *
 *   ESTIMATOR_PROVIDER=mock                 -> deterministic ₹/sqft × condition model
 *   ESTIMATOR_PROVIDER=housecanary|attom    -> implement a class before use
 */
import { createHash } from "crypto";


export type PropertyType =
  | "single_family"
  | "multi_family"
  | "vacation_rental"
  | "commercial"
  | "owner_occupied";

export type Condition = "excellent" | "good" | "fair" | "poor";

export interface EstimateInput {
  address?: string | null;
  propertyType: PropertyType;
  sqft: number;
  beds?: number | null;
  baths?: number | null;
  yearBuilt?: number | null;
  condition?: Condition | null;
}

export interface EstimateResult {
  estimatedValue: number; // INR, total property value
  estimatedMonthlyRent: number; // INR / month
  projectedGrossYieldPct: number; // annual gross yield %
  suggestedTokenPrice: number; // INR per token
  suggestedTokenCount: number; // value / token price
  confidence: "high" | "medium" | "low";
  provider: string;
  ref: string;
}

export interface EstimatorProvider {
  readonly name: string;
  estimate(input: EstimateInput): EstimateResult;
}

// ₹ per sqft by property type (demo base rates).
const PRICE_PER_SQFT: Record<PropertyType, number> = {
  commercial: 12000,
  vacation_rental: 9000,
  owner_occupied: 8500,
  single_family: 8000,
  multi_family: 7000,
};

// Annual gross yield (cap rate) by type — used to imply rent from value.
const CAP_RATE: Record<PropertyType, number> = {
  vacation_rental: 0.1,
  commercial: 0.09,
  multi_family: 0.07,
  single_family: 0.055,
  owner_occupied: 0.05,
};

const CONDITION_MULT: Record<Condition, number> = { excellent: 1.15, good: 1.0, fair: 0.85, poor: 0.7 };
const REFERENCE_YEAR = 2026; // fixed so the model stays deterministic
const SUGGESTED_TOKEN_PRICE = 1000; // ₹, round retail-friendly denomination

const round = (n: number) => Math.round(n);

class MockEstimatorProvider implements EstimatorProvider {
  readonly name = "mock-estimator";

  estimate(input: EstimateInput): EstimateResult {
    const type = input.propertyType;
    const pricePerSqft = PRICE_PER_SQFT[type];
    const capRate = CAP_RATE[type];
    const condition: Condition = input.condition ?? "good";
    const conditionMult = CONDITION_MULT[condition];

    // Newer buildings carry a mild premium; older ones a mild discount (clamped).
    let ageFactor = 1;
    if (input.yearBuilt && input.yearBuilt > 1900 && input.yearBuilt <= REFERENCE_YEAR) {
      ageFactor = Math.min(1.1, Math.max(0.7, 1 - (REFERENCE_YEAR - input.yearBuilt) * 0.003));
    }

    const estimatedValue = round(input.sqft * pricePerSqft * conditionMult * ageFactor);
    const annualRent = estimatedValue * capRate;
    const estimatedMonthlyRent = round(annualRent / 12);
    const projectedGrossYieldPct = Math.round(capRate * 1000) / 10;
    const suggestedTokenCount = round(estimatedValue / SUGGESTED_TOKEN_PRICE);

    // Confidence reflects how much we were told: sqft is the driver; condition and
    // yearBuilt tighten the estimate.
    const provided = [input.condition, input.yearBuilt, input.beds, input.baths].filter((v) => v != null).length;
    const confidence: EstimateResult["confidence"] = provided >= 3 ? "high" : provided >= 1 ? "medium" : "low";

    const ref =
      "est_" +
      createHash("sha256")
        .update(JSON.stringify({ ...input, provider: this.name }))
        .digest("hex")
        .slice(0, 16);

    return {
      estimatedValue,
      estimatedMonthlyRent,
      projectedGrossYieldPct,
      suggestedTokenPrice: SUGGESTED_TOKEN_PRICE,
      suggestedTokenCount,
      confidence,
      provider: this.name,
      ref,
    };
  }
}

export function getEstimatorProvider(provider: string): EstimatorProvider {
  switch (provider) {
    case 'mock':
      return new MockEstimatorProvider();
    default:
      throw new Error(
        `ESTIMATOR_PROVIDER=${provider} is not implemented. Add a provider class in shared/valuation/valuation-estimator.ts.`,
      );
  }
}

const PROPERTY_TYPES: PropertyType[] = ["single_family", "multi_family", "vacation_rental", "commercial", "owner_occupied"];
const CONDITIONS: Condition[] = ["excellent", "good", "fair", "poor"];

/** Validate + normalize a raw request body into EstimateInput (throws on bad input). */
export function parseEstimateInput(b: Record<string, unknown>): EstimateInput {
  const propertyType = String(b.propertyType ?? "") as PropertyType;
  if (!PROPERTY_TYPES.includes(propertyType)) {
    throw new Error(`"propertyType" must be one of ${PROPERTY_TYPES.join(", ")}`);
  }
  const sqft = Number(b.sqft);
  if (!Number.isFinite(sqft) || sqft <= 0 || sqft > 10_000_000) {
    throw new Error('"sqft" must be a positive number');
  }
  const condition = b.condition == null ? null : (String(b.condition) as Condition);
  if (condition != null && !CONDITIONS.includes(condition)) {
    throw new Error(`"condition" must be one of ${CONDITIONS.join(", ")}`);
  }
  const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
  return {
    address: typeof b.address === "string" ? b.address : null,
    propertyType,
    sqft,
    beds: num(b.beds),
    baths: num(b.baths),
    yearBuilt: num(b.yearBuilt),
    condition,
  };
}
