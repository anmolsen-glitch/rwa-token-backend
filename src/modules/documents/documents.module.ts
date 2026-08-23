import { Module } from '@nestjs/common';
import { KycModule } from '@modules/kyc/kyc.module';
import { AccountDocumentsController, ReviewDocumentsController } from './documents.controller';
import { DocumentsRepository } from './documents.repository';
import { DocumentsService } from './documents.service';

@Module({
  imports: [KycModule],
  controllers: [AccountDocumentsController, ReviewDocumentsController],
  providers: [DocumentsService, DocumentsRepository],
  exports: [DocumentsService],
})
export class DocumentsModule {}
