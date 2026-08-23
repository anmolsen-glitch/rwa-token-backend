import { Module } from '@nestjs/common';
import { ManagersController, PublicManagersController } from './managers.controller';
import { ManagersRepository } from './managers.repository';
import { ManagersService } from './managers.service';

@Module({
  controllers: [ManagersController, PublicManagersController],
  providers: [ManagersService, ManagersRepository],
  exports: [ManagersService, ManagersRepository],
})
export class ManagersModule {}
