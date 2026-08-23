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
import { AppConfig } from '@shared/config/app-config.service';
import { ChainService } from '@shared/chain/chain.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { OfferingsRepository } from '@modules/offerings/offerings.repository';
import { OfferingViewService } from '@modules/offerings/offering-view.service';
import { OnboardingService } from '@modules/onboarding/onboarding.service';
import { AmlService } from '@modules/compliance/aml.service';
import { SiweService } from '@modules/wallet/siwe.service';

const PLATFORM: TenantContext = { kind: 'platform' };

/* Reads only — the lockup check mirrors what the compliance module will enforce
   when the investor actually submits the transfer from their own wallet. */
const LOCKUP_MODULE_ABI = [
  'function isLocked(address compliance, address wallet) view returns (bool)',
  'function getLockupEnd(address compliance, address wallet) view returns (uint256)',
];

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
    private readonly config: AppConfig,
    private readonly views: OfferingViewService,
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
    /* The ENRICHED view, same as the public marketplace — the portal renders
       supply/raised/NAV stats, not the raw row. */
    return { accredited, items: await this.views.enrichAll(rows) };
  }

  /**
   * Secondary-transfer pre-flight.
   *
   * The transfer itself is signed in the investor's own wallet (non-custodial);
   * this only validates and EXPLAINS before they spend gas. Every reason the
   * chain would revert for — paused asset, frozen wallets, unverified
   * recipient, insufficient unfrozen balance, lock-in — is collected rather
   * than failing on the first, so the UI can show all of them at once.
   *
   * Reads use the CONNECTED wallet, not the person's aggregate: the transfer
   * will be signed by exactly this address, so its balance is the one that
   * matters.
   */
  async previewTransfer(connectedWallet: string, symbol: string, toRaw: string, amount: number) {
    const rec = await this.tokens.require(PLATFORM, symbol);
    const from = connectedWallet.toLowerCase();

    let to: string;
    try {
      to = ethers.getAddress(toRaw).toLowerCase();
    } catch {
      throw new AppError('INVALID_RECIPIENT', 400, 'Recipient is not a valid wallet address.');
    }
    if (to === from) {
      throw new AppError('SELF_TRANSFER', 400, "You can't transfer to your own sending wallet.");
    }

    /* A record can outlive its chain (redeploys in dev). Distinguish "asset
       not deployed here" from a preview that would misreport every check. */
    const code = await this.chain.provider.getCode(rec.address);
    if (!code || code === '0x') {
      throw new AppError(
        'TOKEN_NOT_DEPLOYED',
        503,
        `Asset "${rec.symbol}" isn't deployed on the current chain.`,
        { symbol: rec.symbol },
      );
    }

    const token = this.chain.token(rec.address);
    const decimals = Number(await token.decimals());
    const value = ethers.parseUnits(String(amount), decimals);
    const reasons: string[] = [];

    if ((await token.paused()) as boolean) reasons.push('Trading is paused for this asset.');
    if ((await token.isFrozen(from)) as boolean) reasons.push('Your wallet is frozen.');

    const available =
      ((await token.balanceOf(from)) as bigint) - ((await token.getFrozenTokens(from)) as bigint);
    if (value > available) {
      reasons.push(
        `Amount exceeds your available balance (${ethers.formatUnits(available, decimals)} ${rec.symbol}).`,
      );
    }

    const registry = this.chain.identityRegistry((await token.identityRegistry()) as string);
    if (!((await registry.isVerified(to)) as boolean)) {
      reasons.push(
        'Recipient is not a verified investor for this asset — they must complete KYC + onboarding first.',
      );
    }
    if ((await token.isFrozen(to)) as boolean) reasons.push('Recipient wallet is frozen.');

    let lockupEnd = 0;
    const lockupModule = this.config.get('LOCKUP_MODULE');
    if (lockupModule) {
      try {
        const compliance = (await token.compliance()) as string;
        const lockup = new ethers.Contract(lockupModule, LOCKUP_MODULE_ABI, this.chain.provider);
        lockupEnd = Number(await lockup.getLockupEnd(compliance, from));
        if ((await lockup.isLocked(compliance, from)) as boolean) {
          reasons.push(
            `Your tokens are in the lock-in period until ${new Date(lockupEnd * 1000).toISOString().slice(0, 10)}.`,
          );
        }
      } catch {
        /* module not bound to this token / read failed — skip the lock-in check */
      }
    }

    return {
      ok: reasons.length === 0,
      reasons,
      symbol: rec.symbol,
      to,
      amount,
      available: Number(ethers.formatUnits(available, decimals)),
      lockupEnd,
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
