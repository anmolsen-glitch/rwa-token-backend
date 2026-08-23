/**
 * ONCHAINID: identities, claims, and the claim issuer.
 *
 * Ported from ../rwa-token-backend/src/lib/chain.ts (ABIs) and the identity
 * helpers in onboarding.service.ts.
 *
 * CUSTODY MODEL (decided 2026-08-20): non-custodial + platform-managed
 * compliance + independent claim issuer.
 *   - The investor's wallet is the MANAGEMENT key of their own ONCHAINID. The
 *     platform deploys the identity contract (and pays gas) but cannot act as
 *     the investor.
 *   - Only the investor can call addClaim on their identity, so the platform
 *     signs a claim OFF-CHAIN and hands it over for them to submit.
 *   - The platform still operates ERC-3643 agent powers (registerIdentity,
 *     freeze, forced-transfer). That is compliance control, not custody.
 */
import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { ChainService } from './chain.service';

export const ID_FACTORY_ABI = [
  'function createIdentity(address wallet, string salt) returns (address)',
  'function getIdentity(address wallet) view returns (address)',
] as const;

/** An investor's ONCHAINID: stores their signed claims. */
export const IDENTITY_ABI = [
  'function addClaim(uint256 topic, uint256 scheme, address issuer, bytes signature, bytes data, string uri) returns (bytes32)',
  'function getClaim(bytes32 claimId) view returns (uint256 topic, uint256 scheme, address issuer, bytes signature, bytes data, string uri)',
  'function removeClaim(bytes32 claimId) returns (bool)',
  // ERC-734 key management — needed to verify claim-issuer independence.
  'function keyHasPurpose(bytes32 _key, uint256 _purpose) view returns (bool)',
  'function getKeysByPurpose(uint256 _purpose) view returns (bytes32[])',
  'function addKey(bytes32 _key, uint256 _purpose, uint256 _keyType) returns (bool)',
] as const;

export const CLAIM_ISSUER_ABI = [
  'function revokeClaimBySignature(bytes signature)',
  'function isClaimRevoked(bytes signature) view returns (bool)',
  'function keyHasPurpose(bytes32 _key, uint256 _purpose) view returns (bool)',
  'function getKeysByPurpose(uint256 _purpose) view returns (bytes32[])',
  'function addKey(bytes32 _key, uint256 _purpose, uint256 _keyType) returns (bool)',
] as const;

/** ERC-734 key purposes. */
export const KeyPurpose = { MANAGEMENT: 1n, ACTION: 2n, CLAIM: 3n } as const;

/** Claim topics — must match contracts/constants/ClaimTopics.sol. */
export const KYC_TOPIC = 1n;
export const ACCREDITED_TOPIC = 7n;

export const CLAIM_LABEL: Record<string, string> = {
  [KYC_TOPIC.toString()]: 'KYC-verified',
  [ACCREDITED_TOPIC.toString()]: 'ACCREDITED-verified',
};

@Injectable()
export class IdentityService {
  constructor(private readonly chain: ChainService) {}

  idFactory(address: string, runner?: ethers.ContractRunner): ethers.Contract {
    return new ethers.Contract(
      address,
      ID_FACTORY_ABI as unknown as string[],
      runner ?? this.chain.provider,
    );
  }

  identity(address: string, runner?: ethers.ContractRunner): ethers.Contract {
    return new ethers.Contract(
      address,
      IDENTITY_ABI as unknown as string[],
      runner ?? this.chain.provider,
    );
  }

  claimIssuer(address: string, runner?: ethers.ContractRunner): ethers.Contract {
    return new ethers.Contract(
      address,
      CLAIM_ISSUER_ABI as unknown as string[],
      runner ?? this.chain.provider,
    );
  }

  /** ERC-734 key id for an address: keccak256(abi.encode(address)). */
  static keyOf(address: string): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['address'], [ethers.getAddress(address)]),
    );
  }

  /** Deterministic claimId for an (issuer, topic) pair — matches OnchainID. */
  static claimIdFor(issuer: string, topic: bigint): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [issuer, topic]),
    );
  }

  /**
   * The digest a claim issuer signs: keccak256(identity, topic, data).
   * The investor submits {signature, data} to addClaim; the token's
   * IdentityRegistry later validates it against the trusted issuer.
   */
  static claimDigest(identityAddr: string, topic: bigint, data: Uint8Array): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'bytes'],
        [identityAddr, topic, data],
      ),
    );
  }

  /**
   * Claim payload for a topic.
   *
   * The issuance timestamp makes every signature unique. That matters because
   * revokeClaimBySignature blacklists an exact signature forever — without the
   * timestamp, revoking once would permanently block any later re-grant from
   * producing a valid claim.
   */
  static claimData(topic: bigint, now: Date): Uint8Array {
    const label = CLAIM_LABEL[topic.toString()] ?? 'verified';
    return ethers.toUtf8Bytes(`${label} @${now.toISOString()}`);
  }

  /** The signature our issuer attached for this topic, or null. */
  async claimSignature(
    identityAddr: string,
    issuer: string,
    topic: bigint,
  ): Promise<string | null> {
    const claim = await this.identity(identityAddr).getClaim(
      IdentityService.claimIdFor(issuer, topic),
    );
    const signature = claim[3] as string;
    return signature && signature !== '0x' ? signature : null;
  }

  /**
   * Is a claim attached AND still valid (not revoked at the ClaimIssuer)?
   *
   * A revoked claim fails on-chain isVerified, so for every issue/verify
   * decision it must count as ABSENT — otherwise a re-granted investor is stuck
   * behind a permanently dead claim.
   */
  async hasLiveClaim(identityAddr: string, issuer: string, topic: bigint): Promise<boolean> {
    const signature = await this.claimSignature(identityAddr, issuer, topic);
    if (!signature) return false;
    return !(await this.claimIssuer(issuer).isClaimRevoked(signature));
  }

  /** Does this address have a deployed contract (vs a stale/codeless record)? */
  async hasCode(address: string): Promise<boolean> {
    if (!address || address === ethers.ZeroAddress) return false;
    const code = await this.chain.provider.getCode(address);
    return Boolean(code && code !== '0x');
  }
}
