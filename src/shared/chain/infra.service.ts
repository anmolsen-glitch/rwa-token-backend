/**
 * The deployed-contract address book.
 *
 * Copied into this service so the API does not need the contracts repo at
 * runtime. After a new deploy, replace `config/deployed-addresses.json`.
 *
 * NOTE the split of responsibilities since migration 039: the `tokens` TABLE is
 * authoritative for token -> issuer, while this file remains authoritative for
 * infrastructure addresses. Do not reintroduce token->issuer lookups here.
 */
import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError } from '../errors/app-error';
import { AppConfig } from '../config/app-config.service';

export interface Infra {
  idFactory: string;
  claimIssuer: string;
  trexFactory: string;
  deployer: string;
}

interface NetworkSection {
  idFactory?: string;
  claimIssuer?: string;
  trexFactory?: string;
  deployer?: string;
}

@Injectable()
export class InfraService {
  private readonly logger = new Logger(InfraService.name);
  private readonly file: string;

  constructor(private readonly config: AppConfig) {
    this.file = resolve(
      config.get('ADDRESSES_FILE') ?? resolve(process.cwd(), 'config/deployed-addresses.json'),
    );
  }

  private section(): NetworkSection | null {
    if (!existsSync(this.file)) {
      this.logger.warn(`address book not found at ${this.file}`);
      return null;
    }
    try {
      const all = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, NetworkSection>;
      return all[this.config.get('NETWORK')] ?? null;
    } catch (err) {
      this.logger.error({ err }, 'address book is unreadable');
      return null;
    }
  }

  /** Infra for the active network, or null when not deployed there. */
  get(): Infra | null {
    const net = this.section();
    if (!net?.idFactory || !net?.claimIssuer || !net?.trexFactory) return null;
    return {
      idFactory: net.idFactory,
      claimIssuer: net.claimIssuer,
      trexFactory: net.trexFactory,
      deployer: net.deployer ?? '',
    };
  }

  /** Infra or a 503 — chain features are unusable without it. */
  require(): Infra {
    const infra = this.get();
    if (!infra) {
      throw new AppError(
        'INFRA_NOT_DEPLOYED',
        503,
        `Platform infrastructure is not deployed on network "${this.config.get('NETWORK')}".`,
        { network: this.config.get('NETWORK') },
      );
    }
    return infra;
  }
}
