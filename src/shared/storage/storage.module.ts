import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { DOCUMENT_STORAGE } from './document-storage';
import { LocalDiskStorage } from './local-disk.storage';

/**
 * Backend selection happens ONCE, at boot, and refuses unsafe combinations
 * there rather than at the first upload.
 */
@Global()
@Module({
  providers: [
    {
      provide: DOCUMENT_STORAGE,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const backend = config.get('DOCUMENT_STORAGE_BACKEND');
        if (backend !== 'local-disk') {
          throw new Error(
            `DOCUMENT_STORAGE_BACKEND=${backend} is not implemented. Add it in shared/storage/.`,
          );
        }

        const raw = config.get('DOCUMENT_ENCRYPTION_KEY');
        let key: Buffer | null = null;
        if (raw) {
          key = Buffer.from(raw, 'base64');
          if (key.length !== 32) {
            throw new Error('DOCUMENT_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
          }
        }

        if (config.isProduction && !key) {
          /* Identity documents in the clear on an EBS volume is a breach waiting
             for a mislaid snapshot. Fail at boot, not after the first upload. */
          throw new Error(
            'DOCUMENT_ENCRYPTION_KEY is required in production — KYC documents must not be stored unencrypted.',
          );
        }

        return new LocalDiskStorage(
          LocalDiskStorage.resolveRoot(config.get('DOCUMENT_STORAGE_ROOT')),
          key,
        );
      },
    },
  ],
  exports: [DOCUMENT_STORAGE],
})
export class StorageModule {}
