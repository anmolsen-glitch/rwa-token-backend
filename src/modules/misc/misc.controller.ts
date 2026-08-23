/**
 * The small public/utility surface that belongs to no domain.
 *
 *   public: GET  /api/config    front-end config (network, chain id, explorer)
 *           POST /api/estimate  instant valuation estimate for "list your property"
 *   admin:  GET  /api/admin/audit  the privileged-action trail
 *
 * Grouped deliberately rather than each getting a module: three unrelated
 * endpoints with no shared state, where a module apiece would be ceremony
 * without structure. If any grows a second route it moves out.
 */
import { Body, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public, Tenant } from '@shared/auth/decorators';
import type { TenantContext } from '@shared/auth/tenant-context';
import { AppConfig } from '@shared/config/app-config.service';
import { ApiAuthErrors, ApiValidationError } from '@shared/openapi/api-error.decorator';
import { AuditQueryService } from './audit-query.service';
import { EstimateService } from './estimate.service';
import { EstimateDto } from './dto/estimate.dto';
import { Post, HttpCode } from '@nestjs/common';

@ApiTags('Platform')
@Controller()
export class MiscController {
  constructor(
    private readonly config: AppConfig,
    private readonly estimator: EstimateService,
  ) {}

  @ApiOperation({
    summary: 'Public front-end config',
    description:
      'Network-aware so the portals can link to real on-chain transactions. `explorerUrl` ' +
      'is empty on local Hardhat, where the UI degrades to a copyable hash.',
  })
  @Public()
  @Get('config')
  appConfig() {
    return {
      network: this.config.get('NETWORK'),
      chainId: this.config.get('SIWE_CHAIN_ID'),
      explorerUrl: this.config.get('EXPLORER_URL'),
    };
  }

  @ApiOperation({
    summary: 'Instant valuation estimate',
    description:
      'The "list your property" front door — a prospective seller gets an estimate BEFORE ' +
      'applying, so no session. Deterministic and explainable, not an appraisal: a real ' +
      'valuation is recorded later against the offering.',
  })
  @ApiValidationError()
  @Public()
  @HttpCode(200)
  @Post('estimate')
  estimate(@Body() dto: EstimateDto) {
    return this.estimator.estimate(dto);
  }
}

@ApiTags('Platform')
@ApiAuthErrors()
@Controller('admin')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @ApiOperation({
    summary: 'Privileged-action audit trail',
    description:
      'Scoped to your own issuer by RLS (migration 057); the platform operator sees ' +
      'everything including its own cross-tenant actions. Append-only — there is no write ' +
      'or delete route, and the tenant role has no grant for either.',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'action', required: false, description: 'Prefix match, e.g. "case."' })
  @Get('audit')
  list(
    @Tenant() t: TenantContext,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
  ) {
    return this.audit.list(t, { limit: Number(limit) || 100, action: action ?? null });
  }
}
