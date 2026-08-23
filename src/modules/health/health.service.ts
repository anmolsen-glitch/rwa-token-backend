import { Injectable } from '@nestjs/common';
import { DbService } from '@shared/db/db.service';
import { ChainService } from '@shared/chain/chain.service';
import { SignerService } from '@shared/chain/signer.service';
import { ClaimIssuerService } from '@shared/chain/claim-issuer.service';
import { AppConfig } from '@shared/config/app-config.service';

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: 'nest';
  db: 'up' | 'down';
  chain: { network: string; blockNumber: number | null; signer: string };
  claimIssuer: { independent: boolean; warning: string | null } | null;
  uptimeSeconds: number;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly db: DbService,
    private readonly chain: ChainService,
    private readonly signers: SignerService,
    private readonly claimIssuer: ClaimIssuerService,
    private readonly config: AppConfig,
  ) {}

  async check(): Promise<HealthReport> {
    /* Both probes fail fast and never throw — a health endpoint that hangs is
       worse than one reporting "down" (incident 2026-07-24). */
    const [dbUp, blockNumber] = await Promise.all([
      this.db.healthy(),
      this.chain.blockNumber(),
    ]);

    return {
      status: dbUp && blockNumber !== null ? 'ok' : 'degraded',
      service: 'nest',
      db: dbUp ? 'up' : 'down',
      chain: {
        network: this.config.get('NETWORK'),
        blockNumber,
        /* Mode only — never a key id or address. */
        signer: this.signers.mode(),
      },
      /* Advisory, from the cached boot check — never a chain call per request. */
      claimIssuer: (() => {
        const st = this.claimIssuer.lastStatus();
        return st ? { independent: st.independent, warning: st.warning } : null;
      })(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
