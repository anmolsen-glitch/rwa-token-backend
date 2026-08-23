/**
 * On-chain token operations — the platform's ERC-3643 agent powers.
 *
 * Ported from ../rwa-token-backend/src/services/operations.service.ts.
 *
 * These are the most consequential writes in the system: they move, freeze, and
 * destroy investors' holdings. Three properties are carried over deliberately:
 *
 *   - PRE-FLIGHT CHECKS. Mint verifies the recipient is a verified investor
 *     BEFORE sending, because T-REX reverts otherwise and a revert costs gas and
 *     produces a far worse error than a 409.
 *   - EVERY WRITE IS AUDITED, with the tx hash.
 *   - EVERY WRITE GOES THROUGH TxService, so a failed send resets the nonce and
 *     one revert cannot wedge every later transaction.
 *
 * NEW UNDER MULTI-TENANCY: the token is resolved through TokensRepository, which
 * is tenant-scoped. Express looked symbols up in a global address book, so an
 * agent could operate ANY token; here an issuer can only reach its own.
 */
import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { IdentityService, KYC_TOPIC } from '@shared/chain/identity.service';
import { InfraService } from '@shared/chain/infra.service';
import { ChainService } from '@shared/chain/chain.service';
import { SignerService } from '@shared/chain/signer.service';
import { TxService, type TxResult } from '@shared/chain/tx.service';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { TokensRepository } from './tokens.repository';

export interface OperationOutcome {
  ok: true;
  action: string;
  symbol: string;
  tx: TxResult;
  [k: string]: unknown;
}

@Injectable()
export class TokenOperationsService {
  constructor(
    private readonly tokensRepo: TokensRepository,
    private readonly chain: ChainService,
    private readonly signers: SignerService,
    private readonly tx: TxService,
    private readonly audit: AuditService,
    private readonly identities: IdentityService,
    private readonly infra: InfraService,
  ) {}

  /** Token contract bound to the AGENT key — platform-managed compliance. */
  private async agentToken(tenant: TenantContext, symbol: string) {
    const rec = await this.tokensRepo.require(tenant, symbol);
    const reader = this.chain.token(rec.address);
    const writer = this.chain.token(rec.address, this.signers.get('agent'));
    return { rec, reader, writer };
  }

  private async identityRegistry(address: string) {
    const irAddress: string = await this.chain.token(address).identityRegistry();
    return this.chain.identityRegistry(irAddress);
  }

