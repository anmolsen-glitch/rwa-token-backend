/**
 * The independent claim issuer.
 *
 * CUSTODY DECISION (2026-08-20): the attesting key is INDEPENDENT of the
 * platform's deployer/agent keys.
 *
 * Why that matters. The claim-issuer key is HOT — it signs on every KYC
 * approval. The deployer/agent keys hold mint, freeze, and forced-transfer.
 * Sharing one key across both means a compromise of the busiest, most-exposed
 * signing path also hands over the ability to move investors' tokens.
 *
 * ERC-734 gives the separation directly: the ClaimIssuer contract keeps a cold
 * MANAGEMENT key (purpose 1) that can add and remove keys, and a hot CLAIM key
 * (purpose 3) that only attests. Rotating the attesting key never touches
 * ownership of the contract.
 *
 * THE TRAP THIS SERVICE EXISTS TO CATCH: OnchainID's keyHasPurpose() returns
 * true for a MANAGEMENT key on ANY purpose. So a management key signs claims
 * perfectly well, and a setup with ZERO purpose-3 keys looks completely healthy
 * — claims verify, onboarding succeeds, nothing errors. The lack of separation
 * is invisible unless you go looking, which is what verifyIndependence() does.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { IdentityService, KeyPurpose } from './identity.service';
import { InfraService } from './infra.service';
import { SignerService } from './signer.service';

export interface ClaimIssuerStatus {
  contract: string;
  signerAddress: string;
  /** Registered as a dedicated purpose-3 CLAIM key. */
  isClaimKey: boolean;
  /** Also a MANAGEMENT key — meaning it can rewrite the issuer's key set. */
  isManagementKey: boolean;
  /** Number of dedicated CLAIM keys on the contract. */
  claimKeyCount: number;
  /** True only when the attesting key is a CLAIM key and NOT a management key. */
  independent: boolean;
  warning: string | null;
}

export interface SignedClaim {
  topic: string;
  /** ERC-735 scheme 1 = ECDSA. */
  scheme: number;
  issuer: string;
  signature: string;
  /** Hex-encoded claim data — pass through to addClaim verbatim. */
  data: string;
  uri: string;
}

@Injectable()
export class ClaimIssuerService implements OnModuleInit {
  private readonly logger = new Logger(ClaimIssuerService.name);
  private cachedStatus: ClaimIssuerStatus | null = null;

  constructor(
    private readonly identities: IdentityService,
    private readonly signers: SignerService,
    private readonly infra: InfraService,
  ) {}

  async onModuleInit(): Promise<void> {
    /* Non-fatal at boot: the chain may be unreachable, and refusing to start
       would take the whole API down over an advisory check. */
    const infra = this.infra.get();
    if (!infra) {
      this.logger.warn('no infrastructure deployed on this network — skipping claim-issuer check');
      return;
    }
    try {
      const status = await this.readStatus(infra.claimIssuer);
      if (!status.independent) this.logger.warn(status.warning);
      else this.logger.log(`claim issuer independent: ${status.signerAddress}`);
    } catch (err) {
      this.logger.warn({ err }, 'could not verify claim-issuer independence at boot');
    }
  }

  /**
   * Sign a claim for the investor to submit themselves.
   *
   * NON-CUSTODIAL: this returns a payload, it does NOT send a transaction. Only
   * a key on the investor's own ONCHAINID may call addClaim, and the platform
   * does not hold one.
   */
  async signClaim(
    claimIssuerAddress: string,
    identityAddr: string,
    topic: bigint,
    now: Date,
  ): Promise<SignedClaim> {
    const data = IdentityService.claimData(topic, now);
    const digest = IdentityService.claimDigest(identityAddr, topic, data);

    /* signMessage applies the EIP-191 prefix, which is what OnchainID's
       ClaimIssuer.isClaimValid expects. Signing the raw digest would produce a
       signature that recovers to the wrong address and fails verification. */
    const signature = await this.signers.get('claimIssuer').signMessage(ethers.getBytes(digest));

    return {
      topic: topic.toString(),
      scheme: 1,
      issuer: claimIssuerAddress,
      signature,
      data: ethers.hexlify(data),
      uri: '',
    };
  }

  /**
   * Is the attesting key genuinely separate from platform control?
   *
   * Independent means: registered as a purpose-3 CLAIM key AND not also a
   * MANAGEMENT key. A management key trivially satisfies every purpose, so
   * "it can sign" proves nothing about separation.
   */
  async verifyIndependence(claimIssuerAddress?: string): Promise<ClaimIssuerStatus> {
    const contract =
      claimIssuerAddress ?? this.cachedStatus?.contract ?? this.infra.get()?.claimIssuer;
    if (!contract) throw new Error('Claim issuer address is not configured');
    return this.readStatus(contract);
  }

  async readStatus(contractAddress: string): Promise<ClaimIssuerStatus> {
    const signerAddress = await this.signers.addressFor('claimIssuer');
    const issuer = this.identities.claimIssuer(contractAddress);
    const key = IdentityService.keyOf(signerAddress);

    const [isClaimKey, isManagementKey, claimKeys] = await Promise.all([
      issuer.keyHasPurpose(key, KeyPurpose.CLAIM) as Promise<boolean>,
      issuer.keyHasPurpose(key, KeyPurpose.MANAGEMENT) as Promise<boolean>,
      issuer.getKeysByPurpose(KeyPurpose.CLAIM) as Promise<string[]>,
    ]);

    /* Dedicated claim key = holds CLAIM but not MANAGEMENT. */
    const claimKeyCount = claimKeys.length;
    const independent = isClaimKey && !isManagementKey;

    let warning: string | null = null;
    if (isManagementKey) {
      warning =
        `Claim-issuer key ${signerAddress} is a MANAGEMENT key on ${contractAddress}. ` +
        `It can sign claims (management satisfies every purpose) but is NOT independent: ` +
        `the same key can rewrite the issuer's key set, and if it is also the platform's ` +
        `deployer/agent key then one compromise yields both attestation and token control. ` +
        `Add a dedicated purpose-3 CLAIM key and point CLAIMISSUER_PRIVATE_KEY / ` +
        `KMS_KEY_ID_CLAIMISSUER at it.`;
    } else if (!isClaimKey) {
      warning =
        `Claim-issuer key ${signerAddress} has NO claim purpose on ${contractAddress}. ` +
        `Claims it signs will fail on-chain verification.`;
    }

    const status: ClaimIssuerStatus = {
      contract: contractAddress,
      signerAddress,
      isClaimKey,
      isManagementKey,
      claimKeyCount,
      independent,
      warning,
    };
    this.cachedStatus = status;
    return status;
  }

  /** Last computed status, for /health. Never triggers a chain call. */
  lastStatus(): ClaimIssuerStatus | null {
    return this.cachedStatus;
  }
}
