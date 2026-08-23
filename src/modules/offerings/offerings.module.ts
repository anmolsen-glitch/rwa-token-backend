import { forwardRef, Module } from '@nestjs/common';
import { IssuersModule } from '@modules/issuers/issuers.module';
import { ManagersModule } from '@modules/managers/managers.module';
import { SubscriptionsModule } from '@modules/subscriptions/subscriptions.module';
import { OnboardingModule } from '@modules/onboarding/onboarding.module';
import { TokensModule } from '@modules/tokens/tokens.module';
import { DeployService } from './deploy.service';
import { OfferingFeaturesController, ProposalsController } from './offering-features.controller';
import { InvestorFeaturesController, PublicOfferingFeaturesController } from './offering-features-public.controller';
import { OfferingFeaturesRepository } from './offering-features.repository';
import { OfferingFeaturesService } from './offering-features.service';
import { IssuerAssetsController, OfferingsController, PublicOfferingsController } from './offerings.controller';
import { OfferingViewService } from './offering-view.service';
import { OfferingsRepository } from './offerings.repository';
import { OfferingsService } from './offerings.service';

@Module({
  imports: [forwardRef(() => IssuersModule), TokensModule, OnboardingModule, ManagersModule, forwardRef(() => SubscriptionsModule)],
  controllers: [OfferingsController, IssuerAssetsController, PublicOfferingsController, OfferingFeaturesController, ProposalsController, PublicOfferingFeaturesController, InvestorFeaturesController],
  providers: [OfferingsService, OfferingsRepository, DeployService, OfferingViewService, OfferingFeaturesService, OfferingFeaturesRepository],
  exports: [OfferingsService, OfferingsRepository, OfferingViewService],
})
export class OfferingsModule {}
