import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { ChainService } from '@shared/chain/chain.service';
import { fromPaise, toPaise } from '@shared/money/money';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { TokensRepository } from '@modules/tokens/tokens.repository';
import { OnboardingService } from '@modules/onboarding/onboarding.service';
import { ManagersService } from '@modules/managers/managers.service';
import { OfferingsRepository } from './offerings.repository';
import { OfferingFeaturesRepository } from './offering-features.repository';

/**
 * The marketplace is cross-issuer by design, so a public read cannot be scoped
 * to a tenant — there is no session to scope it to. It runs as `platform` and
 * is gated on the offering's own visibility instead (see `requirePublic`).
 */
const PUBLIC: TenantContext = { kind: 'platform' };

/** Statuses whose asset page is world-readable. A draft is not yet an offer. */
const PUBLICLY_VISIBLE = new Set(['coming_soon', 'open', 'funded', 'closed']);

@Injectable()
export class OfferingFeaturesService {
  constructor(
    private readonly offerings: OfferingsRepository,
    private readonly repo: OfferingFeaturesRepository,
    private readonly tokens: TokensRepository,
    private readonly onboarding: OnboardingService,
    private readonly managers: ManagersService,
    private readonly chain: ChainService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resolve the offering through the TENANT.
   *
   * This is the tenant check for every feature below: another issuer's offering
   * 404s here, so none of the writes need to re-derive ownership.
   */
  private async requireOffering(tenant: TenantContext, offeringId: string) {
    const o = await this.offerings.findById(tenant, offeringId);
    if (!o) throw AppError.notFound('Offering', offeringId);
    return o;
  }

  /**
   * Resolve an offering for a PUBLIC (sessionless) read.
   *
   * The tenant check cannot apply here, so visibility does the work instead: a
   * draft offering 404s, because it is not yet an offer and its appraisals and
   * manager notes are internal. Anything already listed is world-readable —
   * that is what makes it a marketplace.
   */
  private async requirePublicOffering(offeringId: string) {
    const o = await this.offerings.findById(PUBLIC, offeringId);
    /* BOTH checks: a private placement can be `open` without being listed. */
    if (!o || o.visibility !== 'public' || !PUBLICLY_VISIBLE.has(o.status)) {
      throw AppError.notFound('Offering', offeringId);
    }
    return o;
  }

  /** Writers must be the owning issuer — investors read only. */
  private static requireIssuer(tenant: TenantContext): void {
    if (tenant.kind !== 'issuer' && tenant.kind !== 'platform') {
      throw AppError.forbidden('Only the issuer can change this offering.');
    }
  }

  /* ---- public asset page ------------------------------------------------ */

  /**
   * Everything the marketplace shows about one asset, for callers with no
   * session. The visibility gate is applied ONCE here and the four reads then
   * run as `platform`, which is why they take no tenant: a browser deciding
   * whether to invest is not a tenant of anything.
   */
  async publicValuations(offeringId: string) {
    await this.requirePublicOffering(offeringId);
    return this.readValuations(PUBLIC, offeringId);
  }

  async publicUpdates(offeringId: string) {
    await this.requirePublicOffering(offeringId);
    return this.readUpdates(PUBLIC, offeringId);
  }

  async publicBuyback(offeringId: string) {
    await this.requirePublicOffering(offeringId);
    return this.readBuyback(PUBLIC, offeringId);
  }

  async publicProposals(offeringId: string) {
    await this.requirePublicOffering(offeringId);
    return this.readProposals(PUBLIC, offeringId);
  }

  /* ---- valuations ------------------------------------------------------ */

  async listValuations(tenant: TenantContext, offeringId: string) {
    await this.requireOffering(tenant, offeringId);
    return this.readValuations(tenant, offeringId);
  }

  private async readValuations(tenant: TenantContext, offeringId: string) {
    const items = await this.repo.listValuations(tenant, offeringId);
    return {
      items: items.map((v) => ({
        id: v.id,
        totalValue: v.totalValue,
        note: v.note,
        source: v.source,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Record an appraisal.
   *
   * APPEND-ONLY: a valuation is a point-in-time statement, and NAV history is
   * what an investor uses to judge performance. Editing one would rewrite that
   * history, so there is no update path — only a newer entry.
   */
  async addValuation(
    principal: Principal,
    tenant: TenantContext,
    offeringId: string,
    input: { totalValue: string; note?: string; source?: string },
  ) {
    OfferingFeaturesService.requireIssuer(tenant);
    await this.requireOffering(tenant, offeringId);

    const row = await this.repo.addValuation(tenant, {
      offeringId,
      ...input,
      createdByEmail: principal.email,
    });
    await this.audit.record(principal, tenant, {
      action: 'offering.valuation',
      target: offeringId,
      params: { totalValue: input.totalValue, source: input.source ?? 'manual' },
    });
    return { id: row.id, totalValue: row.totalValue, createdAt: row.createdAt.toISOString() };
  }

  /* ---- manager updates -------------------------------------------------- */

  async listUpdates(tenant: TenantContext, offeringId: string) {
    await this.requireOffering(tenant, offeringId);
    return this.readUpdates(tenant, offeringId);
  }

  private async readUpdates(tenant: TenantContext, offeringId: string) {
    const items = await this.repo.listUpdates(tenant, offeringId);
    return {
      items: items.map((u) => ({
        id: u.id,
        title: u.title,
        body: u.body,
        managerId: u.managerId,
        createdAt: u.createdAt.toISOString(),
      })),
    };
  }

  async addUpdate(
    principal: Principal,
    tenant: TenantContext,
    offeringId: string,
    input: { title: string; body: string },
  ) {
    OfferingFeaturesService.requireIssuer(tenant);
    const offering = await this.requireOffering(tenant, offeringId);
    /* @Roles lets a 'manager' through, but the tenant check only proves the
       property belongs to their ISSUER. A manager may write only about the
       properties they actually operate — otherwise one manager can post in
       another's name on any of the issuer's assets. */
    await this.managers.assertOperates(principal, tenant, offering);

    const row = await this.repo.addUpdate(tenant, {
      offeringId,
      ...input,
      managerId: offering.managerId ?? undefined,
    });
    await this.audit.record(principal, tenant, {
      action: 'offering.update_posted',
      target: offeringId,
      params: { title: input.title },
    });
    return { id: row.id, title: row.title, createdAt: row.createdAt.toISOString() };
  }

  /* ---- buyback ---------------------------------------------------------- */

  async getBuyback(tenant: TenantContext, offeringId: string) {
    await this.requireOffering(tenant, offeringId);
    return this.readBuyback(tenant, offeringId);
  }

  private async readBuyback(tenant: TenantContext, offeringId: string) {
    const b = await this.repo.getBuyback(tenant, offeringId);
    if (!b || b.status !== 'open') return { open: false as const };
    return {
      open: true as const,
      pricePerToken: b.pricePerToken,
      maxTokens: b.maxTokens,
      tokensBought: b.tokensBought,
      /* null budget = unlimited; otherwise what is still purchasable. */
      remaining: b.maxTokens === null ? null : Math.max(0, b.maxTokens - b.tokensBought),
      sellerWallet: b.sellerWallet,
    };
  }

  /**
   * Open (or replace) the standing buy-back bid.
   *
   * NON-CUSTODIAL: this only publishes TERMS. The investor still transfers their
   * tokens from their own wallet to accept — the platform cannot pull them.
   */
  async openBuyback(
    principal: Principal,
    tenant: TenantContext,
    offeringId: string,
    input: { sellerWallet: string; pricePerToken: string; maxTokens?: number },
  ) {
    OfferingFeaturesService.requireIssuer(tenant);
    const offering = await this.requireOffering(tenant, offeringId);
    if (!offering.tokenSymbol) {
      throw AppError.conflict('NO_TOKEN', 'Deploy the token before opening a buy-back.');
    }

    const row = await this.repo.upsertBuyback(tenant, {
      offeringId,
      sellerWallet: input.sellerWallet,
      pricePerToken: input.pricePerToken,
      maxTokens: input.maxTokens ?? null,
    });
    await this.audit.record(principal, tenant, {
      action: 'offering.buyback_open',
      target: offeringId,
      params: { pricePerToken: input.pricePerToken, maxTokens: input.maxTokens ?? null },
    });
    return { open: true, pricePerToken: row.pricePerToken, maxTokens: row.maxTokens };
  }

  async closeBuyback(principal: Principal, tenant: TenantContext, offeringId: string) {
    OfferingFeaturesService.requireIssuer(tenant);
    await this.requireOffering(tenant, offeringId);

    const closed = await this.repo.closeBuyback(tenant, offeringId);
    if (!closed) {
      throw AppError.conflict('NO_OPEN_BUYBACK', 'There is no open buy-back for this offering.');
    }
    await this.audit.record(principal, tenant, {
      action: 'offering.buyback_close',
      target: offeringId,
    });
    return { open: false };
  }

  /* ---- governance ------------------------------------------------------- */

  async listProposals(tenant: TenantContext, offeringId: string) {
    await this.requireOffering(tenant, offeringId);
    return this.readProposals(tenant, offeringId);
  }

  private async readProposals(tenant: TenantContext, offeringId: string) {
    const rows = await this.repo.listProposals(tenant, offeringId);
    const items = await Promise.all(
      rows.map(async (p) => ({
        id: p.id,
        proposedManagerId: p.proposedManagerId,
        reason: p.reason,
        status: p.status,
        opensAt: p.opensAt.toISOString(),
        closesAt: p.closesAt.toISOString(),
        tally: await this.repo.tally(tenant, p.id),
      })),
    );
    return { items };
  }

  async proposeManager(
    principal: Principal,
    tenant: TenantContext,
    offeringId: string,
    input: { proposedManagerId: string; reason?: string; closesInDays: number },
  ) {
    OfferingFeaturesService.requireIssuer(tenant);
    await this.requireOffering(tenant, offeringId);
    /* A proposal naming a manager that does not exist can still pass a vote,
       and then installs nothing. Reject it at proposal time, not tally time. */
    await this.requireActiveManager(tenant, input.proposedManagerId);

    const closesAt = new Date(Date.now() + input.closesInDays * 86_400_000);
    const row = await this.repo.addProposal(tenant, {
      offeringId,
      proposedManagerId: input.proposedManagerId,
      reason: input.reason,
      closesAt,
      createdBy: principal.id,
    });
    await this.audit.record(principal, tenant, {
      action: 'governance.propose_manager',
      target: offeringId,
      params: { proposalId: row.id, proposedManagerId: input.proposedManagerId },
    });
    return { id: row.id, closesAt: closesAt.toISOString(), status: row.status };
  }

  /**
   * Close a vote and apply the outcome.
   *
   * Refuses before `closesAt`: closing early would let whoever controls the
   * button pick the moment the tally happens to favour them. A pass swaps the
   * manager; the claim is atomic so two concurrent closes cannot both decide.
   */
  async closeProposal(principal: Principal, tenant: TenantContext, proposalId: string) {
    OfferingFeaturesService.requireIssuer(tenant);

    const proposal = await this.repo.getProposal(tenant, proposalId);
    if (!proposal) throw AppError.notFound('Proposal', proposalId);
    if (proposal.status !== 'open') {
      throw AppError.conflict('NOT_OPEN', `Proposal is already ${proposal.status}.`);
    }
    if (proposal.closesAt.getTime() > Date.now()) {
      throw AppError.conflict('VOTING_OPEN', 'Voting has not closed yet.', {
        closesAt: proposal.closesAt.toISOString(),
      });
    }

    const tally = await this.repo.tally(tenant, proposalId);
    const passed = tally.for > tally.against;

    if (!(await this.repo.closeProposal(tenant, proposalId, passed))) {
      /* Someone else closed it between our read and our write. */
      throw AppError.conflict('NOT_OPEN', 'Proposal was already closed.');
    }
    if (passed) {
      await this.repo.assignManager(tenant, proposal.offeringId, proposal.proposedManagerId);
    }

    await this.audit.record(principal, tenant, {
      action: 'governance.close_proposal',
      target: proposal.offeringId,
      params: { proposalId, passed, ...tally },
    });
    return { id: proposalId, status: passed ? 'passed' : 'rejected', tally };
  }

  async assignManager(
    principal: Principal,
    tenant: TenantContext,
    offeringId: string,
    managerId: string | null,
  ) {
    OfferingFeaturesService.requireIssuer(tenant);
    await this.requireOffering(tenant, offeringId);
    if (managerId !== null) await this.requireActiveManager(tenant, managerId);
    await this.repo.assignManager(tenant, offeringId, managerId);
    await this.audit.record(principal, tenant, {
      action: 'offering.assign_manager',
      target: offeringId,
      params: { managerId },
    });
    return { offeringId, managerId };
  }

  private async requireActiveManager(tenant: TenantContext, managerId: string): Promise<void> {
    if (!(await this.repo.managerIsActive(tenant, managerId))) {
      throw AppError.notFound('Manager', managerId);
    }
  }

  /* ---- investor actions -------------------------------------------------- */

  /**
   * Cast (or revise) a vote on a manager-change proposal.
   *
   * Weight is the voter's ON-CHAIN balance, summed across every wallet they
   * have linked, and it is captured at vote time. Two consequences worth
   * stating: a non-holder has weight 0 and is refused outright, and selling
   * afterwards does not retroactively rewrite a tally that has already been
   * cast — the chain is the register, the vote is a snapshot of it.
   */
  async vote(connectedWallet: string, proposalId: string, choice: 'for' | 'against') {
    const primary = await this.onboarding.resolvePrimaryWallet(connectedWallet);
    const tenant: TenantContext = { kind: 'investor', investorWallet: primary };

    const proposal = await this.repo.getProposal(tenant, proposalId);
    if (!proposal) throw AppError.notFound('Proposal', proposalId);
    if (proposal.status !== 'open') {
      throw AppError.conflict('NOT_OPEN', 'This proposal is closed.');
    }
    if (proposal.closesAt.getTime() <= Date.now()) {
      throw AppError.conflict('VOTING_ENDED', 'Voting has ended for this proposal.');
    }

    const weight = await this.voteWeight(proposal.offeringId, primary);
    if (weight <= 0) {
      throw AppError.forbidden('Only holders of this asset can vote.');
    }

    await this.repo.upsertVote(tenant, { proposalId, wallet: primary, weight, choice });
    return {
      yourWeight: weight,
      yourChoice: choice,
      tally: await this.repo.tally(tenant, proposalId),
    };
  }

  /** Sum the on-chain balance across every wallet linked to this person. */
  private async voteWeight(offeringId: string, primaryWallet: string): Promise<number> {
    const offering = await this.offerings.findById(PUBLIC, offeringId);
    if (!offering?.tokenSymbol) return 0;

    const token = await this.tokens.requireAnyTenant(offering.tokenSymbol);
    const contract = this.chain.token(token.address);
    const addresses = await this.onboarding.walletsForPerson(primaryWallet);

    let total = 0n;
    for (const w of addresses) total += (await contract.balanceOf(w)) as bigint;
    /* decimals === 0 for these tokens, so the raw balance IS whole tokens. */
    return Number(total);
  }

  /**
   * Record a sell-back against the standing bid.
   *
   * NON-CUSTODIAL, and that is exactly why this endpoint has to verify rather
   * than trust: the platform cannot pull the investor's tokens, so the transfer
   * happens first, from the investor's own wallet, and they then tell us about
   * it. `txHash` is therefore an unverified claim from the counterparty until
   * we read the receipt — and the UI's cap on the amount is client-side only.
   * Booking a payout on an unverified hash would let anyone POST themselves
   * money for a transfer that was forged, oversized, or never happened.
   */
  async sellBack(
    connectedWallet: string,
    input: { tokenSymbol: string; tokens: number; txHash: string },
  ) {
    const primary = await this.onboarding.resolvePrimaryWallet(connectedWallet);
    const tenant: TenantContext = { kind: 'investor', investorWallet: primary };

    const offering = await this.offerings.findByTokenSymbol(PUBLIC, input.tokenSymbol);
    if (!offering) throw AppError.notFound('Offering for token', input.tokenSymbol);

    const bid = await this.repo.getBuyback(tenant, offering.id);
    if (!bid || bid.status !== 'open') {
      throw AppError.conflict('NO_OPEN_BUYBACK', 'There is no open buy-back for this asset.');
    }

    /* Verify against the CONNECTED wallet, not the primary: the tokens left
       whichever wallet actually signed the transfer. */
    await this.verifyTransferOnChain({
      symbol: input.tokenSymbol,
      from: connectedWallet,
      to: bid.sellerWallet,
      tokens: input.tokens,
      txHash: input.txHash,
    });

    /* Integer paise: price * quantity must be exact, never a float product. */
    const amountFiat = fromPaise(toPaise(bid.pricePerToken) * BigInt(input.tokens));
    const res = await this.repo.recordSale(tenant, {
      offeringId: offering.id,
      wallet: connectedWallet,
      tokens: input.tokens,
      pricePerToken: bid.pricePerToken,
      amountFiat: String(amountFiat),
      txHash: input.txHash,
    });
    if (!res.ok) throw AppError.conflict('SELLBACK_REJECTED', res.reason);

    return {
      offeringId: offering.id,
      tokens: input.tokens,
      pricePerToken: bid.pricePerToken,
      amountFiat,
      txHash: input.txHash,
    };
  }

  /**
   * Prove the transfer happened, for this exact amount, to this exact wallet.
   *
   * Ported unchanged in substance from the Express `verifyOnChainSellback`. It
   * matches a Transfer LOG on the token's own address rather than trusting the
   * transaction's `to` — a transfer can be made through a router or a multicall,
   * and the log is what the token itself emitted.
   */
  private async verifyTransferOnChain(v: {
    symbol: string;
    from: string;
    to: string;
    tokens: number;
    txHash: string;
  }): Promise<void> {
    const token = await this.tokens.requireAnyTenant(v.symbol);
    const receipt = await this.chain.provider.getTransactionReceipt(v.txHash);
    if (!receipt) {
      throw AppError.conflict(
        'TX_NOT_CONFIRMED',
        "That transaction isn't confirmed on-chain yet. Wait for it to mine and retry.",
      );
    }
    if (receipt.status !== 1) {
      throw new AppError('TX_FAILED', 400, 'That transaction failed on-chain.');
    }

    const contract = this.chain.token(token.address);
    const decimals = Number(await contract.decimals());
    const expected = ethers.parseUnits(String(v.tokens), decimals);
    const tokenAddress = token.address.toLowerCase();

    const matched = receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== tokenAddress) return false;
      let parsed: ethers.LogDescription | null = null;
      try {
        parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        return false;
      }
      return (
        parsed?.name === 'Transfer' &&
        String(parsed.args.from).toLowerCase() === v.from.toLowerCase() &&
        String(parsed.args.to).toLowerCase() === v.to.toLowerCase() &&
        (parsed.args.value as bigint) === expected
      );
    });
    if (!matched) {
      throw new AppError(
        'TX_DOES_NOT_MATCH',
        400,
        "That transaction isn't a matching transfer of the stated tokens to the seller wallet.",
      );
    }
  }
}
