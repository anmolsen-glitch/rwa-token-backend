import { forwardRef, Module } from '@nestjs/common';
import { ManagersModule } from '@modules/managers/managers.module';
import { OfferingsModule } from '@modules/offerings/offerings.module';
import { SpvManagersModule } from '@modules/spv-managers/spv-managers.module';
import { IssuersController, PublicIssuersController } from './issuers.controller';
import { IssuersRepository } from './issuers.repository';
import { IssuersService } from './issuers.service';

/**
 * Circular with offerings and spv-managers, legitimately: the SPV detail panel
 * composes its assets and its management layer, and both of those modules need
 * the issuer for KYB checks. forwardRef on BOTH sides of each cycle.
 */
@Module({
  imports: [forwardRef(() => OfferingsModule), forwardRef(() => SpvManagersModule), ManagersModule],
  controllers: [IssuersController, PublicIssuersController],
  providers: [IssuersService, IssuersRepository],
  exports: [IssuersService, IssuersRepository],
})
export class IssuersModule {}
