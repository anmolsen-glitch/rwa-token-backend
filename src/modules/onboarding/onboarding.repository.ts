/**
 * Onboarding reads/writes.
 *
 * Uses db.worker() rather than db.scoped(): onboarding acts on the PERSON
 * (platform-global identity), and the compliance officer driving it may belong
 * to an issuer whose cap table the investor has not joined yet — by definition,
 * since joining is what onboarding accomplishes. Scoping here would make the
 * first onboarding of any investor impossible.
 *
 * The authorization that matters happens at the guard (@Roles) and is audited
 * by the service; this is not an unguarded back door.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { accounts, investors, offerings, tokens, wallets, type Investor, type Token } from '@shared/db/schema';
import { AppError } from '@shared/errors/app-error';
import { AppConfig } from '@shared/config/app-config.service';

@Injectable()
export class OnboardingRepository {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfig,
  ) {}

  /** A linked wallet resolves to the person's primary wallet; else itself. */
  async resolvePrimaryWallet(address: string): Promise<string> {
    const [row] = await this.db.worker('onboarding: resolve primary wallet', (tx) =>
      tx
        .select({ primary: wallets.primaryWallet })
        .from(wallets)
        .where(sql`lower(${wallets.address}) = lower(${address})`)
        .limit(1),
    );
    return row?.primary ?? address.toLowerCase();
  }

  /**
   * Every wallet linked to one person, including the primary itself.
   *
   * Used for balance-weighted governance: one person is one voter however many
   * wallets they hold the asset across, so the weight is the SUM. Reading only
   * the connected wallet would let the same holding vote twice by reconnecting.
   */
  async walletsForPerson(primaryWallet: string): Promise<string[]> {
    const rows = await this.db.worker('onboarding: wallets for person', (tx) =>
      tx
        .select({ address: wallets.address })
        .from(wallets)
        .where(sql`lower(${wallets.primaryWallet}) = lower(${primaryWallet})`),
    );
    const all = new Set(rows.map((r) => r.address.toLowerCase()));
    all.add(primaryWallet.toLowerCase());
    return [...all];
  }

  /** Which person a wallet already belongs to, if any. */
  async walletLink(address: string): Promise<{ primaryWallet: string } | undefined> {
    const [row] = await this.db.worker('onboarding: wallet link lookup', (tx) =>
      tx
        .select({ primaryWallet: wallets.primaryWallet })
        .from(wallets)
        .where(sql`lower(${wallets.address}) = lower(${address})`)
        .limit(1),
    );
    return row;
  }

  /** Attach a wallet to a person. Screening decision recorded alongside. */
  async linkWallet(primaryWallet: string, address: string, screening: string): Promise<void> {
    await this.db.worker('onboarding: link wallet', (tx) =>
      tx.insert(wallets).values({
        address: address.toLowerCase(),
        primaryWallet: primaryWallet.toLowerCase(),
        screening,
      }),
    );
  }

  async getInvestor(primaryWallet: string): Promise<Investor | undefined> {
    const [row] = await this.db.worker('onboarding: load investor', (tx) =>
      tx
        .select()
        .from(investors)
        .where(sql`lower(${investors.wallet}) = lower(${primaryWallet})`)
        .limit(1),
    );
    return row;
  }

  /**
   * KYC and accreditation are properties of the PERSON (accounts), not the wallet
   * row. When account_id is set, accounts.* is authoritative — investors.* is
   * only a legacy mirror and may be stale after link-wallet.
   */
  async resolveCompliance(primaryWallet: string): Promise<{
    investor: Investor | undefined;
    kycStatus: string;
    accreditationStatus: string;
    country: number | null;
  }> {
    const investor = await this.getInvestor(primaryWallet);
    if (!investor) {
      return { investor: undefined, kycStatus: 'none', accreditationStatus: 'none', country: null };
    }
    if (!investor.accountId) {
      return {
        investor,
        kycStatus: investor.kycStatus,
        accreditationStatus: investor.accreditationStatus ?? 'none',
        country: investor.country,
      };
    }
    const [account] = await this.db.worker('onboarding: load person compliance', (tx) =>
      tx.select().from(accounts).where(eq(accounts.id, investor.accountId!)).limit(1),
    );
    if (!account) {
      return {
        investor,
        kycStatus: investor.kycStatus,
        accreditationStatus: investor.accreditationStatus ?? 'none',
        country: investor.country,
      };
    }
    return {
      investor,
      kycStatus: account.kycStatus,
      accreditationStatus: account.accreditationStatus,
      country: account.country ?? investor.country,
    };
  }

  async accountCompliance(accountId: string): Promise<{
    kycStatus: string;
    accreditationStatus: string;
    country: number | null;
  } | null> {
    const [account] = await this.db.worker('onboarding: load account compliance', (tx) =>
      tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
    );
    if (!account) return null;
    return {
      kycStatus: account.kycStatus,
      accreditationStatus: account.accreditationStatus,
      country: account.country,
    };
  }

  async setOnchainId(primaryWallet: string, onchainid: string): Promise<void> {
    await this.db.worker('onboarding: record onchainid', (tx) =>
      tx
        .update(investors)
        .set({ onchainid, updatedAt: new Date() })
        .where(sql`lower(${investors.wallet}) = lower(${primaryWallet})`),
    );
  }

  async setVerified(primaryWallet: string, verified: boolean): Promise<void> {
    await this.db.worker('onboarding: record verified', (tx) =>
      tx
        .update(investors)
        .set({ verified, updatedAt: new Date() })
        .where(sql`lower(${investors.wallet}) = lower(${primaryWallet})`),
    );
  }

  async isAccredited(primaryWallet: string): Promise<boolean> {
    const { accreditationStatus } = await this.resolveCompliance(primaryWallet);
    return accreditationStatus === 'accredited';
  }

  /**
   * Does any offering for this token require the ACCREDITED claim?
   *
   * Reads `offerings.requires_accreditation`, the authoritative column. An
   * earlier version of this read `token_plan ->> 'requiresAccreditation'`,
   * which is WRONG: the plan carries that key on some rows and disagrees with
   * the column (goa-villa has column=true, plan=false), so the gate silently
   * dropped for exactly the offering that needed it.
   */
  async tokenRequiresAccreditation(tokenSymbol: string): Promise<boolean> {
    const rows = await this.db.worker('onboarding: accreditation requirement', (tx) =>
      tx
        .select({ id: offerings.id })
        .from(offerings)
        .where(
          and(
            sql`upper(${offerings.tokenSymbol}) = upper(${tokenSymbol})`,
            eq(offerings.requiresAccreditation, true),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  /** The token record for the ACTIVE network, or a 404/503. */
  async requireToken(symbol: string): Promise<Token> {
    const network = this.config.get('NETWORK');
    const [row] = await this.db.worker('onboarding: load token', (tx) =>
      tx
        .select()
        .from(tokens)
        .where(and(eq(tokens.network, network), sql`upper(${tokens.symbol}) = upper(${symbol})`))
        .limit(1),
    );
    if (!row) {
      throw new AppError('TOKEN_NOT_ON_CHAIN', 503, `Token "${symbol}" is not deployed on ${network}.`, {
        symbol,
        network,
      });
    }
    return row;
  }
}
