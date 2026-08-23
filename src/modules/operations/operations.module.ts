import { Module, forwardRef } from '@nestjs/common';
import { TokensModule } from '@modules/tokens/tokens.module';
import { OperationsController } from './operations.controller';
import { OperationsRepository } from './operations.repository';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [forwardRef(() => TokensModule)],
  controllers: [OperationsController],
  providers: [ApprovalsService, OperationsRepository],
  exports: [ApprovalsService, OperationsRepository],
})
export class OperationsModule {}
