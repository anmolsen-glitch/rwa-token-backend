import { Module } from '@nestjs/common';
import { AccountDocumentsController, ReviewDocumentsController } from './documents.controller';
import { DocumentsRepository } from './documents.repository';
import { DocumentsService } from './documents.service';

@Module({
  controllers: [AccountDocumentsController, ReviewDocumentsController],
  providers: [DocumentsService, DocumentsRepository],
  exports: [DocumentsService],
})
export class DocumentsModule {}
