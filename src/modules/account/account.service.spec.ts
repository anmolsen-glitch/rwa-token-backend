/**
 * The investor flow: sign up -> verify email -> KYC -> connect wallet -> ready.
 *
 * `step()` is the single place that decides where someone is. Clients render
 * from it, so an ordering mistake here shows up as a UI that tells people they
 * are finished when they cannot actually hold tokens.
 */
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './account.service';
import type { AccountRepository } from './account.repository';
import type { JwtService } from '@shared/auth/jwt.service';
import type { AppConfig } from '@shared/config/app-config.service';
import type { Mailer } from '@shared/mail/mailer';
import type { Account, Investor } from '@shared/db/schema';
import { AppError } from '@shared/errors/app-error';

const D = new Date('2026-01-01T00:00:00Z');

const account = (over: Partial<Account> = {}): Account =>
  ({
    id: '7',
    email: 'p@example.com',
    passwordHash: 'x',
    name: 'Person',
    emailVerified: true,
    kycStatus: 'completed',
    kycNote: null,
    kycSubmittedAt: D,
    kycRejectedAt: null,
    kycVersion: '1',
    country: 356,
    createdAt: D,
    updatedAt: D,
    ...over,
  }) as Account;

const wallet = (): Investor => ({ wallet: '0xabc', verified: true, onchainid: null }) as Investor;

function make(acc: Account | undefined, wallets: Investor[] = [], production = false) {
  const repo = {
    byEmail: vi.fn(async () => acc),
    byId: vi.fn(async () => acc),
    walletsFor: vi.fn(async () => wallets),
    submitKyc: vi.fn(async () => undefined),
    linkWallet: vi.fn(async () => undefined),
    create: vi.fn(async () => account()),
    markEmailVerified: vi.fn(async () => undefined),
    upsertOtp: vi.fn(async () => undefined),
    consumeOtp: vi.fn(async () => true),
    setPassword: vi.fn(async () => undefined),
  } as unknown as AccountRepository;
  const jwt = { signAccount: vi.fn(() => 'tok') } as unknown as JwtService;
  const config = {
    get: (k: string) => (k === 'OTP_TTL_MINUTES' ? 15 : undefined),
    isProduction: production,
    isDevelopment: !production,
  } as unknown as AppConfig;
  const mailer = { name: 'mock', send: vi.fn(async () => undefined) } as unknown as Mailer;
  const portfolio = { portfolio: vi.fn(async () => ({ items: [] })) } as never;
  return { service: new AccountService(repo, jwt, config, portfolio, mailer), repo, jwt, mailer, config };
}

describe('flow position', () => {
  it('unverified email comes first, whatever else is true', () => {
    /* Even with completed KYC and a wallet — an unverified address means we
       cannot reach the person at all. */
    const step = AccountService.step(account({ emailVerified: false }), [wallet()]);
    expect(step).toBe('verify_email');
  });

  it('verified email with no KYC -> kyc', () => {
    expect(AccountService.step(account({ kycStatus: 'none' }), [])).toBe('kyc');
  });

  it('KYC under review is still the kyc step', () => {
    expect(AccountService.step(account({ kycStatus: 'applied' }), [])).toBe('kyc');
  });

  it('REJECTED KYC with a wallet is still the kyc step, not ready', () => {
    /* The dangerous case: a wallet exists, so a naive check would report
       "ready" while the person cannot hold tokens. */
    expect(AccountService.step(account({ kycStatus: 'rejected' }), [wallet()])).toBe('kyc');
  });

  it('approved KYC but no wallet -> connect_wallet', () => {
    expect(AccountService.step(account(), [])).toBe('connect_wallet');
  });

  it('approved KYC + a wallet -> ready', () => {
    expect(AccountService.step(account(), [wallet()])).toBe('ready');
  });
});

describe('me()', () => {
  it('surfaces the rejection reason so the person can fix and re-submit', async () => {
    const { service } = make(account({ kycStatus: 'rejected', kycNote: 'blurry document' }));
    const view = await service.me('7');
    expect(view.step).toBe('kyc');
    expect(view.nextAction).toContain('blurry document');
  });

  it('never leaks the password hash', async () => {
    const { service } = make(account());
    expect(await service.me('7')).not.toHaveProperty('passwordHash');
  });
});

