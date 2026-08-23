import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { LoginThrottleGuard } from './login-throttle.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, LoginThrottleGuard],
  exports: [AuthService],
})
export class AuthModule {}
