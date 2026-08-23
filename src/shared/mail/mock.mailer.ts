import { Injectable, Logger } from '@nestjs/common';
import type { Mail, Mailer } from './mailer';

/**
 * Dev mailer: logs instead of sending.
 *
 * The body is logged in full BECAUSE it carries the one-time code — that is the
 * point in development. It is therefore unusable in production, and MailModule
 * refuses to select it there rather than leaking codes into production logs.
 */
@Injectable()
export class MockMailer implements Mailer {
  readonly name = 'mock';
  private readonly logger = new Logger('Mailer');

  async send(mail: Mail): Promise<void> {
    this.logger.log(`[mock] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
}
