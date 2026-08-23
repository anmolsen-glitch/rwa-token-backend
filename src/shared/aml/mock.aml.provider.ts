/**
 * Mock AML provider — ported from ../rwa-token-backend/src/lib/aml.ts.
 *
 * DETERMINISTIC on purpose: a given address always screens the same way, which
 * is also how real screening of the same on-chain history behaves. Demo
 * watchlists let you demonstrate a sanctions block and a manual-review case
 * deliberately; every other address gets a realistic LOW score derived from a
 * hash, so legitimate wallets clear — exactly as a clean wallet does in
 * production.
 */
import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import {
  decisionFor,
  levelFor,
  REVIEW_AT,
  type AmlProvider,
  type AmlResult,
} from './aml.provider';

@Injectable()
export class MockAmlProvider implements AmlProvider {
  readonly name = 'mock';

  constructor(
    private readonly sanctioned: Set<string>,
    private readonly review: Set<string>,
  ) {}

  async screenAddress(addressRaw: string): Promise<AmlResult> {
    const address = addressRaw.toLowerCase();

    /* 1. Sanctions check — exact match against the demo SDN list. */
    const isSanctioned = this.sanctioned.has(address);

    let score: number;
    let categories: string[];

    if (isSanctioned) {
      /* 2/3. Listed address: maximum risk, sanctions categories. */
      score = 98;
      categories = ['sanctions', 'ofac_sdn'];
    } else if (this.review.has(address)) {
      score = 55;
      categories = ['high_risk_exchange', 'unhosted_high_activity'];
    } else {
      /* 2. Stable low score (0..39) from the address hash, so a clean wallet
         always clears rather than randomly landing in review. */
      const digest = ethers.keccak256(ethers.getBytes(ethers.zeroPadValue(address, 32)));
      score = parseInt(digest.slice(2, 4), 16) % REVIEW_AT;
      categories = [];
    }

    const decision = decisionFor(score, isSanctioned);
    return {
      provider: this.name,
      reference: `mock_aml_${address.slice(2, 10)}_${score}`,
      riskScore: score,
      riskLevel: levelFor(score),
      sanctioned: isSanctioned,
      categories,
      decision,
      raw: { provider: this.name, address, sanctioned: isSanctioned, riskScore: score, categories },
    };
  }
}
