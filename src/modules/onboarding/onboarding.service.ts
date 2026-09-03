/**
 * Non-custodial onboarding.
 *
 * Ported from ../rwa-token-backend/src/services/onboarding.service.ts, keeping
 * ONLY the `prepareClaim` path. The custodial variant (attachClaimCustodial /
 * getInvestorSigner, which derived an investor key from the Hardhat mnemonic)
 * is deliberately NOT carried over — see CLAUDE.md §12.
 *
 * The flow is two-phase because the platform cannot act as the investor:
 *
 *   1. PREPARE  (platform)  ensure a live ONCHAINID exists, then sign a claim
 *                           per required topic and hand the payloads back.
 *   2. addClaim (INVESTOR)  the investor submits each claim from their own
 *                           wallet. The platform never sees their key.
 *   3. CONFIRM  (platform)  once the claims are on-chain, the agent registers
 *                           the identity in the token's IdentityRegistry.
 *
 * Step 3 is "platform-managed compliance": the platform holds ERC-3643 agent
 * powers (registerIdentity, freeze, forced-transfer) so it can meet its
 * regulatory obligations. That is control over COMPLIANCE, not custody of
 * assets — the investor's tokens stay in the investor's wallet.
 */
import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { ChainService } from '@shared/chain/chain.service';
import { ClaimIssuerService, type SignedClaim } from '@shared/chain/claim-issuer.service';
import {
  ACCREDITED_TOPIC,
  IdentityService,
  KYC_TOPIC,
} from '@shared/chain/identity.service';
import { InfraService } from '@shared/chain/infra.service';
import { SignerService } from '@shared/chain/signer.service';
import { TxService } from '@shared/chain/tx.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { OnboardingRepository } from './onboarding.repository';

export interface PrepareResult {
  wallet: string;
  identity: string;
  identityCreated: boolean;
  /** Claims the investor must submit via identity.addClaim(...). */
  claims: SignedClaim[];
  /** Topics already present and valid on-chain — nothing to do. */
  alreadyPresent: string[];
  nextStep: string;
}

