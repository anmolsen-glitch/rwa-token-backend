/**
 * Where the backend's signing power comes from.
 *
 * Ported from ../rwa-token-backend/src/lib/signer.ts.
 *
 * THE WHOLE POINT: callers ask for a signer BY ROLE and never learn where the
 * key lives. Throwaway keys locally, vaulted keys in production, by config
 * alone — no code change.
 *
 *   SIGNER_TYPE=local  -> plain keys (DEV ONLY)
 *   SIGNER_TYPE=kms    -> keys live in AWS KMS and never leave it
 *
 * One key per operational role:
 *   deployer    — owns the OnchainID IdFactory (creates identities)
 *   agent       — token + identity-registry agent (mint, freeze, register)
 *   claimIssuer — the KYC signing key (signs claims)
 *
 * The NonceManager wrapping is essential, not incidental: a single onboard
 * sends several transactions back-to-back, and without it the second reuses a
 * nonce and is silently dropped ("nonce has already been used").
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppConfig } from '../config/app-config.service';
import { ChainService } from './chain.service';
import { KmsSigner } from './kms-signer';

/**
 * Hardhat's well-known accounts #0/#1/#2. PUBLIC keys, valid only on a local
 * test chain. Refused in production by assertProductionSafety().
 */
const DEV_KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  claimIssuer: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
} as const;

export type SignerRole = keyof typeof DEV_KEYS;
export const SIGNER_ROLES = Object.keys(DEV_KEYS) as SignerRole[];

@Injectable()
export class SignerService implements OnModuleInit {
  private readonly logger = new Logger(SignerService.name);
  private readonly cache = new Map<SignerRole, ethers.Signer>();

  constructor(
    private readonly config: AppConfig,
    private readonly chain: ChainService,
  ) {}

  onModuleInit(): void {
    this.assertProductionSafety();
    this.logger.log(`signer mode: ${this.mode()}`);
    void this.warnIfDeployerMismatch();
  }

  /** IdFactory.createIdentity is onlyOwner — a swapped agent key fails every onboard. */
  private async warnIfDeployerMismatch(): Promise<void> {
    const expected = this.config.get('NETWORK');
    try {
      const address = await this.addressFor('deployer');
      this.logger.log(`deployer signer ${address} on ${expected}`);
    } catch (err) {
      this.logger.warn({ err }, 'could not resolve deployer signer address');
    }
  }

  private get signerType(): string {
    return this.config.get('SIGNER_TYPE').toLowerCase();
  }

  /**
   * Refuse to start in production with dev keys.
   *
   * The Express app enforced this in config.ts's production guard. It is
   * repeated here because the failure is catastrophic and silent: Hardhat's
   * account #1 is a PUBLISHED private key, so a mainnet deploy using it hands
   * agent powers — mint, freeze, forced-transfer — to anyone on the internet.
   */
  private assertProductionSafety(): void {
    if (!this.config.isProduction) return;
    if (this.signerType === 'kms') return;

    const usingDevKey = SIGNER_ROLES.filter((role) => !this.explicitKeyFor(role));
    if (usingDevKey.length > 0) {
      throw new Error(
        `Refusing to start in production: SIGNER_TYPE=${this.signerType} and no key set for ` +
          `${usingDevKey.join(', ')} — would fall back to PUBLISHED Hardhat dev keys. ` +
          `Set SIGNER_TYPE=kms, or provide <ROLE>_PRIVATE_KEY for each role.`,
      );
    }
  }

  /** Config, never process.env — see the note in env.schema.ts. */
  private explicitKeyFor(role: SignerRole): string | undefined {
    const raw = this.config.get(`${role.toUpperCase()}_PRIVATE_KEY` as never) as
      | string
      | undefined;
    return raw?.trim() ? raw.trim() : undefined;
  }

  private kmsKeyIdFor(role: SignerRole): string | undefined {
    const raw = this.config.get(`KMS_KEY_ID_${role.toUpperCase()}` as never) as string | undefined;
    return raw?.trim() ? raw.trim() : undefined;
  }

  /** The signer for an operational role. Cached — the cache holds the nonce state. */
  get(role: SignerRole): ethers.Signer {
    const hit = this.cache.get(role);
    if (hit) return hit;

    const signer =
      this.signerType === 'kms' ? this.kmsSigner(role) : this.localSigner(role);

    this.cache.set(role, signer);
    return signer;
  }

  private kmsSigner(role: SignerRole): ethers.Signer {
    const keyId = this.kmsKeyIdFor(role);
    if (!keyId) {
      throw new Error(`SIGNER_TYPE=kms but KMS_KEY_ID_${role.toUpperCase()} is not set.`);
    }
    /* Wrapped in a NonceManager exactly like the local path, so a role can fire
       many transactions back-to-back without nonce collisions. */
    return new ethers.NonceManager(new KmsSigner(keyId, this.chain.provider));
  }

  private localSigner(role: SignerRole): ethers.Signer {
    const key = this.explicitKeyFor(role) ?? DEV_KEYS[role];
    return new ethers.NonceManager(new ethers.Wallet(key, this.chain.provider));
  }

  async addressFor(role: SignerRole): Promise<string> {
    return this.get(role).getAddress();
  }

  /**
   * Reset every cached NonceManager so the next send re-reads its nonce from
   * the chain.
   *
   * Call after a failed send: a reverted or replaced transaction leaves the
   * optimistic nonce out of sync, which then breaks EVERY following transaction
   * ("nonce too low" / "could not coalesce error"). Resetting is cheap and
   * self-healing; not resetting wedges the signer until restart.
   */
  resetNonces(): void {
    for (const signer of this.cache.values()) {
      if (signer instanceof ethers.NonceManager) signer.reset();
    }
  }

  /** Human-readable note for /health and logs. Never leaks a key id. */
  mode(): string {
    return this.signerType === 'kms' ? 'kms' : this.explicitKeyFor('deployer') ? 'local' : 'local (DEV keys)';
  }
}
