/**
 * Investor self-service: holdings, the assets they can see, and their wallets.
 *
 * Ported from ../rwa-token-backend/src/services/investor.service.ts
 * (portfolio / listWallets / linkWallet) and the investor `offerings` route.
 *
 * Everything here is keyed on the PERSON, not the connected wallet. Someone who
 * holds an asset across three addresses owns one position, and showing them a
 * third of it because they happened to connect a different wallet would be
 * wrong in the most alarming possible way.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { ChainService } from '@shared/chain/chain.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { OfferingsRepository } from '@modules/offerings/offerings.repository';
import { OnboardingService } from '@modules/onboarding/onboarding.service';
import { AmlService } from '@modules/compliance/aml.service';
import { SiweService } from '@modules/wallet/siwe.service';

const PLATFORM: TenantContext = { kind: 'platform' };

export interface Holding {
  symbol: string;
  token: string;
  balance: string;
  verified: boolean;
  frozen: boolean;
  frozenTokens: string;
  /** Set when the chain could not be read — see the note in `portfolio`. */
  unavailable?: true;
}

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly tokens: TokensRepository,
    private readonly offerings: OfferingsRepository,
    private readonly onboarding: OnboardingService,
    private readonly aml: AmlService,
    private readonly siwe: SiweService,
    private readonly chain: ChainService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Holdings across every asset and every linked wallet.
   *
   * Read from the CHAIN rather than the indexed balances: this is the one place
   * an investor checks what they actually own, and a lagging or reorg-confused
   * indexer must not be able to tell someone their tokens are gone.
   *
   * An RPC failure yields `unavailable: true` for that asset, NOT a confident
   * zero. "You hold nothing" and "we could not check" look identical in a UI
   * that renders 0, and only one of them is a reason to panic.
   */
  async portfolio(connectedWallet: string): Promise<{ items: Holding[] }> {
    const primary = await this.onboarding.resolvePrimaryWallet(connectedWallet);
    const wallets = await this.onboarding.walletsForPerson(primary);
    const tokens = await this.tokens.list(PLATFORM);

    const items = await Promise.all(
      tokens.map(async (rec): Promise<Holding> => {
        try {
          const token = this.chain.token(rec.address);
          const registryAddress: string = await token.identityRegistry();
          const registry = this.chain.identityRegistry(registryAddress);
          const decimals = Number(await token.decimals());

          let balance = 0n;
          let frozenTokens = 0n;
          let verified = false;
          let frozen = false;
          for (const wallet of wallets) {
            balance += (await token.balanceOf(wallet)) as bigint;
            frozenTokens += (await token.getFrozenTokens(wallet)) as bigint;
            if ((await registry.isVerified(wallet)) as boolean) verified = true;
            if ((await token.isFrozen(wallet)) as boolean) frozen = true;
          }

          return {
            symbol: rec.symbol,
            token: rec.address,
            balance: ethers.formatUnits(balance, decimals),
            verified,
            frozen,
            frozenTokens: ethers.formatUnits(frozenTokens, decimals),
          };
        } catch (err) {
          this.logger.warn({ err, symbol: rec.symbol }, 'portfolio: chain read failed');
          return {
            symbol: rec.symbol,
            token: rec.address,
            balance: '0',
            verified: false,
            frozen: false,
            frozenTokens: '0',
            unavailable: true,
          };
        }
      }),
    );
    return { items };
  }

  /**
   * Assets this investor may see: everything public, plus private placements
   * they are eligible for.
   *
   * Private placements are restricted to accredited investors, so eligibility
   * is decided from the person's own accreditation — never from a query param.
   */
  async offeringsFor(connectedWallet: string) {
    const primary = await this.onboarding.resolvePrimaryWallet(connectedWallet);
    const accredited = await this.onboarding.isAccredited(primary);

    const rows = await this.offerings.listVisibleToInvestor(accredited);
    return {
      accredited,
      items: rows.map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        visibility: o.visibility,
        tokenSymbol: o.tokenSymbol,
        location: o.location,
        currency: o.currency,
        pricePerToken: o.pricePerToken,
        minInvestment: o.minInvestment,
        targetRaise: o.targetRaise,
        yieldPct: o.yieldPct,
        image: o.image,
        requiresAccreditation: o.requiresAccreditation,
      })),
    };
  }

  async wallets(connectedWallet: string) {
    const primary = await this.onboarding.resolvePrimaryWallet(connectedWallet);
    const wallets = await this.onboarding.walletsForPerson(primary);
    return { primaryWallet: primary, wallets };
  }

  /**
   * Link an additional wallet to the signed-in person.
   *
   * The new wallet must PROVE CONTROL by signing — this is the difference
   * between "I own this address" and "I typed this address". Without it, anyone
   * could attach a wallet they merely know of and inherit its holdings into
   * their own portfolio view, or worse, have someone else's assets counted
   * toward their caps.
   *
   * It then inherits the person's KYC and ONCHAINID, so no re-KYC — which is
   * exactly why the AML screen below is not optional.
   */
  async linkWallet(
    principal: Principal,
    tenant: TenantContext,
    connectedWallet: string,
    address: string,
    signature: string,
  ) {
    /* Recovers the address from the signature over a stored nonce, and burns
       the nonce — so a captured signature cannot be replayed. */
    const proven = await this.siwe.consumeAndRecover(address, signature);
    const primary = await this.onboarding.resolvePrimaryWallet(connectedWallet);

    if (proven === primary) {
      throw AppError.conflict('ALREADY_PRIMARY', "That's already your primary wallet.");
    }
    if ((await this.onboarding.walletsForPerson(primary)).includes(proven)) {
      throw AppError.conflict('ALREADY_LINKED', 'That wallet is already linked to your account.');
    }

    const accountId = principal.accountId ?? primary;
    /* Screened BEFORE linking: a sanctions or severe-risk hit must not be able
       to attach itself to a verified identity and inherit its standing. */
    const screen = await this.aml.screenForLink(proven, accountId, null);
    if (screen.decision === 'blocked') {
      await this.audit.record(principal, tenant, {
        action: 'wallet.link_blocked',
        target: primary,
        params: { attempted: proven, decision: screen.decision },
      });
      throw AppError.forbidden('That wallet failed sanctions / AML screening and cannot be linked.');
    }

    await this.onboarding.adminLinkWallet(principal, tenant, primary, proven);
    /* Fold the newly linked wallet into the person's aggregate standing. */
    await this.aml.recomputeStatus(accountId);

    return {
      primaryWallet: primary,
      linked: proven,
      wallets: await this.onboarding.walletsForPerson(primary),
    };
  }
}
