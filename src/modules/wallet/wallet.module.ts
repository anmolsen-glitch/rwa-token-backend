import { Global, Module } from '@nestjs/common';
import { SiweService } from './siwe.service';

/** Global: both the account module and (later) investor auth need SIWE. */
@Global()
@Module({ providers: [SiweService], exports: [SiweService] })
export class WalletModule {}
