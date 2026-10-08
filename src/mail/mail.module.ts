import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../config/configuration';
import { MailTransportKind } from '../config/env.validation';
import { LogMailTransport } from './log.transport';
import { MailService } from './mail.service';
import { MailTransport } from './mail.transport';
import { SmtpMailTransport } from './smtp.transport';

@Global()
@Module({
  providers: [
    {
      provide: MailTransport,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<AppConfiguration, true>,
      ): MailTransport => {
        const mail = config.get('mail', { infer: true });
        if (mail.transport === MailTransportKind.Log) {
          return new LogMailTransport();
        }
        // env.validation guarantees these are present when transport=smtp.
        const { user, password } = mail.smtp;
        if (!user || !password || !mail.from) {
          throw new Error(
            'SMTP transport selected but SMTP_USER, SMTP_PASSWORD or MAIL_FROM is missing',
          );
        }
        return new SmtpMailTransport({
          host: mail.smtp.host,
          port: mail.smtp.port,
          secure: mail.smtp.secure,
          user,
          password,
          from: mail.from,
        });
      },
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
