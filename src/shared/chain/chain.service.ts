/**
 * The single place we talk to the blockchain.
 *
 * Ported from ../rwa-token-backend/src/lib/chain.ts. The provider tuning below
 * is not stylistic — both settings were learned from a production incident
 * (2026-07-24) and are carried over deliberately.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppConfig } from '../config/app-config.service';

/** Minimal hand-written ABIs — only the signatures we actually call. */
export const TOKEN_ABI = [
  // reads
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function paused() view returns (bool)',
  'function identityRegistry() view returns (address)',
  'function compliance() view returns (address)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function isFrozen(address) view returns (bool)',
  'function getFrozenTokens(address) view returns (uint256)',
  // writes (agent-only on-chain)
  'function mint(address to, uint256 amount)',
  'function burn(address account, uint256 amount)',
  'function pause()',
  'function unpause()',
  'function setAddressFrozen(address account, bool freeze)',
  'function freezePartialTokens(address account, uint256 amount)',
  'function unfreezePartialTokens(address account, uint256 amount)',
  'function forcedTransfer(address from, address to, uint256 amount)',
  // events
  'event Transfer(address indexed from, address indexed to, uint256 value)',
] as const;

export const IDENTITY_REGISTRY_ABI = [
  'function isVerified(address userAddress) view returns (bool)',
  'function identity(address userAddress) view returns (address)',
  'function investorCountry(address userAddress) view returns (uint16)',
  'function contains(address userAddress) view returns (bool)',
  'function registerIdentity(address userAddress, address identity, uint16 country)',
  'function deleteIdentity(address userAddress)',
  'function issuersRegistry() view returns (address)',
  'function topicsRegistry() view returns (address)',
] as const;

export const TRUSTED_ISSUERS_REGISTRY_ABI = [
  'function owner() view returns (address)',
  'function isTrustedIssuer(address issuer) view returns (bool)',
  'function getTrustedIssuersForClaimTopic(uint256 claimTopic) view returns (address[])',
  'function addTrustedIssuer(address trustedIssuer, uint256[] claimTopics)',
] as const;

@Injectable()
export class ChainService {
  private readonly logger = new Logger(ChainService.name);

  /** One shared read-only connection. */
  readonly provider: ethers.JsonRpcProvider;

  /**
   * Dedicated connection for indexer log scanning, so backfill traffic and the
   * request path cannot starve each other's rate budget. Same object when
   * INDEXER_RPC_URL is unset.
   */
  readonly indexerProvider: ethers.JsonRpcProvider;

  constructor(private readonly config: AppConfig) {
    const rpc = config.get('RPC_URL');
    const indexerRpc = config.get('INDEXER_RPC_URL') ?? rpc;

    this.provider = this.makeProvider(rpc);
    this.indexerProvider = indexerRpc === rpc ? this.provider : this.makeProvider(indexerRpc);

    this.logger.log(`chain: ${config.get('NETWORK')} via ${new URL(rpc).host}`);
  }

  /**
   * Two non-default settings, both load-bearing (incident 2026-07-24):
   *
   * - `timeout`: ethers' default request timeout is ~5 MINUTES. A throttled
   *   public RPC does not refuse a request, it sits on it — a single hung call
   *   held /health open for 141-281s and made the admin console look dead.
   *   Nothing here is worth waiting minutes for: fail fast and report
   *   "unreachable".
   * - `staticNetwork`: without it, ethers re-runs eth_chainId before batches to
   *   detect network changes. The chain ID cannot change under us, so that is
   *   pure wasted budget on a rate-limited free-tier endpoint.
   */
  private makeProvider(url: string): ethers.JsonRpcProvider {
    const connection = new ethers.FetchRequest(url);
    connection.timeout = this.config.get('RPC_TIMEOUT_MS');
    return new ethers.JsonRpcProvider(connection, undefined, { staticNetwork: true });
  }

  token(address: string, runner?: ethers.ContractRunner): ethers.Contract {
    return new ethers.Contract(address, TOKEN_ABI as unknown as string[], runner ?? this.provider);
  }

  identityRegistry(address: string, runner?: ethers.ContractRunner): ethers.Contract {
    return new ethers.Contract(
      address,
      IDENTITY_REGISTRY_ABI as unknown as string[],
      runner ?? this.provider,
    );
  }

  trustedIssuersRegistry(address: string, runner?: ethers.ContractRunner): ethers.Contract {
    return new ethers.Contract(
      address,
      TRUSTED_ISSUERS_REGISTRY_ABI as unknown as string[],
      runner ?? this.provider,
    );
  }

  /** Cheap liveness probe for /health. Fails fast thanks to the timeout above. */
  async blockNumber(): Promise<number | null> {
    try {
      return await this.provider.getBlockNumber();
    } catch (err) {
      this.logger.warn({ err }, 'chain unreachable');
      return null;
    }
  }
}
