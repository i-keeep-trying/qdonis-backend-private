import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../config/configuration';
import {
  humanizeDuration,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from './mail.templates';
import { type MailMessage, MailTransport } from './mail.transport';

/**
 * Sends the auth emails.
 *
 * Methods return a promise that rejects on delivery failure. Callers on
 * enumeration-sensitive routes dispatch with {@link dispatch} so the HTTP
 * response neither waits for SMTP nor differs when sending fails; the failure
 * is still logged at `error`.
 */
@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly transport: MailTransport,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * Checks SMTP credentials at boot. A failure is logged loudly but does not
   * stop the API: a mail-provider outage should not take login down.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get('app', { infer: true }).isTest) return;
    try {
      await this.transport.verify();
      this.logger.log(
        `Mail transport ready (${this.config.get('mail', { infer: true }).transport})`,
      );
    } catch (error) {
      this.logger.error(
        `Mail transport verification failed: ${describe(error)}. Verification and reset emails will fail until this is fixed.`,
      );
    }
  }

  onModuleDestroy(): void {
    this.transport.close();
  }

  sendEmailVerification(
    to: string,
    name: string | null,
    token: string,
  ): Promise<void> {
    const auth = this.config.get('auth', { infer: true });
    return this.send(
      verificationEmail({
        to,
        name,
        url: this.frontendLink('/verify-email', token),
        expiresInText: humanizeDuration(auth.emailVerificationTtlMs),
      }),
      'email-verification',
    );
  }

  sendPasswordReset(
    to: string,
    name: string | null,
    token: string,
  ): Promise<void> {
    const auth = this.config.get('auth', { infer: true });
    return this.send(
      passwordResetEmail({
        to,
        name,
        url: this.frontendLink('/reset-password', token),
        expiresInText: humanizeDuration(auth.passwordResetTtlMs),
      }),
      'password-reset',
    );
  }

  sendPasswordChanged(to: string, name: string | null): Promise<void> {
    const { frontendUrl } = this.config.get('app', { infer: true });
    return this.send(
      passwordChangedEmail({
        to,
        name,
        resetUrl: `${frontendUrl}/forgot-password`,
      }),
      'password-changed',
    );
  }

  /**
   * Fire-and-forget wrapper: never rejects, logs failures. The kind label is
   * logged instead of the recipient or the link.
   */
  dispatch(send: () => Promise<void>, kind: string): void {
    send().catch((error: unknown) => {
      this.logger.error(`Failed to send ${kind} email: ${describe(error)}`);
    });
  }

  private async send(message: MailMessage, kind: string): Promise<void> {
    try {
      await this.transport.send(message);
    } catch (error) {
      throw new Error(`${kind} email delivery failed: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  /** Token goes in the fragment-free query; the SPA POSTs it to the API. */
  private frontendLink(path: string, token: string): string {
    const { frontendUrl } = this.config.get('app', { infer: true });
    return `${frontendUrl}${path}?token=${encodeURIComponent(token)}`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
