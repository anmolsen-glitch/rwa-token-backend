import { Module } from '@nestjs/common';
import { KycModule } from '@modules/kyc/kyc.module';
import { SubscriptionsModule } from '@modules/subscriptions/subscriptions.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [KycModule, SubscriptionsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhooksRepository],
  exports: [WebhooksService],
})
export class WebhooksModule {}
