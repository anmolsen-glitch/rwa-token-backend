import { Module } from '@nestjs/common';
import { IssuersController, PublicIssuersController } from './issuers.controller';
import { IssuersRepository } from './issuers.repository';
import { IssuersService } from './issuers.service';

@Module({
  controllers: [IssuersController, PublicIssuersController],
  providers: [IssuersService, IssuersRepository],
  exports: [IssuersService, IssuersRepository],
})
export class IssuersModule {}
