import { Module } from '@nestjs/common';
import { AccreditationController, AmlController } from './compliance.controller';
import { AccreditationService } from './accreditation.service';
import { AmlService } from './aml.service';
import { ComplianceRepository } from './compliance.repository';

@Module({
  controllers: [AmlController, AccreditationController],
  providers: [AmlService, AccreditationService, ComplianceRepository],
  exports: [AmlService, AccreditationService],
})
export class ComplianceModule {}
