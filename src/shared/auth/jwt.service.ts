/**
 * JWT sign/verify. Token shapes are IDENTICAL to the Express app's
 * (src/lib/jwt.ts) — during the migration a user's requests hit both services,
 * so a token issued by one must verify in the other.
 *
 * The `typ` claim keeps session types apart: an investor token must not be
 * usable on an admin endpoint.
 */
import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AppConfig } from '../config/app-config.service';
import type { AdminRole } from './tenant-context';

export interface AdminClaims {
  sub: string;
  email: string;
  role: AdminRole;
  typ: 'admin';
}

export interface AccountClaims {
  sub: string;
  email: string;
  typ: 'account';
}

export interface InvestorClaims {
  sub: string; // wallet, lowercased
  typ: 'investor';
}

export type AnyClaims = AdminClaims | AccountClaims | InvestorClaims;

@Injectable()
export class JwtService {
  private readonly secret: string;
  private readonly adminTtl: string;
  private readonly investorTtl: string;

  constructor(config: AppConfig) {
    this.secret = config.get('JWT_SECRET');
    this.adminTtl = config.get('JWT_EXPIRES_IN');
    this.investorTtl = config.get('INVESTOR_JWT_EXPIRES_IN');
  }

  signAdmin(claims: Omit<AdminClaims, 'typ'>): string {
    return jwt.sign({ ...claims, typ: 'admin' }, this.secret, {
      expiresIn: this.adminTtl,
    } as jwt.SignOptions);
  }

  signAccount(claims: Omit<AccountClaims, 'typ'>): string {
    return jwt.sign({ ...claims, typ: 'account' }, this.secret, {
      expiresIn: this.investorTtl,
    } as jwt.SignOptions);
  }

  signInvestor(wallet: string): string {
    return jwt.sign({ sub: wallet.toLowerCase(), typ: 'investor' }, this.secret, {
      expiresIn: this.investorTtl,
    } as jwt.SignOptions);
  }

  /**
   * Verify and assert the token type. Throws on any failure — callers convert
   * to AppError.unauthorized() rather than leaking the jwt library's message.
   */
  verify<T extends AnyClaims['typ']>(token: string, expected: T): Extract<AnyClaims, { typ: T }> {
    const decoded = jwt.verify(token, this.secret);
    if (typeof decoded === 'string') throw new Error('Malformed token');
    const claims = decoded as AnyClaims;
    if (claims.typ !== expected) throw new Error('Wrong token type');
    return claims as Extract<AnyClaims, { typ: T }>;
  }
}
