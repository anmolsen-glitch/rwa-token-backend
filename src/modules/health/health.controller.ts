import { Controller, Get } from '@nestjs/common';
import { Public } from '@shared/auth/decorators';
import { HealthService } from './health.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /* @Public() is the only reason this is reachable without a session —
     guards are global and fail closed. */
  @Public()
  @ApiOperation({
    summary: 'Liveness + dependency status',
    description:
      'Reports database reachability, chain block height, signer mode, and whether the ' +
      'claim-issuer key is independent of the platform keys. Both probes fail fast — a ' +
      'health endpoint that hangs is worse than one reporting "down".',
  })
  @ApiOkResponse({ description: 'status is "degraded" when the DB or chain is unreachable.' })
  @Get()
  check() {
    return this.health.check();
  }
}
