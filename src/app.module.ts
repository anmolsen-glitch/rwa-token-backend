/**
 * Root module.
 *
 * Guards and the validation pipe are registered GLOBALLY here rather than
 * decorated onto each controller. That is what makes the security posture
 * fail-closed: a new route is authenticated, tenant-scoped, and validated
 * without its author doing anything. Opting out requires @Public(), which is
 * greppable.
 *
 * Guard order matters and is the order of this array:
 *   AuthGuard   → who are you?
 *   TenantGuard → what data may you see?
 *   RolesGuard  → may you do this?
 */
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import { ConfigModule } from '@shared/config/config.module';
import { DbModule } from '@shared/db/db.module';
import { AuthModule as SharedAuthModule } from '@shared/auth/auth.module';
import { AuditModule } from '@shared/audit/audit.module';
import { ChainModule } from '@shared/chain/chain.module';
import { MailModule } from '@shared/mail/mail.module';
import { StorageModule } from '@shared/storage/storage.module';
import { PaymentsModule } from '@shared/payments/payments.module';
import { AmlModule } from '@shared/aml/aml.module';
import { AuthGuard } from '@shared/auth/auth.guard';
import { TenantGuard } from '@shared/auth/tenant.guard';
import { RolesGuard } from '@shared/auth/roles.guard';
import { AppExceptionFilter } from '@shared/errors/app-exception.filter';
import { AppConfig } from '@shared/config/app-config.service';

import { HealthModule } from '@modules/health/health.module';
import { AuthModule } from '@modules/auth/auth.module';
import { ManagersModule } from '@modules/managers/managers.module';
import { SpvManagersModule } from '@modules/spv-managers/spv-managers.module';
import { CasesModule } from '@modules/cases/cases.module';
import { MiscModule } from '@modules/misc/misc.module';
import { PortfolioModule } from '@modules/portfolio/portfolio.module';
import { DistributionsModule } from '@modules/distributions/distributions.module';
import { TeamModule } from '@modules/team/team.module';
import { OfferingsModule } from '@modules/offerings/offerings.module';
import { IssuersModule } from '@modules/issuers/issuers.module';
import { InvestorsModule } from '@modules/investors/investors.module';
import { OnboardingModule } from '@modules/onboarding/onboarding.module';
import { KycModule } from '@modules/kyc/kyc.module';
import { WalletModule } from '@modules/wallet/wallet.module';
import { AccountModule } from '@modules/account/account.module';
import { DocumentsModule } from '@modules/documents/documents.module';
import { ComplianceModule } from '@modules/compliance/compliance.module';
import { WebhooksModule } from '@modules/webhooks/webhooks.module';
import { IndexerModule } from '@modules/indexer/indexer.module';
import { TokensModule } from '@modules/tokens/tokens.module';
import { OperationsModule } from '@modules/operations/operations.module';
import { SubscriptionsModule } from '@modules/subscriptions/subscriptions.module';
import { UploadsModule } from '@modules/uploads/uploads.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          transport:
            config.isDevelopment
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          /* Never log credentials. Adding a header here is cheaper than a
             breach notification. */
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-csrf-token"]',
            'res.headers["set-cookie"]',
          ],
        },
      }),
    }),
    DbModule,
    SharedAuthModule,
    AuditModule,
    ChainModule,
    MailModule,
    StorageModule,
    PaymentsModule,
    AmlModule,

    HealthModule,
    AuthModule,
    IssuersModule,
    OfferingsModule,
    ManagersModule,
    SpvManagersModule,
    TeamModule,
    DistributionsModule,
    CasesModule,
    PortfolioModule,
    MiscModule,
    InvestorsModule,
    OnboardingModule,
    KycModule,
    WalletModule,
    AccountModule,
    DocumentsModule,
    ComplianceModule,
    WebhooksModule,
    IndexerModule,
    TokensModule,
    OperationsModule,
    SubscriptionsModule,
    UploadsModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