export interface OnboardingStatus {
  wallet: string;
  identity: string | null;
  identityDeployed: boolean;
  kycStatus: string;
  claims: Array<{ topic: string; present: boolean }>;
  registeredInRegistry: boolean;
  verified: boolean;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly repo: OnboardingRepository,
    private readonly infra: InfraService,
    private readonly chain: ChainService,
    private readonly identities: IdentityService,
    private readonly claimIssuer: ClaimIssuerService,
    private readonly signers: SignerService,
    private readonly tx: TxService,
    private readonly audit: AuditService,
  ) {}

  /** Claim topics a holder of this token must carry. */
  private async requiredTopics(tokenSymbol: string): Promise<bigint[]> {
    const topics = [KYC_TOPIC];
    if (await this.repo.tokenRequiresAccreditation(tokenSymbol)) topics.push(ACCREDITED_TOPIC);
    return topics;
  }

  /**
   * Phase 1. Ensure the investor has a live ONCHAINID and return signed claims
   * for them to submit.
   *
   * Sends at most one transaction (createIdentity) and never signs on the
   * investor's behalf.
   */
  /**
   * Identity plumbing other modules need: which wallets are one person.
   *
   * Exposed on the SERVICE rather than letting callers reach for
   * OnboardingRepository, because `wallets` is this module's table. Governance
   * uses both — one person is one voter however many wallets they hold across.
   */
  resolvePrimaryWallet(address: string): Promise<string> {
    return this.repo.resolvePrimaryWallet(address);
  }

  walletsForPerson(primaryWallet: string): Promise<string[]> {
    return this.repo.walletsForPerson(primaryWallet);
  }

  /** Is this person accredited? Decides eligibility for private placements. */
  isAccredited(primaryWallet: string): Promise<boolean> {
    return this.repo.isAccredited(primaryWallet);
  }

  /**
   * Attach a wallet to a person WITHOUT a signature — admin recovery only.
   *
   * The normal link path requires the new wallet to sign, proving control. This
   * one deliberately does not, because the whole premise of lost-key recovery is
   * that the investor cannot sign. Identity was proved off-chain instead, which
   * is why this is reachable only from an open case (CasesService.recover) and
   * writes an audit row naming that case.
   *
   * The three collision checks are NOT relaxed: a wallet that already belongs to
   * someone, or is an investor in its own right, is refused. Recovery must never
   * be a way to absorb another person's address.
   */
  async adminLinkWallet(
    principal: Principal,
    tenant: TenantContext,
    primaryWallet: string,
    newWallet: string,
  ): Promise<void> {
    const address = newWallet.toLowerCase();
    if (await this.repo.walletLink(address)) {
      throw AppError.conflict('WALLET_LINKED', 'That wallet is already linked to an investor.');
    }
    if (await this.repo.getInvestor(address)) {
      throw AppError.conflict('WALLET_IS_INVESTOR', 'That wallet is already its own investor.');
    }
    await this.repo.linkWallet(primaryWallet, address, 'clear');
    await this.audit.record(principal, tenant, {
      action: 'wallet.admin_link',
      target: primaryWallet,
      params: { linked: address, reason: 'admin recovery — no signature required' },
    });
  }

  async prepare(
    principal: Principal,
    tenant: TenantContext,
    wallet: string,
    tokenSymbol: string,
    now: Date,
  ): Promise<PrepareResult> {
    const infra = this.infra.require();
    const address = ethers.getAddress(wallet);

    /* KYC and the ONCHAINID belong to the PERSON (primary wallet), not to
       whichever linked wallet is being onboarded. */
    const primary = await this.repo.resolvePrimaryWallet(address);
    let { investor: person, kycStatus } = await this.repo.resolveCompliance(primary);

    /* Belt-and-suspenders: the investor JWT carries account_id from link-wallet. */
    if (kycStatus !== 'completed' && principal.accountId) {
      const acct = await this.repo.accountCompliance(principal.accountId);
      if (acct) kycStatus = acct.kycStatus;
    }

    if (!person || kycStatus !== 'completed') {
      throw new AppError('KYC_NOT_APPROVED', 403, 'KYC is not approved for this account yet.', {
        kycStatus,
        wallet: primary,
        accountId: principal.accountId ?? person?.accountId ?? null,
      });
    }

    const topics = await this.requiredTopics(tokenSymbol);
    if (topics.includes(ACCREDITED_TOPIC)) {
      const accredited = await this.repo.isAccredited(primary);
      if (!accredited) {
        throw new AppError(
          'ACCREDITATION_REQUIRED',
          403,
          'This is an accredited-investor-only offering. Your account must be granted accredited status first.',
          { token: tokenSymbol },
        );
      }
    }

    const { identity, created } = await this.ensureIdentity(primary, address, infra.idFactory);

    /* Only sign topics that are missing or revoked — re-signing a live claim
       would have the investor pay gas to replace something already valid. */
    const claims: SignedClaim[] = [];
    const alreadyPresent: string[] = [];
    for (const topic of topics) {
      if (await this.identities.hasLiveClaim(identity, infra.claimIssuer, topic)) {
        alreadyPresent.push(topic.toString());
        continue;
      }
      claims.push(await this.claimIssuer.signClaim(infra.claimIssuer, identity, topic, now));
    }

    await this.audit.record(principal, tenant, {
      action: 'onboarding.claims_prepared',
      target: address,
      params: {
        token: tokenSymbol,
        identity,
        identityCreated: created,
        topics: claims.map((c) => c.topic),
      },
    });

    return {
      wallet: address,
      identity,
      identityCreated: created,
      claims,
      alreadyPresent,
      nextStep: claims.length
        ? 'Submit each claim from the investor wallet: identity.addClaim(topic, scheme, issuer, signature, data, uri). Then call POST /api/admin/onboarding/confirm.'
        : 'All required claims are already present. Call POST /api/admin/onboarding/confirm.',
    };
  }

  /**
   * Deploy the investor's ONCHAINID if needed.
   *
   * The platform pays gas via the deployer key, but `createIdentity(wallet, …)`
   * sets the INVESTOR's wallet as the management key — so the identity is
   * theirs from the moment it exists. Re-creates when the stored address has no
   * code (a chain reset while Postgres kept the old record).
   */
  private async ensureIdentity(
    primaryWallet: string,
    wallet: string,
    idFactoryAddress: string,
  ): Promise<{ identity: string; created: boolean }> {
    const stored = await this.repo.getInvestor(primaryWallet);
    const recorded = stored?.onchainid ?? null;

    if (recorded && (await this.identities.hasCode(recorded))) {
      return { identity: recorded, created: false };
    }

    const factoryRead = this.identities.idFactory(idFactoryAddress);
    let identity: string = await factoryRead.getIdentity(wallet);

    if (identity === ethers.ZeroAddress) {
      const factory = this.identities.idFactory(idFactoryAddress, this.signers.get('deployer'));
      const salt = `person-${primaryWallet.slice(2, 12)}-${KYC_TOPIC}`;
      try {
        await this.tx.submit(`createIdentity ${wallet}`, () =>
          factory.createIdentity(wallet, salt) as Promise<ethers.ContractTransactionResponse>,
        );
      } catch (err) {
        throw chainFailure(err, 'Could not create your on-chain identity.');
      }
      identity = await factoryRead.getIdentity(wallet);
    }

    if (identity === ethers.ZeroAddress) {
      throw new AppError('IDENTITY_CREATE_FAILED', 502, 'ONCHAINID could not be created.');
    }

    await this.repo.setOnchainId(primaryWallet, identity);
    return { identity, created: true };
  }

  /**
   * Phase 3. Register the identity in the token's IdentityRegistry.
   *
   * Uses the AGENT key — platform-managed compliance. Refuses if the required
   * claims are not actually on-chain yet, because registering an unverifiable
   * identity produces a holder who cannot transfer and is confusing to debug.
   */
  async confirm(
    principal: Principal,
    tenant: TenantContext,
    wallet: string,
    tokenSymbol: string,
  ): Promise<{ wallet: string; identity: string; registered: boolean; verified: boolean }> {
    const infra = this.infra.require();
    const address = ethers.getAddress(wallet);
    const primary = await this.repo.resolvePrimaryWallet(address);

    const { investor: person, country } = await this.repo.resolveCompliance(primary);
    const identity = person?.onchainid;
    if (!identity || !(await this.identities.hasCode(identity))) {
      throw new AppError('NO_IDENTITY', 409, 'No ONCHAINID exists yet — call prepare first.');
    }

    const topics = await this.requiredTopics(tokenSymbol);
    const missing: string[] = [];
    for (const topic of topics) {
      if (!(await this.identities.hasLiveClaim(identity, infra.claimIssuer, topic))) {
        missing.push(topic.toString());
      }
    }
    if (missing.length) {
      throw new AppError(
        'CLAIMS_NOT_SUBMITTED',
        409,
        'Required claims are not on-chain yet. The investor must submit them from their own wallet.',
        { missingTopics: missing },
      );
    }

    const token = await this.repo.requireToken(tokenSymbol);
    const registryAddress: string = await this.chain.token(token.address).identityRegistry();
    const registry = this.chain.identityRegistry(registryAddress, this.signers.get('agent'));
    const registryRead = this.chain.identityRegistry(registryAddress);

    let registered = (await registryRead.contains(address)) as boolean;
    if (!registered) {
      try {
        await this.tx.submit(`registerIdentity ${address} -> ${tokenSymbol}`, () =>
          registry.registerIdentity(
            address,
            identity,
            country ?? person?.country ?? 0,
          ) as Promise<ethers.ContractTransactionResponse>,
        );
      } catch (err) {
        throw chainFailure(err, `Could not register your identity for ${tokenSymbol}.`);
      }
      registered = true;
    }

    const verified = (await registryRead.isVerified(address)) as boolean;
    if (!verified) {
      await this.ensurePlatformIssuerTrusted(registryAddress, tokenSymbol);
    }
    const verifiedAfter = (await registryRead.isVerified(address)) as boolean;
    await this.repo.setVerified(primary, verifiedAfter);

    await this.audit.record(principal, tenant, {
      action: 'onboarding.identity_registered',
      target: address,
      params: { token: tokenSymbol, identity, verified: verifiedAfter },
    });

    if (!verifiedAfter) {
      throw new AppError(
        'NOT_VERIFIED_ON_CHAIN',
        502,
        `Your identity is registered for ${tokenSymbol} but the token does not treat you as verified. The claim issuer on this asset may not match the platform issuer.`,
        { token: tokenSymbol, identity },
      );
    }

    return { wallet: address, identity, registered, verified: verifiedAfter };
  }

  /**
   * Tokens deployed before the current ClaimIssuer address was set still trust
   * the old issuer. isVerified then stays false even with a live KYC claim.
   * If we own the TrustedIssuersRegistry, add the platform issuer.
   */
  private async ensurePlatformIssuerTrusted(registryAddress: string, tokenSymbol: string): Promise<void> {
    const infra = this.infra.require();
    const registryRead = this.chain.identityRegistry(registryAddress);
    const tirAddr: string = await registryRead.issuersRegistry();
    const tirRead = this.chain.trustedIssuersRegistry(tirAddr);
    const already = (await tirRead.isTrustedIssuer(infra.claimIssuer)) as boolean;
    if (already) return;

    const owner = ((await tirRead.owner()) as string).toLowerCase();
    const deployer = (await this.signers.addressFor('deployer')).toLowerCase();
    if (owner !== deployer) {
      throw new AppError(
        'CLAIM_ISSUER_NOT_TRUSTED',
        502,
        `${tokenSymbol} does not trust the platform claim issuer, so KYC claims cannot verify. A token owner must add the issuer to the trusted list.`,
        { token: tokenSymbol, claimIssuer: infra.claimIssuer },
      );
    }

    const topics = await this.requiredTopics(tokenSymbol);
    const tir = this.chain.trustedIssuersRegistry(tirAddr, this.signers.get('deployer'));
    try {
      await this.tx.submit(`addTrustedIssuer ${infra.claimIssuer} -> ${tokenSymbol}`, () =>
        tir.addTrustedIssuer(infra.claimIssuer, topics) as Promise<ethers.ContractTransactionResponse>,
      );
    } catch (err) {
      throw chainFailure(err, `Could not trust the platform claim issuer on ${tokenSymbol}.`);
    }
  }

  /** Where an investor stands, without sending anything. */
  async status(wallet: string, tokenSymbol: string): Promise<OnboardingStatus> {
    const infra = this.infra.require();
    const address = ethers.getAddress(wallet);
    const primary = await this.repo.resolvePrimaryWallet(address);
    const { investor: person, kycStatus } = await this.repo.resolveCompliance(primary);

    const identity = person?.onchainid ?? null;
    const deployed = identity ? await this.identities.hasCode(identity) : false;

    const topics = await this.requiredTopics(tokenSymbol);
    const claims = deployed
      ? await Promise.all(
          topics.map(async (topic) => ({
            topic: topic.toString(),
            present: await this.identities.hasLiveClaim(identity!, infra.claimIssuer, topic),
          })),
        )
      : topics.map((topic) => ({ topic: topic.toString(), present: false }));

    const token = await this.repo.requireToken(tokenSymbol);
    const registryAddress: string = await this.chain.token(token.address).identityRegistry();
    const registryRead = this.chain.identityRegistry(registryAddress);
    const [registered, verified] = await Promise.all([
      registryRead.contains(address) as Promise<boolean>,
      registryRead.isVerified(address) as Promise<boolean>,
    ]);

    return {
      wallet: address,
      identity,
      identityDeployed: deployed,
      kycStatus,
      claims,
      registeredInRegistry: registered,
      verified,
    };
  }
}

function chainFailure(err: unknown, fallback: string): AppError {
  if (err instanceof AppError) return err;
  const raw =
    (err as { shortMessage?: string; reason?: string; message?: string })?.shortMessage ??
    (err as { reason?: string })?.reason ??
    (err instanceof Error ? err.message : fallback);
  const text = String(raw);
  if (/not the owner/i.test(text)) {
    return new AppError(
      'CHAIN_SIGNER_MISMATCH',
      502,
      'The platform cannot create your on-chain identity: DEPLOYER_PRIVATE_KEY does not own the identity factory. Restart the API after pointing it at the Sepolia deployer key.',
    );
  }
  if (/insufficient funds/i.test(text)) {
    return new AppError(
      'CHAIN_INSUFFICIENT_FUNDS',
      502,
      'The platform wallet does not have enough Sepolia ETH to deploy your identity. Fund the deployer and try again.',
    );
  }
  return new AppError('CHAIN_TX_FAILED', 502, fallback, { reason: text.slice(0, 200) });
}
