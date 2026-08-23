import { forwardRef, Module } from '@nestjs/common';
import { TokensModule } from '@modules/tokens/tokens.module';
import { OfferingsModule } from '@modules/offerings/offerings.module';
import { AdminSubscriptionsController, SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsRepository } from './subscriptions.repository';
import { SubscriptionsService } from './subscriptions.service';
import { SweeperService } from './sweeper.service';

@Module({
  /*
   * Circular with OfferingsModule, and legitimately so: an order needs the
   * offering to price and cap it, and closing an escrowed offering needs the
   * orders. forwardRef on BOTH sides — one side alone leaves the other
   * undefined at scan time.
   */
  imports: [TokensModule, forwardRef(() => OfferingsModule)],
  controllers: [SubscriptionsController, AdminSubscriptionsController],
  providers: [SubscriptionsService, SubscriptionsRepository, SweeperService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
