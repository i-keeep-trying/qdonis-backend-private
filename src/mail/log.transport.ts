import { Logger } from '@nestjs/common';

import { type MailMessage, MailTransport } from './mail.transport';

/**
 * Development-only transport: writes the message (links included) to the log
 * instead of sending it. Refused in production by env validation, because it
 * would put live reset links into log storage.
 */
export class LogMailTransport extends MailTransport {
  private readonly logger = new Logger('MailLog');

  send(message: MailMessage): Promise<void> {
    this.logger.warn(
      `[MAIL_TRANSPORT=log] to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
    return Promise.resolve();
  }

  verify(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    // Nothing to release.
  }
}
