/**
 * Orders: reserve → pay → settle (mint).
 *
 * Ported from ../rwa-token-backend/src/services/subscriptions.service.ts. The
 * concurrency properties are the reason this file exists, and each is carried
 * over rather than re-derived:
 *
 *   - RESERVATION is atomic under an offering row lock (repository), so two
 *     investors cannot both buy the last tokens.
 *   - SETTLEMENT is claimed atomically (paid → settling), because the investor's
 *     own "pay" call and the provider's webhook can arrive together and both
 *     minting would double-issue.
 *   - The payment provider is called OUTSIDE the lock. Holding a row lock across
 *     an external HTTP call serialises every order behind that vendor.
 *
 * Money is compared in integer paise (shared/money), never floats — the
 * difference decides whether a minimum raise was met.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import { AppError } from '@shared/errors/app-error';
import { fromPaise, toPaise } from '@shared/money/money';
import { AuditService } from '@shared/audit/audit.service';
import { AppConfig } from '@shared/config/app-config.service';
import { ChainService } from '@shared/chain/chain.service';
import { SignerService } from '@shared/chain/signer.service';
import { TxService } from '@shared/chain/tx.service';
import {
  PAYMENT_PROVIDER_TOKEN,
  type PaymentEvent,
  type PaymentProvider,
} from '@shared/payments/payment.provider';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { OfferingsRepository } from '@modules/offerings/offerings.repository';
import { SubscriptionsRepository } from './subscriptions.repository';

/**
 * How long an unpaid reservation holds allocation. Generous on purpose — see
 * expireStaleReservations.
 */
export const ORDER_TTL_MINUTES = 60;

/**
 * Dev-only fixed rate: 1 paise = 10^10 wei.
 *
 * A real deployment prices against an oracle. Pinning it here keeps the crypto
 * path testable without one, and makes the assumption impossible to miss when
 * that changes — there is exactly one constant to replace.
 */
