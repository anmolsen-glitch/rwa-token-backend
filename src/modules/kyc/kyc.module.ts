import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycRepository } from './kyc.repository';
import { KycService } from './kyc.service';

@Module({
  controllers: [KycController],
  providers: [KycService, KycRepository],
  exports: [KycService, KycRepository],
})
export class KycModule {}
