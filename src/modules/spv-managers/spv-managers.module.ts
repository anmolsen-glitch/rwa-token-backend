import { Module } from '@nestjs/common';
import { IssuersModule } from '@modules/issuers/issuers.module';
import { ManagersModule } from '@modules/managers/managers.module';
import { IssuerSpvManagersController, SpvManagersController } from './spv-managers.controller';
import { SpvManagersRepository } from './spv-managers.repository';
import { SpvManagersService } from './spv-managers.service';

@Module({
  imports: [IssuersModule, ManagersModule],
  controllers: [IssuerSpvManagersController, SpvManagersController],
  providers: [SpvManagersService, SpvManagersRepository],
  exports: [SpvManagersService],
})
export class SpvManagersModule {}
