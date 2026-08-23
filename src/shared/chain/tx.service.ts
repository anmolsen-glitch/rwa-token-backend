/**
 * One place to send a transaction and wait for it.
 *
 * Ported from ../rwa-token-backend/src/lib/tx.ts. Every chain write goes
 * through here, so there is a single spot for uniform logging, nonce recovery,
 * and later gas strategy and retries.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { SignerService } from './signer.service';

export interface TxResult {
  hash: string;
  blockNumber: number | null;
  gasUsed: string | null;
}

@Injectable()
export class TxService {
  private readonly logger = new Logger(TxService.name);

  constructor(private readonly signers: SignerService) {}

  /**
   * @param label   human description for logs, e.g. "mint 500 MBWT -> 0xabc"
   * @param send    submits the tx and returns the response
   * @param onSent  called with the hash as soon as the tx is BROADCAST, before
   *                it is mined. Persist it here so a crash mid-wait can be
   *                recovered by checking the receipt later — otherwise a
   *                confirmed on-chain transfer can exist with nothing in the
   *                database pointing at it.
   */
  async submit(
    label: string,
    send: () => Promise<ethers.ContractTransactionResponse>,
    onSent?: (hash: string) => void | Promise<void>,
  ): Promise<TxResult> {
    let tx: ethers.ContractTransactionResponse;
    try {
      tx = await send();
    } catch (err) {
      /* A failed send (e.g. a revert caught at estimateGas) leaves the signer's
         cached nonce out of sync. Reset so the NEXT tx re-reads it — without
         this, one revert wedges every subsequent write until restart. */
      this.signers.resetNonces();
      throw err;
    }

    this.logger.log(`[tx] ${label} sent ${tx.hash}`);

    if (onSent) {
      try {
        await onSent(tx.hash);
      } catch (err) {
        /* The tx is already broadcast and cannot be recalled, so a failing hook
           must not abort the wait — but it means the DB may not know the hash. */
        this.logger.error({ err }, `[tx] ${label} onSent hook failed (continuing)`);
      }
    }

    const receipt = await tx.wait();
    this.logger.log(
      `[tx] ${label} mined block=${receipt?.blockNumber} gas=${receipt?.gasUsed?.toString()}`,
    );

    return {
      hash: tx.hash,
      blockNumber: receipt?.blockNumber ?? null,
      gasUsed: receipt?.gasUsed?.toString() ?? null,
    };
  }
}
