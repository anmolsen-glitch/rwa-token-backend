import { Module } from '@nestjs/common';
import { ComplianceModule } from '@modules/compliance/compliance.module';
import { OfferingsModule } from '@modules/offerings/offerings.module';
import { OnboardingModule } from '@modules/onboarding/onboarding.module';
import { TokensModule } from '@modules/tokens/tokens.module';
import { WalletModule } from '@modules/wallet/wallet.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';

@Module({
  imports: [TokensModule, OfferingsModule, OnboardingModule, ComplianceModule, WalletModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
