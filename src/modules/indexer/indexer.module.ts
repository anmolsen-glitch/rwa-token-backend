import { Module } from '@nestjs/common';
import { IndexerRepository } from './indexer.repository';
import { IndexerService } from './indexer.service';
import { IndexerTokensRepository } from './indexer-tokens.repository';

@Module({
  providers: [IndexerService, IndexerRepository, IndexerTokensRepository],
  exports: [IndexerService],
})
export class IndexerModule {}
