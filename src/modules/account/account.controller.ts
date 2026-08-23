/**
 * The investor-facing account API — session type `account`.
 *
 *   POST /api/account/login          -> account session cookie
 *   POST /api/account/logout
 *   GET  /api/account/me             -> profile + where you are in the flow
 *   POST /api/account/kyc            -> submit for review (no wallet needed)
 *   POST /api/account/wallet/nonce   -> SIWE message to sign
 *   POST /api/account/wallet/connect -> link the proven wallet
 *
 * These use the ACCOUNT session, not the admin one. The `typ` claim keeps them
 * apart: an admin token presented here fails, and vice versa.
 */
import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { CurrentUser, Public, Session } from '@shared/auth/decorators';
import { JwtService } from '@shared/auth/jwt.service';
import { SessionService } from '@shared/auth/session.service';
import type { Principal } from '@shared/auth/tenant-context';
import { ApiAuthErrors, ApiConflict, ApiValidationError } from '@shared/openapi/api-error.decorator';
import { SiweService } from '@modules/wallet/siwe.service';
import { AccountService } from './account.service';
import {
  AccountLoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  NonceDto,
  ResendDto,
  SignupDto,
  SiweVerifyDto,
  SubmitKycDto,
  VerifyEmailDto,
} from './dto/account.dto';

@ApiTags('Investor')
@Session('account')
@Controller('investor')
export class AccountController {
  constructor(
    private readonly accounts: AccountService,
    private readonly session: SessionService,
    private readonly siwe: SiweService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @ApiOperation({
    summary: 'Sign up (step 1)',
    description:
      'Creates the person, unverified, and emails a one-time code. Deliberately ' +
      'issues NO session — an unverified address must not carry a live session, or ' +
      'anyone could sign up with someone else\'s email and be logged in as them.\n\n' +
      'Outside production the response includes `devCode` so the flow is testable ' +
      'without an inbox; in production it is absent.',
  })
  @ApiValidationError()
  @ApiConflict('An account with that email already exists.', 'EMAIL_ALREADY_REGISTERED')
  @HttpCode(201)
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.accounts.signup(dto.email, dto.password, dto.name);
  }

  @Public()
  @ApiOperation({
    summary: 'Verify the emailed code (step 1b)',
    description:
      'Consumes the code atomically (one-time use) and issues the account session. ' +
      'Idempotent: verifying an already-verified account returns a session rather than ' +
      'an error, so a double-submitted form does not strand the user.',
  })
  @ApiValidationError()
  @HttpCode(200)
  @Post('verify-email')
  async verifyEmail(@Body() dto: VerifyEmailDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const { token, account } = await this.accounts.verifyEmail(dto.email, dto.code);
    this.session.issueAccount(reply, token);
    return { account };
  }

  @Public()
  @ApiOperation({
    summary: 'Re-send the verification code',
    description:
      'Always reports success, whether or not the email exists. This endpoint is ' +
      'trivially scriptable, so confirming which addresses are registered would hand ' +
      'over an enumeration oracle.',
  })
  @ApiValidationError()
  @HttpCode(200)
  @Post('resend-verification')
  resend(@Body() dto: ResendDto) {
    return this.accounts.resendVerification(dto.email);
  }

  @Public()
  @ApiOperation({
    summary: 'Log in as an investor (account session)',
    description:
      'Sets the `rwa_account_token` httpOnly cookie. Distinct from admin login — the ' +
      'JWT `typ` claim is `account`, so it is rejected on back-office routes.',
  })
  @ApiValidationError()
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: AccountLoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const { token, account } = await this.accounts.login(dto.email, dto.password);
    this.session.issueAccount(reply, token);
    return { account };
  }

  @Public()
  @ApiOperation({
    summary: 'Start a password reset',
    description:
      'Emails a one-time code. ALWAYS reports success, whether or not the address is ' +
      'registered — password reset is the classic account-enumeration oracle: ' +
      'unauthenticated, trivially scriptable, and a different response for a known email ' +
      'hands over the user list.',
  })
  @ApiValidationError()
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.accounts.forgotPassword(dto.email);
  }

  @Public()
  @ApiOperation({
    summary: 'Finish a password reset',
    description:
      'Consumes the code atomically, sets the new password, and signs the person in. ' +
      'Every failure returns the SAME message — distinguishing "no such account" from ' +
      '"wrong code" would re-open the hole that forgot-password closes.\n\n' +
      'A completed reset also marks the email verified: it proves control of the inbox, ' +
      'which is exactly what verification asks for.',
  })
  @ApiValidationError()
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token, account } = await this.accounts.resetPassword(
      dto.email,
      dto.code,
      dto.newPassword,
    );
    this.session.issueAccount(reply, token);
    return { account };
  }

  @Public()
  @ApiOperation({ summary: 'Log out of the account session' })
  @HttpCode(200)
  @Post('logout')
  logout(@Res({ passthrough: true }) reply: FastifyReply) {
    this.session.clearAccount(reply);
    return { ok: true };
  }

  @ApiOperation({
    summary: 'Profile + flow progress',
    description:
      'Returns `step` (verify_email | kyc | connect_wallet | ready) and `nextAction`. ' +
      'The server owns that decision so every client shows the same progress instead of ' +
      're-deriving it from separate flags.',
  })
  @ApiAuthErrors()
  @Get('me')
  me(@CurrentUser() principal: Principal) {
    return this.accounts.me(principal.id);
  }

  @ApiOperation({
    summary: 'Submit KYC for review',
    description:
      'Step 2. Deliberately does NOT require a wallet — KYC belongs to the person ' +
      '(migration 045), and the wallet is connected afterwards.',
  })
  @ApiAuthErrors()
  @ApiValidationError()
  @ApiConflict('KYC is already approved or already under review.', 'KYC_UNDER_REVIEW')
  @HttpCode(200)
  @Post('kyc')
  submitKyc(@CurrentUser() principal: Principal, @Body() dto: SubmitKycDto) {
    return this.accounts.submitKyc(principal.id, dto);
  }

  @ApiOperation({
    summary: 'Get the SIWE message to sign',
    description:
      'Returns an EIP-4361 message with a one-time nonce. Domain, URI and chain id come ' +
      'from server config, so a phishing origin shows as a mismatch in the wallet.',
  })
  @ApiAuthErrors()
  @ApiValidationError()
  @HttpCode(200)
  @Post('wallet/nonce')
  nonce(@Body() dto: NonceDto) {
    return this.siwe.requestNonce(dto.address);
  }

  @ApiOperation({
    summary: 'Connect a wallet (step 3)',
    description:
      'Verifies the SIWE signature, consuming the nonce atomically so it cannot be ' +
      'replayed, then links the wallet to this account. Requires approved KYC.',
  })
  @ApiAuthErrors()
  @ApiValidationError()
  @ApiConflict('That wallet is already linked to a different account.', 'WALLET_ALREADY_LINKED')
  @HttpCode(200)
  @Post('wallet/connect')
  async connect(
    @CurrentUser() principal: Principal,
    @Body() dto: SiweVerifyDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const address = await this.siwe.consumeAndRecover(dto.address, dto.signature);
    const view = await this.accounts.connectWallet(principal.id, address);
    /* The same signature also establishes the WALLET (investor) session — the
       portal's orders/portfolio/claims routes need it, and asking for a second
       prompt for a control the user just proved would be pure friction. Same
       behaviour as the Express attachWallet. */
    this.session.issueInvestor(reply, this.jwt.signInvestor(address));
    return view;
  }
}
