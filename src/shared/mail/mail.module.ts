import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { MAILER } from './mailer';
import { MockMailer } from './mock.mailer';

/**
 * Provider selection happens ONCE, here, at boot.
 *
 * An unimplemented provider fails at startup rather than the first time someone
 * signs up — the same reasoning as validating env with Zod.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const provider = config.get('MAIL_PROVIDER');
        switch (provider) {
          case 'mock':
            if (config.isProduction) {
              /* The mock logs the message body, which contains one-time codes. */
              throw new Error(
                'MAIL_PROVIDER=mock is refused in production — it logs verification codes.',
              );
            }
            return new MockMailer();
          default:
            throw new Error(
              `MAIL_PROVIDER=${provider} is not implemented. Add a provider in shared/mail/.`,
            );
        }
      },
    },
  ],
  exports: [MAILER],
})
export class MailModule {}
