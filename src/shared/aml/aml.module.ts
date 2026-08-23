import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { AML_PROVIDER } from './aml.provider';
import { MockAmlProvider } from './mock.aml.provider';

const parseList = (raw: string): Set<string> =>
  new Set(raw.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean));

@Global()
@Module({
  providers: [
    {
      provide: AML_PROVIDER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const provider = config.get('AML_PROVIDER');
        if (provider !== 'mock') {
          throw new Error(
            `AML_PROVIDER=${provider} is not implemented. Add a provider in shared/aml/.`,
          );
        }
        /* Deliberately allowed in production: a mock that clears everything is
           a compliance failure, not a crash — so it is the operator's call and
           it is visible on /health rather than blocking boot. */
        return new MockAmlProvider(
          parseList(config.get('AML_SANCTIONED')),
          parseList(config.get('AML_REVIEW')),
        );
      },
    },
  ],
  exports: [AML_PROVIDER],
})
export class AmlModule {}
