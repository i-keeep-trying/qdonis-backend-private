import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import {
  ExtractJwt,
  Strategy,
  type StrategyOptionsWithoutRequest,
} from 'passport-jwt';

import type { AppConfiguration } from '../../config/configuration';
import { AuthService } from '../auth.service';
import type { AccessTokenPayload, AuthenticatedUser } from '../auth.types';

/**
 * Validates the short-lived access token on every protected request.
 *
 * passport-jwt verifies signature (HS256 only), issuer, audience and expiry;
 * `AuthService.validateAccessToken` then checks the session and account in the
 * database so revocation is immediate.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<AppConfiguration, true>,
    private readonly authService: AuthService,
  ) {
    const auth = config.get('auth', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: auth.accessSecret,
      issuer: auth.issuer,
      audience: auth.audience,
      ignoreExpiration: false,
      algorithms: ['HS256'],
    } satisfies StrategyOptionsWithoutRequest);
  }

  validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    return this.authService.validateAccessToken(payload);
  }
}
