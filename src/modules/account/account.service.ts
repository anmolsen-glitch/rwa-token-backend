/**
 * The investor-facing account: sign in, see where you are in the flow, submit
 * KYC, connect a wallet.
 *
 * THE FLOW (user decision, 2026-08-21):
 *
 *   sign up -> verify email -> KYC -> connect wallet -> ready
 *
 * Each step gates the next, and `AccountService.step()` is the single place
 * that decides which step someone is on. Clients render progress from that
 * rather than re-deriving it from a handful of booleans and drifting.
 */
import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { AppError } from '@shared/errors/app-error';
import { JwtService } from '@shared/auth/jwt.service';
import { AppConfig } from '@shared/config/app-config.service';
import { MAILER, type Mailer } from '@shared/mail/mailer';
import type { Account, Investor, OnboardingStep, OtpPurpose } from '@shared/db/schema';
import { AccountRepository } from './account.repository';

/** Same trick as admin login: constant-ish timing for unknown emails. */
const DUMMY_HASH = '$2b$12$fRSJok2nKiFL27Z8MOSUGuRF.TTmZ.OBgT6UFwstwKaTyF4o8.A/W';

export interface AccountView {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  kycStatus: string;
  kycNote: string | null;
  country: number | null;
  wallets: Array<{ address: string; verified: boolean; onchainid: string | null }>;
  /** Where the person is in the flow, and what unblocks them next. */
  step: OnboardingStep;
  nextAction: string;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /**
   * In non-production a FIXED code is used so signup/verify can be exercised
   * without an inbox. Production is always random — and `devCode` below is what
   * decides whether it is ever returned to the caller.
   */
  private newCode(): string {
    if (!this.config.isProduction) return '123456';
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  private async issueCode(email: string, purpose: OtpPurpose, subject: string): Promise<void> {
    const code = this.newCode();
    const ttlMs = this.config.get('OTP_TTL_MINUTES') * 60_000;
    await this.repo.upsertOtp(email, purpose, code, new Date(Date.now() + ttlMs));
    await this.mailer.send({
      to: email,
      subject,
      text: `Your verification code is ${code}. It expires in ${this.config.get('OTP_TTL_MINUTES')} minutes.`,
    });
  }

  /** Dev convenience only. Returning a code in production would defeat the point. */
  private devCode(): string | undefined {
    return this.config.isProduction ? undefined : '123456';
  }

  /**
   * Step 1. Creates the person, unverified, and emails a code.
   *
   * NO SESSION IS ISSUED — the email must be verified first, otherwise anyone
   * could sign up with someone else's address and hold a live session on it.
   */
  async signup(
    email: string,
    password: string,
    name?: string,
  ): Promise<{ email: string; needsVerification: true; devCode?: string }> {
    const normalized = email.trim().toLowerCase();

    if (await this.repo.byEmail(normalized)) {
      /* This DOES disclose that an email is registered. It is a deliberate
         trade: the alternative (pretend success) strands a real user who simply
         forgot they had an account, and the same fact is already discoverable
         via password reset on essentially every site. */
      throw AppError.conflict(
        'EMAIL_ALREADY_REGISTERED',
        'An account with that email already exists. Try logging in.',
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await this.repo.create(normalized, passwordHash, name?.trim() || null);
    await this.issueCode(normalized, 'verify', 'Verify your email');

    return { email: normalized, needsVerification: true, devCode: this.devCode() };
  }

  /** Step 1b. Confirm the code, mark verified, and issue the account session. */
  async verifyEmail(
    email: string,
    code: string,
  ): Promise<{ token: string; account: AccountView }> {
    const normalized = email.trim().toLowerCase();
    const account = await this.repo.byEmail(normalized);
    if (!account) throw AppError.notFound('Account');

    /* Idempotent: verifying twice returns a session rather than an error, so a
       double-submitted form does not strand the user. */
    if (!account.emailVerified) {
      const ok = await this.repo.consumeOtp(normalized, 'verify', code);
      if (!ok) {
        throw new AppError(
          'INVALID_CODE',
          400,
          'That code is invalid or expired. Request a new one.',
        );
      }
      await this.repo.markEmailVerified(account.id);
    }

    const fresh = (await this.repo.byId(account.id)) ?? account;
    const token = this.jwt.signAccount({ sub: fresh.id, email: fresh.email });
    const wallets = await this.repo.walletsFor(fresh.id);
    return { token, account: AccountService.view(fresh, wallets) };
  }

  /**
   * Re-send a verification code.
   *
   * Always reports success. Unlike signup — where the user is actively trying to
   * claim an address — this endpoint is trivially scriptable, so confirming
   * which emails exist here would hand over an enumeration oracle for free.
   */
  async resendVerification(email: string): Promise<{ ok: true; devCode?: string }> {
    const normalized = email.trim().toLowerCase();
    const account = await this.repo.byEmail(normalized);
    if (account && !account.emailVerified) {
      await this.issueCode(normalized, 'verify', 'Verify your email');
    }
    return { ok: true, devCode: this.devCode() };
  }

  /**
   * Start a password reset.
   *
   * ALWAYS reports success, whether or not the email exists. Password reset is
   * the classic account-enumeration oracle: it is unauthenticated, trivially
   * scriptable, and a different response for a registered address hands over
   * the whole user list. (Signup is the deliberate exception — see there.)
   */
  async forgotPassword(email: string): Promise<{ ok: true; devCode?: string }> {
    const normalized = email.trim().toLowerCase();
    const account = await this.repo.byEmail(normalized);
    if (account) {
      await this.issueCode(normalized, 'reset', 'Reset your password');
    }
    return { ok: true, devCode: this.devCode() };
  }

  /**
   * Finish a password reset and sign the person in.
   *
   * Every failure path returns the SAME message. Distinguishing "no such
   * account" from "wrong code" would re-open the enumeration hole that
   * forgotPassword() closes.
   */
  async resetPassword(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<{ token: string; account: AccountView }> {
    const normalized = email.trim().toLowerCase();
    const invalid = () =>
      new AppError('INVALID_CODE', 400, 'That code is invalid or expired. Request a new one.');

    const account = await this.repo.byEmail(normalized);
    if (!account) throw invalid();

    if (!(await this.repo.consumeOtp(normalized, 'reset', code))) throw invalid();

    await this.repo.setPassword(account.id, await bcrypt.hash(newPassword, 12));

    /*
     * A completed reset proves control of the inbox, which is exactly what
     * email verification asks for — so verify it here too. Otherwise someone
     * who never clicked the original link is stuck: they can reset their
     * password and still be blocked at step 1 of the flow.
     */
    if (!account.emailVerified) {
      await this.repo.markEmailVerified(account.id);
    }

    const fresh = (await this.repo.byId(account.id)) ?? account;
    const token = this.jwt.signAccount({ sub: fresh.id, email: fresh.email });
    const wallets = await this.repo.walletsFor(fresh.id);
    return { token, account: AccountService.view(fresh, wallets) };
  }

  /**
   * The single source of truth for flow position.
   *
   * Order matters: a person with a wallet but rejected KYC is on the KYC step,
   * not the wallet step — otherwise the UI would tell them they are done while
   * they cannot actually hold tokens.
   */
  static step(account: Account, wallets: Investor[]): OnboardingStep {
    if (!account.emailVerified) return 'verify_email';
    if (account.kycStatus !== 'completed') return 'kyc';
    if (wallets.length === 0) return 'connect_wallet';
    return 'ready';
  }

  private static nextAction(step: OnboardingStep, account: Account): string {
    switch (step) {
      case 'verify_email':
        return 'Verify your email address.';
      case 'kyc':
        if (account.kycStatus === 'none') return 'Submit your KYC details for review.';
        if (account.kycStatus === 'rejected')
          return `KYC was rejected${account.kycNote ? `: ${account.kycNote}` : ''}. You may re-submit.`;
        return 'Your KYC is under review — no action needed.';
      case 'connect_wallet':
        return 'Connect a wallet to receive tokens.';
      case 'ready':
        return 'You can browse offerings and invest.';
      default:
        return '';
    }
  }

  private static view(account: Account, wallets: Investor[]): AccountView {
    const step = AccountService.step(account, wallets);
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      emailVerified: account.emailVerified,
      kycStatus: account.kycStatus,
      /* Shown to the person about themselves — this is the rejection reason
         they need in order to fix and re-submit. */
      kycNote: account.kycNote,
      country: account.country,
      wallets: wallets.map((w) => ({
        address: w.wallet,
        verified: w.verified,
        onchainid: w.onchainid,
      })),
      step,
      nextAction: AccountService.nextAction(step, account),
    };
  }

  async login(email: string, password: string): Promise<{ token: string; account: AccountView }> {
    const account = await this.repo.byEmail(email);
    const ok = await bcrypt.compare(password, account?.passwordHash ?? DUMMY_HASH);

    /* One indistinguishable message — distinguishing unknown-email from
       wrong-password is an account-enumeration oracle. */
    if (!account || !ok) {
      throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password.');
    }

    const token = this.jwt.signAccount({ sub: account.id, email: account.email });
    const wallets = await this.repo.walletsFor(account.id);
    return { token, account: AccountService.view(account, wallets) };
  }

  async me(accountId: string): Promise<AccountView> {
    const account = await this.repo.byId(accountId);
    if (!account) throw AppError.unauthorized('Account no longer exists.');
    const wallets = await this.repo.walletsFor(accountId);
    return AccountService.view(account, wallets);
  }

  /**
   * Submit KYC for review. Step 2 — deliberately does NOT require a wallet.
   */
  async submitKyc(
    accountId: string,
    input: { country?: number; name?: string },
  ): Promise<AccountView> {
    const account = await this.repo.byId(accountId);
    if (!account) throw AppError.unauthorized('Account no longer exists.');

    if (account.kycStatus === 'completed') {
      throw AppError.conflict('KYC_ALREADY_APPROVED', 'Your KYC is already approved.');
    }
    if (account.kycStatus === 'applied' || account.kycStatus === 'verifying') {
      throw AppError.conflict('KYC_UNDER_REVIEW', 'Your KYC is already under review.');
    }

    await this.repo.submitKyc(accountId, input.country ?? null, input.name ?? null);
    return this.me(accountId);
  }

  /**
   * Link a wallet whose control was just proven by SIWE. Step 3.
   *
   * Requires approved KYC: the flow is sign up -> KYC -> connect wallet, and
   * linking earlier would produce a wallet that cannot be onboarded anyway.
   */
  async connectWallet(accountId: string, wallet: string): Promise<AccountView> {
    const account = await this.repo.byId(accountId);
    if (!account) throw AppError.unauthorized('Account no longer exists.');

    if (account.kycStatus !== 'completed') {
      throw new AppError(
        'KYC_NOT_APPROVED',
        403,
        'Complete KYC before connecting a wallet.',
        { kycStatus: account.kycStatus },
      );
    }

    try {
      await this.repo.linkWallet(accountId, wallet);
    } catch (err) {
      if (err instanceof Error && err.message === 'WALLET_OWNED_BY_ANOTHER_ACCOUNT') {
        throw AppError.conflict(
          'WALLET_ALREADY_LINKED',
          'That wallet is already linked to a different account.',
        );
      }
      throw err;
    }

    return this.me(accountId);
  }
}
