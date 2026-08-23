import { Module, forwardRef } from '@nestjs/common';
import { OperationsModule } from '@modules/operations/operations.module';
import { TokensController } from './tokens.controller';
import { TokensRepository } from './tokens.repository';
import { TokensService } from './tokens.service';
import { TokenOperationsService } from './token-operations.service';

/**
 * forwardRef because tokens and operations are mutually dependent by design:
 * a token write is submitted to the approval queue, and the queue executes
 * token writes. Splitting them further would only move the cycle.
 */
@Module({
  imports: [forwardRef(() => OperationsModule)],
  controllers: [TokensController],
  providers: [TokensService, TokensRepository, TokenOperationsService],
  exports: [TokensService, TokensRepository, TokenOperationsService],
})
export class TokensModule {}
