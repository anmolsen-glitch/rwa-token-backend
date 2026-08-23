/**
 * Sign-In With Ethereum (EIP-4361).
 *
 * Ported from ../rwa-token-backend/src/services/investorAuth.service.ts.
 *
 *   1. nonce(address)            -> store a one-time nonce, return the exact
 *                                   message the wallet must sign.
 *   2. verify(address, sig)      -> rebuild that message, recover the signer,
 *                                   consume the nonce, issue an investor session.
 *
 * The signature proves control of the private key without revealing it — which
 * is exactly why this remains the right primitive under the non-custodial model
 * (CLAUDE.md §12).
 */
import { Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { ethers } from 'ethers';
import { DbService } from '@shared/db/db.service';
import { investorNonces } from '@shared/db/schema';
import { AppConfig } from '@shared/config/app-config.service';
import { AppError } from '@shared/errors/app-error';

const SIWE_STATEMENT =
  'Sign in to the RWA Investor Portal. This request will not trigger a blockchain transaction or cost gas.';

@Injectable()
export class SiweService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  /**
   * The exact EIP-4361 message the wallet signs.
   *
   * domain / URI / chain id come from SERVER config, never the request: a
   * SIWE-aware wallet shows the real requesting site, so a phishing origin
   * displays as a mismatch. The server rebuilds this byte-for-byte at verify
   * time from the stored nonce and timestamps.
   */
  buildMessage(address: string, nonce: string, issuedAt: Date, expiresAt: Date): string {
    return [
      `${this.config.get('SIWE_DOMAIN')} wants you to sign in with your Ethereum account:`,
      ethers.getAddress(address),
      '',
      SIWE_STATEMENT,
      '',
      `URI: ${this.config.get('SIWE_URI')}`,
      'Version: 1',
      `Chain ID: ${this.config.get('SIWE_CHAIN_ID')}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
    ].join('\n');
  }

  /** Whole seconds: EIP-4361 timestamps must round-trip through Postgres exactly. */
  private static nowFlooredToSecond(): Date {
    const d = new Date();
    d.setMilliseconds(0);
    return d;
  }

  async requestNonce(addressRaw: string) {
    if (!ethers.isAddress(addressRaw)) {
      throw new AppError('INVALID_ADDRESS', 400, 'Invalid wallet address.');
    }
    const address = addressRaw.toLowerCase();
    /* EIP-4361 requires alphanumeric, >= 8 chars. 16 random bytes -> 32 hex. */
    const nonce = ethers.hexlify(ethers.randomBytes(16)).slice(2);
    const issuedAt = SiweService.nowFlooredToSecond();
    const expiresAt = new Date(issuedAt.getTime() + this.config.get('NONCE_TTL_SECONDS') * 1000);

    await this.db.worker('siwe: issue nonce', (tx) =>
      tx
        .insert(investorNonces)
        .values({ address, nonce, issuedAt, expiresAt })
        .onConflictDoUpdate({
          target: investorNonces.address,
          set: { nonce, issuedAt, expiresAt },
        }),
    );

    return { address, nonce, message: this.buildMessage(address, nonce, issuedAt, expiresAt) };
  }

  /**
   * Consume the nonce and check the signature recovers `address`.
   *
   * The DELETE ... RETURNING is atomic and filters on expiry, so the nonce is
   * one-time-use and replay-safe even under concurrent verifies: exactly one
   * caller gets the row. Checking-then-deleting would race.
   */
  async consumeAndRecover(addressRaw: string, signature: string): Promise<string> {
    if (!ethers.isAddress(addressRaw)) {
      throw new AppError('INVALID_ADDRESS', 400, 'Invalid wallet address.');
    }
    if (typeof signature !== 'string' || !signature.startsWith('0x')) {
      throw new AppError('INVALID_SIGNATURE', 400, 'Invalid signature.');
    }
    const address = addressRaw.toLowerCase();

    const [row] = await this.db.worker('siwe: consume nonce', (tx) =>
      tx
        .delete(investorNonces)
        .where(and(eq(investorNonces.address, address), gt(investorNonces.expiresAt, sql`now()`)))
        .returning(),
    );
    if (!row?.issuedAt) {
      throw AppError.unauthorized('No valid nonce — request a new one and try again.');
    }

    const message = this.buildMessage(address, row.nonce, row.issuedAt, row.expiresAt);
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      throw AppError.unauthorized('Signature verification failed.');
    }
    if (recovered.toLowerCase() !== address) {
      throw AppError.unauthorized('Signature does not match the wallet address.');
    }
    return address;
  }
}
