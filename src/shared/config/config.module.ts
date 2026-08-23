/**
 * Global config module.
 *
 * `isGlobal: true` means AppConfig is injectable anywhere without each module
 * importing this one. Config is genuinely cross-cutting and dependency-free,
 * which makes it one of the few places a global is correct.
 */
import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';
import { AppConfig } from './app-config.service';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),
  ],
  providers: [AppConfig],
  exports: [AppConfig],
})
export class ConfigModule {}
