import { Module } from '@nestjs/common';
import { ManagersModule } from '@modules/managers/managers.module';
import { OfferingsModule } from '@modules/offerings/offerings.module';
import { OnboardingModule } from '@modules/onboarding/onboarding.module';
import { TokensModule } from '@modules/tokens/tokens.module';
import { DistributionsController, InvestorClaimsController } from './distributions.controller';
import { DistributionsRepository } from './distributions.repository';
import { DistributionsService } from './distributions.service';

@Module({
  imports: [TokensModule, OfferingsModule, ManagersModule, OnboardingModule],
  controllers: [DistributionsController, InvestorClaimsController],
  providers: [DistributionsService, DistributionsRepository],
  exports: [DistributionsService],
})
export class DistributionsModule {}
