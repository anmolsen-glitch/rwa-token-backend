import { Module } from '@nestjs/common';
import { OnboardingModule } from '@modules/onboarding/onboarding.module';
import { OperationsModule } from '@modules/operations/operations.module';
import { TokensModule } from '@modules/tokens/tokens.module';
import { CasesController } from './cases.controller';
import { CasesRepository } from './cases.repository';
import { CasesService } from './cases.service';

@Module({
  imports: [TokensModule, OperationsModule, OnboardingModule],
  controllers: [CasesController],
  providers: [CasesService, CasesRepository],
  exports: [CasesService],
})
export class CasesModule {}
