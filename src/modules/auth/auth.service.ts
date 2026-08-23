/**
 * Admin authentication.
 *
 * Passwords are bcrypt-hashed (slow by design, per-user salt). Plaintext is
 * never stored or logged. Login issues a short-lived JWT whose shape matches
 * the Express app's exactly, so a session survives requests landing on either
 * service during the migration.
 */
import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { AppError } from '@shared/errors/app-error';
import { JwtService } from '@shared/auth/jwt.service';
import type { AdminRole } from '@shared/auth/tenant-context';
import type { Admin } from '@shared/db/schema';
import { AuthRepository } from './auth.repository';

/**
 * A real bcrypt hash that no password matches. When the email is unknown we
 * still run a full bcrypt compare against this, so login latency does not
 * reveal whether an account exists. Ported verbatim from the Express app.
 */
const DUMMY_HASH = '$2b$12$fRSJok2nKiFL27Z8MOSUGuRF.TTmZ.OBgT6UFwstwKaTyF4o8.A/W';

export interface PublicAdmin {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
  issuerId: string | null;
  disabled: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly jwt: JwtService,
  ) {}

  /** Never includes the password hash. */
  static publicView(a: Admin): PublicAdmin {
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      role: a.role as AdminRole,
      issuerId: a.issuerId ?? null,
      disabled: a.disabled,
    };
  }

  async login(email: string, password: string): Promise<{ token: string; admin: PublicAdmin }> {
    const admin = await this.repo.findByEmail(email);

    /* Always compare, even when the email is unknown — see DUMMY_HASH. */
    const ok = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);

    /* One indistinguishable message for unknown email, wrong password, and
       disabled account. Distinguishing them is an account-enumeration oracle. */
    if (!admin || !ok || admin.disabled) {
      throw new AppError('INVALID_CREDENTIALS', 401, 'Invalid email or password.');
    }

    const token = this.jwt.signAdmin({
      sub: admin.id,
      email: admin.email,
      role: admin.role as AdminRole,
    });

    return { token, admin: AuthService.publicView(admin) };
  }
}
