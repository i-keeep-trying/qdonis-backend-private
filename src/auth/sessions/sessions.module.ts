import { Module } from '@nestjs/common';

import { AuthCookies } from './auth-cookies.service';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';

/**
 * Session storage and the refresh cookie, split out of AuthModule so that
 * UsersModule (admin deactivation, account deletion) can revoke sessions
 * without a circular module dependency.
 */
@Module({
  providers: [SessionsRepository, SessionsService, AuthCookies],
  exports: [SessionsService, AuthCookies],
})
export class SessionsModule {}
