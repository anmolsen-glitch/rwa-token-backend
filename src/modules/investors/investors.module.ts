import { Module } from '@nestjs/common';
import { DistributionsModule } from '@modules/distributions/distributions.module';
import { OfferingsModule } from '@modules/offerings/offerings.module';
import { OnboardingModule } from '@modules/onboarding/onboarding.module';
import { PortfolioModule } from '@modules/portfolio/portfolio.module';
import { TokensModule } from '@modules/tokens/tokens.module';
import { InvestorsController } from './investors.controller';
import { InvestorsRepository } from './investors.repository';
import { InvestorsService } from './investors.service';

@Module({
  imports: [TokensModule, OfferingsModule, OnboardingModule, PortfolioModule, DistributionsModule],
  controllers: [InvestorsController],
  providers: [InvestorsService, InvestorsRepository],
  exports: [InvestorsService],
})
export class InvestorsModule {}
