import { Module } from '@nestjs/common';
import { AuditController, MiscController } from './misc.controller';
import { AuditQueryService } from './audit-query.service';
import { EstimateService } from './estimate.service';

@Module({
  controllers: [MiscController, AuditController],
  providers: [AuditQueryService, EstimateService],
})
export class MiscModule {}