describe('submitKyc', () => {
  it('works with NO wallet connected — KYC belongs to the person', async () => {
    const { service, repo } = make(account({ kycStatus: 'none' }), []);
    await service.submitKyc('7', { country: 356, name: 'Person' });
    expect(repo.submitKyc).toHaveBeenCalledWith('7', 356, 'Person');
  });

  it('refuses when already under review', async () => {
    const { service } = make(account({ kycStatus: 'applied' }));
    await expect(service.submitKyc('7', {})).rejects.toMatchObject({ code: 'KYC_UNDER_REVIEW' });
  });

  it('refuses when already approved', async () => {
    const { service } = make(account({ kycStatus: 'completed' }));
    await expect(service.submitKyc('7', {})).rejects.toMatchObject({
      code: 'KYC_ALREADY_APPROVED',
    });
  });

  it('allows re-submission after rejection', async () => {
    const { service, repo } = make(account({ kycStatus: 'rejected' }));
    await service.submitKyc('7', {});
    expect(repo.submitKyc).toHaveBeenCalled();
  });
});

describe('connectWallet', () => {
  it('requires approved KYC — the flow is KYC then wallet', async () => {
    const { service, repo } = make(account({ kycStatus: 'applied' }));
    await expect(service.connectWallet('7', '0xabc')).rejects.toMatchObject({
      code: 'KYC_NOT_APPROVED',
      status: 403,
    });
    expect(repo.linkWallet).not.toHaveBeenCalled();
  });

  it('links once KYC is approved', async () => {
    const { service, repo } = make(account(), []);
    await service.connectWallet('7', '0xABC');
    expect(repo.linkWallet).toHaveBeenCalledWith('7', '0xABC');
  });

  it('409s a wallet already owned by someone else', async () => {
    const { service, repo } = make(account(), []);
    vi.mocked(repo.linkWallet).mockRejectedValueOnce(
      new Error('WALLET_OWNED_BY_ANOTHER_ACCOUNT'),
    );
    /* Silently re-parenting would move another person's holdings. */
    await expect(service.connectWallet('7', '0xabc')).rejects.toMatchObject({
      code: 'WALLET_ALREADY_LINKED',
      status: 409,
    });
  });
});

describe('login', () => {
  it('gives one indistinguishable error for unknown email and wrong password', async () => {
    const { service } = make(undefined);
    await expect(service.login('nobody@example.com', 'pw')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });
});

describe('signup + email verification', () => {
  it('creates the person, emails a code, and issues NO session', async () => {
    const { service, repo, mailer, jwt } = make(undefined);
    const res = await service.signup('New@Example.com ', 'password123', ' Person ');

    expect(repo.create).toHaveBeenCalledWith('new@example.com', expect.any(String), 'Person');
    expect(mailer.send).toHaveBeenCalledOnce();
    /* No token: an unverified address must not carry a live session, or anyone
       could sign up with someone else's email and be logged in as them. */
    expect(jwt.signAccount).not.toHaveBeenCalled();
    expect(res.needsVerification).toBe(true);
  });

  it('never stores the password in plaintext', async () => {
    const { service, repo } = make(undefined);
    await service.signup('a@b.c', 'password123');
    const stored = vi.mocked(repo.create).mock.calls[0][1];
    expect(stored).not.toBe('password123');
    expect(stored.startsWith('$2')).toBe(true);
  });

  it('409s a duplicate email', async () => {
    const { service } = make(account());
    await expect(service.signup('p@example.com', 'password123')).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
    });
  });

  it('reveals the dev code outside production, never inside it', async () => {
    const dev = await make(undefined).service.signup('a@b.c', 'password123');
    expect(dev.devCode).toBe('123456');

    const prod = await make(undefined, [], true).service.signup('a@b.c', 'password123');
    /* Returning a code in production would defeat email verification entirely. */
    expect(prod.devCode).toBeUndefined();
  });

  it('verifies the code, marks verified, and issues the session', async () => {
    const { service, repo, jwt } = make(account({ emailVerified: false }));
    const res = await service.verifyEmail('p@example.com', '123456');
    expect(repo.consumeOtp).toHaveBeenCalledWith('p@example.com', 'verify', '123456');
    expect(repo.markEmailVerified).toHaveBeenCalled();
    expect(jwt.signAccount).toHaveBeenCalled();
    expect(res.token).toBe('tok');
  });

  it('rejects a wrong or expired code', async () => {
    const { service, repo } = make(account({ emailVerified: false }));
    vi.mocked(repo.consumeOtp).mockResolvedValueOnce(false);
    await expect(service.verifyEmail('p@example.com', '000000')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    expect(repo.markEmailVerified).not.toHaveBeenCalled();
  });

  it('is idempotent — verifying twice returns a session, not an error', async () => {
    const { service, repo } = make(account({ emailVerified: true }));
    const res = await service.verifyEmail('p@example.com', 'anything');
    /* A double-submitted form must not strand the user. */
    expect(repo.consumeOtp).not.toHaveBeenCalled();
    expect(res.token).toBe('tok');
  });

  it('resend does not disclose whether an email exists', async () => {
    const unknown = await make(undefined).service.resendVerification('nobody@example.com');
    const known = await make(account({ emailVerified: false })).service.resendVerification('p@example.com');
    /* Identical shape either way — this endpoint is trivially scriptable. */
    expect(unknown.ok).toBe(true);
    expect(known.ok).toBe(true);
  });

  it('resend does not re-send to an already-verified account', async () => {
    const { service, mailer } = make(account({ emailVerified: true }));
    await service.resendVerification('p@example.com');
    expect(mailer.send).not.toHaveBeenCalled();
  });
});

