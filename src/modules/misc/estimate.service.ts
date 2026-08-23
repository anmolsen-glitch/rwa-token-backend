/**
 * Valuation estimator, behind the same provider seam as the signer, payments,
 * KYC and AML.
 *
 * The provider is resolved once at construction from config, so an unknown
 * ESTIMATOR_PROVIDER fails at BOOT rather than on a prospective seller's first
 * request.
 */
import { Injectable } from '@nestjs/common';
import { AppConfig } from '@shared/config/app-config.service';
import {
  getEstimatorProvider,
  type EstimateInput,
  type EstimateResult,
  type EstimatorProvider,
} from '@shared/valuation/valuation-estimator';

@Injectable()
export class EstimateService {
  private readonly provider: EstimatorProvider;

  constructor(config: AppConfig) {
    this.provider = getEstimatorProvider(config.get('ESTIMATOR_PROVIDER'));
  }

  estimate(input: EstimateInput): EstimateResult {
    return this.provider.estimate(input);
  }
}