  /**
   * Wrap a chain call so a revert surfaces its REAL reason.
   *
   * ethers buries the revert string; returning a generic "mint failed" makes
   * every on-chain problem look identical and un-debuggable.
   */
  private static async onChain<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as { shortMessage?: string; reason?: string; message?: string };
      throw new AppError('CHAIN_CALL_FAILED', 502, `${label} failed.`, {
        detail: e.reason ?? e.shortMessage ?? e.message ?? String(err),
      });
    }
  }

  async mint(
    principal: Principal,
    tenant: TenantContext,
    symbol: string,
    investor: string,
    amount: string,
  ): Promise<OperationOutcome> {
    const { rec, reader, writer } = await this.agentToken(tenant, symbol);

    return TokenOperationsService.onChain('Mint', async () => {
      const ir = await this.identityRegistry(rec.address);
      /* Pre-flight: T-REX reverts for an unverified holder. Catching it here
         costs nothing and gives an actionable message instead of a revert. */
      if (!(await ir.isVerified(investor))) {
        throw AppError.conflict(
          'INVESTOR_NOT_VERIFIED',
          'Investor is not verified for this asset. Onboard them before minting.',
          { investor, symbol: rec.symbol },
        );
      }

      const decimals = Number(await reader.decimals());
      const value = ethers.parseUnits(String(amount), decimals);

      const tx = await this.tx.submit(`mint ${amount} ${rec.symbol} -> ${investor}`, () =>
        writer.mint(investor, value) as Promise<ethers.ContractTransactionResponse>,
      );

      const outcome: OperationOutcome = {
        ok: true,
        action: 'mint',
        symbol: rec.symbol,
        investor,
        amount: String(amount),
        newBalance: ethers.formatUnits(await reader.balanceOf(investor), decimals),
        tx,
      };
      await this.record(principal, tenant, 'mint', investor, rec.symbol, { amount }, tx);
      return outcome;
    });
  }

  async burn(
    principal: Principal,
    tenant: TenantContext,
    symbol: string,
    wallet: string,
    amount: string,
  ): Promise<OperationOutcome> {
    const { rec, reader, writer } = await this.agentToken(tenant, symbol);

    return TokenOperationsService.onChain('Burn', async () => {
      const decimals = Number(await reader.decimals());
      const value = ethers.parseUnits(String(amount), decimals);
      const tx = await this.tx.submit(`burn ${amount} ${rec.symbol} <- ${wallet}`, () =>
        writer.burn(wallet, value) as Promise<ethers.ContractTransactionResponse>,
      );
      await this.record(principal, tenant, 'burn', wallet, rec.symbol, { amount }, tx);
      return {
        ok: true,
        action: 'burn',
        symbol: rec.symbol,
        wallet,
        amount: String(amount),
        newBalance: ethers.formatUnits(await reader.balanceOf(wallet), decimals),
        tx,
      };
    });
  }

  /**
   * Freeze or unfreeze an address.
   *
   * `caseId` tags the audit row with the legal case that authorises it. A
   * freeze taken under a court order and not linked to that order is a freeze
   * with no recorded justification.
   */
  async setAddressFrozen(
    principal: Principal,
    tenant: TenantContext,
    symbol: string,
    wallet: string,
    frozen: boolean,
    caseId?: string,
  ): Promise<OperationOutcome> {
    const { rec, writer } = await this.agentToken(tenant, symbol);
    return TokenOperationsService.onChain(frozen ? 'Freeze' : 'Unfreeze', async () => {
      const tx = await this.tx.submit(
        `${frozen ? 'freeze' : 'unfreeze'} ${wallet} on ${rec.symbol}`,
        () => writer.setAddressFrozen(wallet, frozen) as Promise<ethers.ContractTransactionResponse>,
      );
      await this.record(principal, tenant, frozen ? 'freeze' : 'unfreeze', wallet, rec.symbol, {}, tx, caseId);
      return { ok: true, action: frozen ? 'freeze' : 'unfreeze', symbol: rec.symbol, wallet, frozen, tx };
    });
  }

  async freezePartial(
    principal: Principal,
    tenant: TenantContext,
    symbol: string,
    wallet: string,
    amount: string,
    freeze: boolean,
  ): Promise<OperationOutcome> {
    const { rec, reader, writer } = await this.agentToken(tenant, symbol);
    return TokenOperationsService.onChain('Partial freeze', async () => {
      const decimals = Number(await reader.decimals());
      const value = ethers.parseUnits(String(amount), decimals);
      const tx = await this.tx.submit(
        `${freeze ? 'freeze' : 'unfreeze'} ${amount} ${rec.symbol} of ${wallet}`,
        () =>
          (freeze
            ? writer.freezePartialTokens(wallet, value)
            : writer.unfreezePartialTokens(wallet, value)) as Promise<ethers.ContractTransactionResponse>,
      );
      await this.record(
        principal, tenant, freeze ? 'freeze-partial' : 'unfreeze-partial', wallet, rec.symbol, { amount }, tx,
      );
      return {
        ok: true,
        action: freeze ? 'freeze-partial' : 'unfreeze-partial',
        symbol: rec.symbol,
        wallet,
        amount: String(amount),
        frozenTokens: ethers.formatUnits(await reader.getFrozenTokens(wallet), decimals),
        tx,
      };
    });
  }

  /**
   * Forced transfer — the court-order power.
   *
   * Bypasses compliance rules, but T-REX still requires the RECIPIENT to be a
   * verified investor, so an unverified destination reverts. Checked up front.
   */
  async forcedTransfer(
    principal: Principal,
    tenant: TenantContext,
    symbol: string,
    from: string,
    to: string,
    amount: string,
  ): Promise<OperationOutcome> {
    const { rec, reader, writer } = await this.agentToken(tenant, symbol);

    return TokenOperationsService.onChain('Forced transfer', async () => {
      const ir = await this.identityRegistry(rec.address);
      if (!(await ir.isVerified(to))) {
        throw AppError.conflict(
          'RECIPIENT_NOT_VERIFIED',
          `Recipient is not a verified investor for ${rec.symbol}.`,
          { to, symbol: rec.symbol },
        );
      }
      const decimals = Number(await reader.decimals());
      const value = ethers.parseUnits(String(amount), decimals);
      const tx = await this.tx.submit(
        `forcedTransfer ${amount} ${rec.symbol} ${from} -> ${to}`,
        () => writer.forcedTransfer(from, to, value) as Promise<ethers.ContractTransactionResponse>,
      );
      await this.record(principal, tenant, 'force-transfer', from, rec.symbol, { to, amount }, tx);
      return { ok: true, action: 'force-transfer', symbol: rec.symbol, from, to, amount: String(amount), tx };
    });
  }

  async setPaused(
    principal: Principal,
    tenant: TenantContext,
    symbol: string,
    paused: boolean,
  ): Promise<OperationOutcome> {
    const { rec, writer } = await this.agentToken(tenant, symbol);
    return TokenOperationsService.onChain(paused ? 'Pause' : 'Unpause', async () => {
      const tx = await this.tx.submit(`${paused ? 'pause' : 'unpause'} ${rec.symbol}`, () =>
        (paused ? writer.pause() : writer.unpause()) as Promise<ethers.ContractTransactionResponse>,
      );
      await this.record(principal, tenant, paused ? 'pause' : 'unpause', rec.symbol, rec.symbol, {}, tx);
      return { ok: true, action: paused ? 'pause' : 'unpause', symbol: rec.symbol, paused, tx };
    });
  }

  /**
   * Revoke an investor's KYC claim — blocks them across EVERY asset.
   *
   * ISSUER-SIDE: ClaimIssuer.revokeClaimBySignature, signed by our claim key.
   * It needs no investor key, so it works with KMS and in the non-custodial
   * model, unlike a custodial removeClaim on the investor's identity. That is
   * the whole reason this is the revocation path.
   *
   * Idempotent-ish by nature: a wallet with no live claim gives a clear 409
   * rather than a revert, and revoking an already-revoked signature is a no-op
   * on-chain.
   */
  async revokeKyc(
    principal: Principal,
    tenant: TenantContext,
    wallet: string,
    caseId?: string,
  ): Promise<OperationOutcome> {
    return TokenOperationsService.onChain('Revoke claim', async () => {
      const infra = this.infra.require();

      const identityAddress: string = await this.identities
        .idFactory(infra.idFactory)
        .getIdentity(wallet);
      if (!identityAddress || identityAddress === ethers.ZeroAddress) {
        throw AppError.notFound('ONCHAINID for wallet', wallet);
      }

      /* The claim id is deterministic: keccak(issuer, topic). */
      const claimId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'uint256'],
          [infra.claimIssuer, KYC_TOPIC],
        ),
      );
      const claim = await this.identities.identity(identityAddress).getClaim(claimId);
      const signature = claim[3] as string;
      if (!signature || signature === '0x') {
        throw AppError.conflict('NO_CLAIM', 'No KYC claim present to revoke for that wallet.', {
          wallet,
        });
      }

      const issuer = this.identities.claimIssuer(
        infra.claimIssuer,
        this.signers.get('claimIssuer'),
      );
      const tx = await this.tx.submit(
        `revokeClaim ${wallet}`,
        () =>
          issuer.revokeClaimBySignature(signature) as Promise<ethers.ContractTransactionResponse>,
      );

      await this.audit.record(principal, tenant, {
        action: 'revoke-claim',
        target: wallet,
        params: { onchainid: identityAddress },
        txHash: tx.hash,
        caseId,
      });
      /* No symbol: revocation is IDENTITY-level, so it blocks the investor on
         every asset at once rather than on one token. */
      return { ok: true, action: 'revoke-claim', symbol: '*', wallet, onchainid: identityAddress, tx };
    });
  }

  private record(
    principal: Principal,
    tenant: TenantContext,
    action: string,
    target: string,
    symbol: string,
    params: Record<string, unknown>,
    tx: TxResult,
    caseId?: string,
  ): Promise<void> {
    return this.audit.record(principal, tenant, {
      action,
      target,
      params: { symbol, ...params },
      txHash: tx.hash,
      caseId,
    });
  }
}
