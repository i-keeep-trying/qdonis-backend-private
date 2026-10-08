import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { type MailMessage, MailTransport } from './mail.transport';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

/**
 * Real delivery over SMTP (Gmail: smtp.gmail.com, 465/TLS or 587/STARTTLS,
 * authenticated with an App Password).
 */
export class SmtpMailTransport extends MailTransport {
  private readonly logger = new Logger(SmtpMailTransport.name);
  private readonly transporter: Transporter;

  constructor(private readonly settings: SmtpSettings) {
    super();
    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      // On 587 refuse to continue in plaintext if STARTTLS is unavailable.
      requireTLS: !settings.secure,
      auth: { user: settings.user, pass: settings.password },
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }

  async send(message: MailMessage): Promise<void> {
    const info = (await this.transporter.sendMail({
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })) as { messageId?: string; rejected?: unknown[] };

    if (Array.isArray(info.rejected) && info.rejected.length > 0) {
      throw new Error('SMTP server rejected the recipient');
    }
    this.logger.debug(
      `Mail accepted by SMTP server (${info.messageId ?? 'no id'})`,
    );
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  close(): void {
    this.transporter.close();
  }
}
