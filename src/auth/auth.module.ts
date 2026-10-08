import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { UsersModule } from '../users/users.module';
import { AuthCleanupService } from './auth-cleanup.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TrustedOriginGuard } from './guards/trusted-origin.guard';
import { GoogleAuthController } from './oauth/google-auth.controller';
import { GoogleOAuthClient } from './oauth/google-oauth.client';
import { GoogleSignInService } from './oauth/google-sign-in.service';
import { OAuthAccountsRepository } from './oauth/oauth-accounts.repository';
import { SessionsModule } from './sessions/sessions.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthTokensRepository } from './tokens/auth-tokens.repository';
import { AuthTokensService } from './tokens/auth-tokens.service';

@Module({
  imports: [
    UsersModule,
    SessionsModule,
    // `session: false` — Passport only runs the JWT strategy per request;
    // session state lives in the `sessions` table.
    PassportModule.register({ session: false }),
    // Secrets differ per token kind (access vs OAuth state), so they are
    // passed explicitly at each sign/verify call.
    JwtModule.register({}),
  ],
  controllers: [AuthController, GoogleAuthController],
  providers: [
    AuthService,
    AuthTokensRepository,
    AuthTokensService,
    AuthCleanupService,
    GoogleOAuthClient,
    GoogleSignInService,
    OAuthAccountsRepository,
    JwtStrategy,
    TrustedOriginGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
