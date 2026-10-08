import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { UserEntity } from '../../users/entities/user.entity';

/**
 * Response body for login and refresh.
 *
 * Only the access token appears here. The refresh token is sent exclusively as
 * an httpOnly cookie so XSS cannot read it.
 */
export class AuthResultDto {
  @ApiProperty({ description: 'Bearer token for the Authorization header' })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType = 'Bearer';

  @ApiProperty({
    description: 'Access token lifetime in seconds',
    example: 900,
  })
  expiresIn: number;

  @ApiProperty({ type: UserEntity })
  user: UserEntity;

  constructor(accessToken: string, expiresIn: number, user: UserEntity) {
    this.accessToken = accessToken;
    this.expiresIn = expiresIn;
    this.user = user;
  }
}

/**
 * Response body for registration. When `verificationRequired` is true no
 * session is started: the user must follow the emailed link, then sign in.
 */
export class RegisterResultDto {
  @ApiProperty({ type: UserEntity })
  user: UserEntity;

  @ApiProperty()
  verificationRequired: boolean;

  @ApiPropertyOptional({
    description: 'Present when no verification is required',
  })
  accessToken?: string;

  @ApiPropertyOptional({ example: 'Bearer' })
  tokenType?: string;

  @ApiPropertyOptional({ example: 900 })
  expiresIn?: number;

  constructor(
    user: UserEntity,
    verificationRequired: boolean,
    auth?: AuthResultDto,
  ) {
    this.user = user;
    this.verificationRequired = verificationRequired;
    if (auth) {
      this.accessToken = auth.accessToken;
      this.tokenType = auth.tokenType;
      this.expiresIn = auth.expiresIn;
    }
  }
}
