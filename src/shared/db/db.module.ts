/**
 * Global DB module. DbService is the only exported provider — there is no way
 * for a module to obtain the pool or an unscoped drizzle instance.
 */
import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';

@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