const WEI_PER_PAISE = 10n ** 10n;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly repo: SubscriptionsRepository,
    private readonly offerings: OfferingsRepository,
    private readonly config: AppConfig,
    private readonly tokensRepo: TokensRepository,
    private readonly chain: ChainService,
    private readonly signers: SignerService,
    private readonly tx: TxService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly payments: PaymentProvider,
  ) {}

  /** Human-ish, collision-resistant, and safe to show an investor. */
  private static newReference(wallet: string): string {
    return `ord_${wallet.slice(2, 8).toLowerCase()}_${randomBytes(6).toString('hex')}`;
  }

  /**
   * Reserve an allocation and open a payment.
   *
   * Order of operations matters: everything slow and read-only happens BEFORE
   * the lock, the contended decision happens INSIDE it, and the external
   * payment call happens AFTER it.
   */
  async createOrder(
    principal: Principal,
    tenant: TenantContext,
    wallet: string,
    offeringId: string,
    amountFiat: number,
  ) {
    const offering = await this.offerings.findById(tenant, offeringId);
    if (!offering) throw AppError.notFound('Offering', offeringId);
    if (offering.status !== 'open' || !offering.tokenSymbol) {
      throw AppError.conflict('OFFERING_NOT_OPEN', 'This offering is not open for investment.');
    }

    const minInvestment = Number(offering.minInvestment);
    if (!Number.isFinite(amountFiat) || amountFiat < minInvestment) {
      throw new AppError(
        'BELOW_MINIMUM',
        400,
        `Minimum investment is ${minInvestment} ${offering.currency}.`,
      );
    }

    const token = await this.tokensRepo.require(tenant, offering.tokenSymbol);
    const pricePerToken = Number(offering.pricePerToken);

    /*
     * Who is this, and are they accredited? Resolved across every wallet the
     * PERSON controls — caps are per-investor, so a second address must not
     * reset them.
     */
    const person = await this.repo.personFor(wallet);

    /*
     * ACCREDITED-ONLY GATE. The off-chain mirror of the on-chain ACCREDITED
     * claim requirement — defence in depth. A direct API caller cannot skip it,
     * and even if they did, settlement's isVerified check would block the mint
     * because the token demands the claim.
     *
     * Reads offerings.requires_accreditation, NOT token_plan: the two disagree
     * on some rows and the plan silently drops the gate.
     */
    if (offering.requiresAccreditation && !person.accredited) {
      throw new AppError(
        'ACCREDITATION_REQUIRED',
        403,
        `${token.symbol} is an accredited-investor-only offering.`,
        { token: token.symbol },
      );
    }

    /*
     * Per-investor cap for THIS investor's tier, in tokens. Stored in currency,
     * so divide by price. null = uncapped.
     */
    const capCurrency = person.accredited
      ? offering.accreditedMaxInvestment ?? offering.maxInvestment
      : offering.maxInvestment;
    const maxTokensPerInvestor =
      capCurrency !== null && capCurrency !== undefined && pricePerToken > 0
        ? Math.floor(Number(capCurrency) / pricePerToken)
        : null;
    const tokensWanted = Math.floor(amountFiat / pricePerToken);
    if (tokensWanted < 1) {
      throw new AppError('AMOUNT_TOO_SMALL', 400, 'Amount is too small for one token.');
    }

    /* Must be verified for THIS asset before we take money. Settlement checks
       again, but failing here means the investor never gets charged. */
    const irAddress: string = await this.chain.token(token.address).identityRegistry();
    const verified = (await this.chain.identityRegistry(irAddress).isVerified(wallet)) as boolean;
    if (!verified) {
      throw new AppError(
        'NOT_ONBOARDED',
        403,
        `Complete onboarding for ${token.symbol} before investing.`,
        { token: token.symbol },
      );
    }

    const reference = SubscriptionsService.newReference(wallet);

    /*
     * How much this person ALREADY holds on-chain, across all their wallets.
     * Read BEFORE the lock on purpose: it is slow (one RPC call per wallet) and
     * effectively monotonic, and holding a row lock across the network would
     * serialise every order for this offering behind it.
     */
    let heldByPerson = 0;
    if (maxTokensPerInvestor !== null) {
      const reader = this.chain.token(token.address);
      const decimals = Number(await reader.decimals());
      for (const w of person.wallets) {
        const bal = (await reader.balanceOf(w)) as bigint;
        heldByPerson += Number(ethers.formatUnits(bal, decimals));
      }
    }

    /* THE contended step. Caps and supply are re-read inside the row lock. */
    const result = await this.repo.createOrderAtomic(tenant, {
      offeringId: offering.id,
      tokenAddress: token.address,
      tokensTotal: Math.floor(Number(offering.targetRaise) / pricePerToken),
      tokensWanted,
      maxTokensPerInvestor,
      heldByPerson,
      personWallets: person.wallets,
      sub: {
        reference,
        wallet,
        tokenSymbol: token.symbol,
        amountFiat,
        currency: offering.currency,
        pricePerToken,
        paymentProvider: this.payments.name,
      },
    });

    if (!result.ok) {
      throw AppError.conflict(
        result.reason === 'supply' ? 'INSUFFICIENT_SUPPLY' : 'PER_INVESTOR_LIMIT',
        result.reason === 'supply'
          ? `Only ${result.remaining} ${token.symbol} remaining in this offering.`
          : `This exceeds your per-investor limit of ${maxTokensPerInvestor} ${token.symbol}` +
            `${person.accredited ? ' (accredited tier)' : ''}. You can buy at most ${result.youCanBuy} more.`,
        { ...result, maxTokensPerInvestor, accredited: person.accredited },
      );
    }

    /* Payment setup is an EXTERNAL call — outside the lock. If it fails, release
       the reservation, or it holds supply forever. */
    let checkout;
    try {
      checkout = await this.payments.createCheckout({
        reference,
        amountFiat,
        currency: offering.currency,
        wallet,
        description: `${tokensWanted} ${token.symbol} — ${offering.name}`,
      });
    } catch (err) {
      await this.repo.update(result.sub.id, {
        status: 'cancelled',
        error: 'payment setup failed',
      });
      throw err;
    }

    await this.repo.update(result.sub.id, { paymentRef: checkout.paymentRef });
    await this.audit.record(principal, tenant, {
      action: 'order.create',
      target: wallet,
      params: { offeringId, amountFiat, tokens: tokensWanted, reference },
    });

    return {
      ...result.sub,
      paymentRef: checkout.paymentRef,
      checkoutUrl: checkout.checkoutUrl,
      tokens: tokensWanted,
    };
  }

  /** Investor-initiated capture (the synchronous "pull" path). */
  async pay(principal: Principal, tenant: TenantContext, wallet: string, reference: string) {
    const sub = await this.repo.byReference(tenant, reference);
    if (!sub) throw AppError.notFound('Order', reference);
    if (sub.wallet.toLowerCase() !== wallet.toLowerCase()) {
      throw AppError.forbidden('Not your order.');
    }
    if (sub.status !== 'pending_payment') {
      throw AppError.conflict('ORDER_NOT_PAYABLE', `Order is already ${sub.status}.`);
    }

    const capture = await this.payments.capture(sub.paymentRef ?? '');
    if (!capture.ok) {
      await this.repo.update(sub.id, {
        status: 'failed',
        error: capture.error ?? 'payment declined',
      });
      throw new AppError('PAYMENT_FAILED', 402, 'Payment failed.', { detail: capture.error });
    }

    await this.repo.update(sub.id, { status: 'paid' });
    await this.audit.record(principal, tenant, {
      action: 'order.paid',
      target: wallet,
      params: { reference },
    });
    return this.afterPaid(sub.id);
  }

  /**
   * What happens once an order is `paid` — escrow or settle.
   *
   * An offering with a `minimum_raise` is ESCROWED: the money is held and
   * nothing is minted until the raise closes, because a raise that fails must
   * return everyone's money rather than leave them holding tokens in an asset
   * that was never funded.
   *
   * The late-payment case is the subtle one. A payment landing AFTER an
   * escrowed offering closed missed the settle-vs-refund decision entirely.
   * Without the check below the order would sit in `paid` forever — close does
   * not re-run for it — so the money is returned instead.
   */
  private async afterPaid(id: string) {
    const order = await this.repo.byId(id);
    if (!order) return { status: 'failed', reason: 'order vanished' };

    const offering = await this.offerings.findById({ kind: 'platform' }, order.offeringId);
    const escrowed = offering?.minimumRaise != null;
    if (!escrowed) return this.settle(id);

    if (offering!.status === 'funded' || offering!.status === 'cancelled') {
      await this.refundOrder(order);
      return { status: 'refunded', reason: 'payment arrived after the raise closed' };
    }
    /* Held. closeOffering decides. */
    return { status: 'escrowed' };
  }

  /**
   * The asynchronous "push" path — a verified provider webhook.
   *
   * No Principal: the actor is the provider. Idempotent by status, on top of the
   * event-id replay protection in webhook_events.
   */
  async handlePaymentEvent(ev: PaymentEvent): Promise<{ ok: boolean; reason?: string }> {
    const sub = await this.repo.byPaymentRef(ev.paymentRef);
    if (!sub) return { ok: false, reason: 'unknown payment ref' };

    if (ev.type === 'captured') {
      if (sub.status === 'pending_payment') {
        await this.repo.update(sub.id, { status: 'paid' });
      }
      await this.afterPaid(sub.id);
      return { ok: true };
    }

    if (ev.type === 'failed') {
      /* Only a still-unpaid order may be failed by a webhook — never one that
         has already settled, where tokens have moved. */
      if (sub.status === 'pending_payment') {
        await this.repo.update(sub.id, { status: 'failed', error: 'payment failed (webhook)' });
      }
      return { ok: true };
    }

    /* refunded — provider-initiated, e.g. a chargeback. */
    if (sub.status === 'paid' || sub.status === 'failed') {
      await this.repo.update(sub.id, { status: 'refunded' });
    } else {
      this.logger.warn(
        { reference: sub.reference, status: sub.status },
        'refund webhook for an order that is not refundable — tokens may already be issued',
      );
    }
    return { ok: true };
  }

  /**
   * Mint against a paid order.
   *
   * Claimed atomically (paid → settling): the investor's pay call and the
   * webhook can land together, and both minting would double-issue.
   */
  async settle(id: string): Promise<{ status: string; txHash?: string; reason?: string }> {
    if (!(await this.repo.claimForSettlement(id))) {
      return { status: 'not-claimed', reason: 'already settling or not paid' };
    }

    const order = await this.repo.byId(id);
    if (!order) return { status: 'failed', reason: 'order vanished' };

    try {
      const token = await this.tokensRepo.requireAnyTenant(order.tokenSymbol);
      const writer = this.chain.token(token.address, this.signers.get('agent'));
      const decimals = Number(await this.chain.token(token.address).decimals());
      const value = ethers.parseUnits(String(order.tokens), decimals);

      const tx = await this.tx.submit(
        `settle ${order.reference}: mint ${order.tokens} ${token.symbol} -> ${order.wallet}`,
        () => writer.mint(order.wallet, value) as Promise<ethers.ContractTransactionResponse>,
        /* Persist the hash BEFORE waiting: a crash mid-wait must not leave a
           confirmed on-chain mint with nothing in the DB pointing at it. */
        (hash) => this.repo.update(id, { txHash: hash }),
      );

      await this.repo.update(id, { status: 'settled', txHash: tx.hash });
      return { status: 'settled', txHash: tx.hash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      /* Back to `paid`, NOT `failed`: the money was taken, so this order must
         stay retryable and visible rather than looking resolved. */
      await this.repo.update(id, { status: 'paid', error: `settlement failed: ${message}` });
      this.logger.error({ err, orderId: id }, 'settlement failed — order returned to paid');
      return { status: 'paid', reason: message };
    }
  }

  list(tenant: TenantContext, wallet: string) {
    return this.repo.listForWallet(tenant, wallet).then((items) => ({ items }));
  }

  /** Back-office reconciliation list. Tenant-scoped by RLS, newest first. */
  listAll(tenant: TenantContext, limit = 200) {
    return this.repo.listRecent(tenant, Math.min(limit, 500)).then((items) => ({ items }));
  }

  /**
   * Where an order's crypto payment must be sent, and how much.
   *
   * The seller's own wallet when the offering names one (non-custodial: the
   * money goes to the party selling), else the platform's collection wallet.
   */
  cryptoQuote(sellerWallet: string | null | undefined, amountFiat: string) {
    const payTo =
      sellerWallet && ethers.isAddress(sellerWallet)
        ? ethers.getAddress(sellerWallet)
        : ethers.getAddress(this.config.get('CRYPTO_PAYTO_WALLET'));
    return { payToWallet: payTo, amountWei: toPaise(amountFiat) * WEI_PER_PAISE };
  }

  /**
   * Pay an order in crypto, by pointing at a transfer already made.
   *
   * NON-CUSTODIAL, so — exactly as with the buy-back sell path — the hash is an
   * UNVERIFIED CLAIM from the payer until the receipt is read. Every field is
   * checked against the chain: sender, recipient, amount, and success. Booking
   * a payment on an unverified hash would let anyone mint themselves tokens by
   * quoting somebody else's transaction.
   */
  async payWithCrypto(
    principal: Principal,
    tenant: TenantContext,
    wallet: string,
    reference: string,
    txHash: string,
  ) {
    const sub = await this.repo.byReference(tenant, reference);
    if (!sub) throw AppError.notFound('Order', reference);
    if (sub.wallet.toLowerCase() !== wallet.toLowerCase()) {
      throw AppError.forbidden('Not your order.');
    }
    if (sub.status !== 'pending_payment') {
      throw AppError.conflict('ORDER_NOT_PAYABLE', `Order is already ${sub.status}.`);
    }

    /* One payment transaction settles at most one order. */
    const dup = await this.repo.byPaymentRef(txHash);
    if (dup && dup.id !== sub.id) {
      throw AppError.conflict(
        'TX_ALREADY_USED',
        'That payment transaction has already been used for another order.',
      );
    }

    const offering = await this.offerings.findById(tenant, sub.offeringId);
    const { payToWallet, amountWei } = this.cryptoQuote(offering?.sellerWallet, sub.amountFiat);

    const [tx, receipt] = await Promise.all([
      this.chain.provider.getTransaction(txHash),
      this.chain.provider.getTransactionReceipt(txHash),
    ]);
    if (!tx || !receipt) {
      throw AppError.conflict(
        'TX_NOT_CONFIRMED',
        "That payment isn't confirmed on-chain yet. Wait for it to mine and retry.",
      );
    }
    if (receipt.status !== 1) {
      throw new AppError('TX_FAILED', 400, 'That payment transaction failed on-chain.');
    }
    if ((tx.from ?? '').toLowerCase() !== wallet.toLowerCase()) {
      throw new AppError('TX_WRONG_SENDER', 400, 'That payment was not sent from your wallet.');
    }
    if (!tx.to || tx.to.toLowerCase() !== payToWallet.toLowerCase()) {
      throw new AppError(
        'TX_WRONG_RECIPIENT',
        400,
        "That payment was not sent to this offering's payment wallet.",
      );
    }
    if (tx.value < amountWei) {
      throw new AppError(
        'TX_UNDERPAID',
        400,
        `Underpaid: this order needs ${ethers.formatEther(amountWei)} coin.`,
        { requiredWei: amountWei.toString(), sentWei: tx.value.toString() },
      );
    }

    /* Record the tx as the payment reference, then take the shared paid path. */
    await this.repo.update(sub.id, { paymentRef: txHash, status: 'paid' });
    await this.audit.record(principal, tenant, {
      action: 'order.pay_crypto',
      target: wallet,
      params: { reference, txHash, amountWei: amountWei.toString() },
    });
    return this.afterPaid(sub.id);
  }

  /**
   * Refund a captured order.
   *
   * Claimed atomically (paid|failed -> refunding), the mirror of the settlement
   * claim, so concurrent closes cannot both call the provider for the same
   * order. A provider failure releases the claim back to `paid` so a re-run can
   * retry — a failed refund must stay VISIBLE, never be silently reported done.
   */
  private async refundOrder(order: { id: string; paymentRef: string | null }): Promise<boolean> {
    if (!(await this.repo.claimForRefund(order.id))) {
      /* Someone else owns it, or it is already terminal. */
      return (await this.repo.byId(order.id))?.status === 'refunded';
    }

    let result: { ok: boolean; error?: string };
    try {
      result = await this.payments.refund(order.paymentRef ?? '');
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!result.ok) {
      await this.repo.update(order.id, {
        status: 'paid',
        error: result.error ?? 'refund failed',
      });
      return false;
    }
    await this.repo.update(order.id, { status: 'refunded' });
    return true;
  }

  /**
   * Close an escrowed offering: settle everyone, or refund everyone.
   *
   * If the escrowed total meets `minimum_raise` every paid order is minted and
   * the offering is marked funded; otherwise all are refunded and it is
   * cancelled. An order whose mint is blocked at settlement — the investor lost
   * verification, say — is refunded rather than left stranded.
   *
   * SAFE UNDER CONCURRENCY AND RE-RUNNABLE, in this order:
   *   1. the outcome is committed atomically FIRST, so only one close decides
   *      and from that moment new orders are rejected and late payments refund;
   *   2. per-order settle/refund use their own atomic claims, so nothing
   *      double-mints or double-refunds across overlapping runs;
   *   3. orders left behind by a failure stay in `paid`, and re-running follows
   *      the outcome ALREADY RECORDED rather than re-deciding — a second close
   *      must never reach a different verdict than the first.
   */
  async closeOffering(principal: Principal, tenant: TenantContext, offeringId: string) {
    const offering = await this.offerings.findById(tenant, offeringId);
    if (!offering) throw AppError.notFound('Offering', offeringId);
    if (offering.minimumRaise == null) {
      throw new AppError(
        'NOT_ESCROWED',
        400,
        'This offering has no minimum raise — orders settle on payment, so there is nothing to close.',
      );
    }

    const escrowed = await this.repo.byOfferingStatus(offeringId, 'paid');
    const alreadyClosed = offering.status === 'funded' || offering.status === 'cancelled';
    if (alreadyClosed && escrowed.length === 0) {
      throw AppError.conflict(
        'ALREADY_CLOSED',
        `Offering is already ${offering.status} and has no unprocessed orders.`,
      );
    }

    /* Decided in integer paise so float drift can never flip the outcome. */
    const raisedPaise = escrowed.reduce((sum, o) => sum + toPaise(o.amountFiat), 0n);
    const minimumPaise = toPaise(offering.minimumRaise);
    const met = alreadyClosed ? offering.status === 'funded' : raisedPaise >= minimumPaise;

    if (!alreadyClosed) {
      if (!(await this.repo.claimOfferingClosed(offeringId, met ? 'funded' : 'cancelled'))) {
        throw AppError.conflict(
          'CLOSE_IN_PROGRESS',
          'Another request is closing this offering. Re-run to process any leftovers.',
        );
      }
    }

    const settled: string[] = [];
    const refunded: string[] = [];
    const failedRefunds: string[] = [];

    for (const order of escrowed) {
      if (met) {
        try {
          const after = await this.settle(order.id);
          if (after.status === 'settled') {
            settled.push(order.reference);
            continue;
          }
        } catch {
          /* Mint blocked — fall through and return the money. */
        }
      }
      if (await this.refundOrder(order)) refunded.push(order.reference);
      else failedRefunds.push(order.reference);
    }

    await this.audit.record(principal, tenant, {
      action: 'offering.close',
      target: offeringId,
      params: {
        met,
        raisedFiat: fromPaise(raisedPaise),
        minimum: fromPaise(minimumPaise),
        orders: escrowed.length,
        rerun: alreadyClosed,
      },
    });

    return {
      outcome: met ? ('funded' as const) : ('cancelled' as const),
      raisedFiat: fromPaise(raisedPaise),
      minimum: fromPaise(minimumPaise),
      settled,
      refunded,
      /* NOT silently dropped: these stayed `paid`. Re-run close to retry. */
      failedRefunds,
    };
  }

  /**
   * Release abandoned checkouts.
   *
   * `createOrder` reserves allocation up front and parks the order in
   * `pending_payment`. Nothing released it if the buyer closed the tab, so the
   * reservation was held forever — counting against both the offering's supply
   * and that buyer's per-investor cap. Six abandoned 50-token orders were
   * enough to report "you can buy at most 0 more" to someone holding 200 of a
   * 500 cap (observed 2026-07-24 on the Express app).
   *
   * The TTL is generous on purpose. It is measured from order CREATION, and the
   * only cost of waiting longer is allocation sitting idle — whereas expiring
   * too eagerly cancels an order somebody is actively paying for.
   */
  async expireStaleReservations(minutes = ORDER_TTL_MINUTES) {
    const stale = await this.repo.stalePendingPayment(minutes);
    let released = 0;
    for (const order of stale) {
      const reason = `reservation expired after ${minutes}m without payment`;
      /* Conditional UPDATE: a payment landing mid-scan always wins. */
      if (!(await this.repo.expirePendingPayment(order.id, reason))) continue;
      released += 1;
    }
    if (released > 0) {
      this.logger.log({ scanned: stale.length, released }, 'released abandoned reservations');
    }
    return { scanned: stale.length, released };
  }

  /**
   * Recover orders stuck mid-settlement.
   *
   * `settling` means we claimed the order and then the process died before
   * recording the outcome. The tx hash is persisted at BROADCAST time, so the
   * chain can answer what actually happened:
   *
   *   receipt success        -> the mint landed; mark settled
   *   receipt reverted       -> dead; requeue as `paid`
   *   no receipt, in mempool -> still pending; leave it for the next scan
   *   no receipt, unknown    -> dropped, or we died before broadcast; requeue
   *
   * Guessing in either direction is worse than waiting: marking settled without
   * a receipt invents tokens, and requeueing a mint that landed issues twice.
   */
  async recoverStaleSettlements(minutes = 10) {
    const stale = await this.repo.staleSettling(minutes);
    let settled = 0;
    let requeued = 0;
    let pending = 0;

    for (const order of stale) {
      if (order.txHash) {
        let receipt: ethers.TransactionReceipt | null = null;
        try {
          receipt = await this.chain.provider.getTransactionReceipt(order.txHash);
        } catch {
          pending += 1; // RPC hiccup — do not guess
          continue;
        }
        if (receipt?.status === 1) {
          await this.repo.update(order.id, { status: 'settled' });
          settled += 1;
          continue;
        }
        if (!receipt) {
          let inMempool: ethers.TransactionResponse | null = null;
          try {
            inMempool = await this.chain.provider.getTransaction(order.txHash);
          } catch {
            /* unknown — fall through to requeue */
          }
          if (inMempool) {
            pending += 1;
            continue;
          }
        }
      }
      await this.repo.update(order.id, {
        status: 'paid',
        error: 'settlement interrupted — recovered to paid',
      });
      requeued += 1;

      /* A non-escrow order has no closeOffering to retry it — retry now. */
      const offering = await this.offerings.findById({ kind: 'platform' }, order.offeringId);
      if (offering?.minimumRaise == null) {
        await this.settle(order.id).catch(() => undefined);
      }
    }

    if (stale.length > 0) {
      this.logger.log({ scanned: stale.length, settled, requeued, pending }, 'settlement recovery scan');
    }
    return { scanned: stale.length, settled, requeued, pending };
  }
}