describe('password reset', () => {
  it('never discloses whether an email is registered', async () => {
    const unknown = await make(undefined).service.forgotPassword('nobody@example.com');
    const known = await make(account()).service.forgotPassword('p@example.com');
    /* Unauthenticated and trivially scriptable — a different response here
       hands over the whole user list. */
    expect(unknown).toEqual(known);
  });

  it('emails a code only when the account exists', async () => {
    const a = make(undefined);
    await a.service.forgotPassword('nobody@example.com');
    expect(a.mailer.send).not.toHaveBeenCalled();

    const b = make(account());
    await b.service.forgotPassword('p@example.com');
    expect(b.mailer.send).toHaveBeenCalledOnce();
  });

  it('sets the new password hashed, never in plaintext', async () => {
    const { service, repo } = make(account());
    await service.resetPassword('p@example.com', '123456', 'newpassword1');
    const [, hash] = vi.mocked(repo.setPassword).mock.calls[0];
    expect(hash).not.toBe('newpassword1');
    expect(hash.startsWith('$2')).toBe(true);
  });

  it('consumes the reset code — not the verify code', async () => {
    const { service, repo } = make(account());
    await service.resetPassword('p@example.com', '123456', 'newpassword1');
    /* Sharing a code across purposes would let a verification code change a
       password. */
    expect(repo.consumeOtp).toHaveBeenCalledWith('p@example.com', 'reset', '123456');
  });

  it('gives the SAME error for an unknown account and a bad code', async () => {
    const unknown = await make(undefined)
      .service.resetPassword('nobody@example.com', '123456', 'newpassword1')
      .catch((e: AppError) => e);

    const bad = make(account());
    vi.mocked(bad.repo.consumeOtp).mockResolvedValueOnce(false);
    const wrongCode = await bad.service
      .resetPassword('p@example.com', '000000', 'newpassword1')
      .catch((e: AppError) => e);

    /* Distinguishing them would re-open the hole forgot-password closes. */
    expect((unknown as AppError).code).toBe((wrongCode as AppError).code);
    expect((unknown as AppError).message).toBe((wrongCode as AppError).message);
  });

  it('does not change the password when the code is wrong', async () => {
    const { service, repo } = make(account());
    vi.mocked(repo.consumeOtp).mockResolvedValueOnce(false);
    await expect(
      service.resetPassword('p@example.com', '000000', 'newpassword1'),
    ).rejects.toBeInstanceOf(AppError);
    expect(repo.setPassword).not.toHaveBeenCalled();
  });

  it('marks the email verified — a completed reset proves inbox control', async () => {
    const { service, repo } = make(account({ emailVerified: false }));
    await service.resetPassword('p@example.com', '123456', 'newpassword1');
    /* Otherwise someone who never clicked the original link can reset their
       password and still be stuck at step 1 of the flow. */
    expect(repo.markEmailVerified).toHaveBeenCalled();
  });

  it('issues a session on success', async () => {
    const { service, jwt } = make(account());
    const res = await service.resetPassword('p@example.com', '123456', 'newpassword1');
    expect(jwt.signAccount).toHaveBeenCalled();
    expect(res.token).toBe('tok');
  });
});
