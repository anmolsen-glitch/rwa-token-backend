import { Module } from '@nestjs/common';
import { TokensModule } from '@modules/tokens/tokens.module';
import { InvestorsController } from './investors.controller';
import { InvestorsRepository } from './investors.repository';
import { InvestorsService } from './investors.service';

@Module({
  imports: [TokensModule],
  controllers: [InvestorsController],
  providers: [InvestorsService, InvestorsRepository],
  exports: [InvestorsService],
})
export class InvestorsModule {}
