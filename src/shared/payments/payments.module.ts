import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { MockPaymentProvider, PAYMENT_PROVIDER_TOKEN } from './payment.provider';

/**
 * Provider selection happens ONCE at boot.
 *
 * Unlike the mailer, `mock` is NOT refused in production: a mock that captures
 * instantly is a business decision (a sandbox tenant), not a credential leak.
 * It is visible in every order's `payment_provider` column.
 */
@Global()
@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER_TOKEN,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const provider = config.get('PAYMENT_PROVIDER');
        if (provider !== 'mock') {
          throw new Error(
            `PAYMENT_PROVIDER=${provider} is not implemented. Add it in shared/payments/.`,
          );
        }
        return new MockPaymentProvider(config.get('WEBHOOK_SECRET'));
      },
    },
  ],
  exports: [PAYMENT_PROVIDER_TOKEN],
})
export class PaymentsModule {}
