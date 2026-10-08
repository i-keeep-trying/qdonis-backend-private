import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { AuthThrottle } from '../common/decorators/auth-throttle.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserEntity } from '../users/entities/user.entity';
import { AuthService, type IssuedAuth } from './auth.service';
import { REFRESH_TOKEN_COOKIE, type AuthenticatedUser } from './auth.types';
import { AuthResultDto, RegisterResultDto } from './dto/auth-result.dto';
import { LoginDto } from './dto/login.dto';
import {
  ChangePasswordDto,
  EmailOnlyDto,
  ResetPasswordDto,
  TokenDto,
} from './dto/password.dto';
import { RegisterDto } from './dto/register.dto';
import { SessionDto } from './dto/session.dto';
import { TrustedOriginGuard } from './guards/trusted-origin.guard';
import { bearerToken, sessionContext } from './request-context';
import { AuthCookies } from './sessions/auth-cookies.service';

/** Body returned by the enumeration-safe email endpoints. */
class AcceptedDto {
  message!: string;
}

const ACCEPTED_EMAIL: AcceptedDto = {
  message: 'If an account exists for that email, a message is on its way.',
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: AuthCookies,
  ) {}

  // --- password accounts ---------------------------------------------------

  @Public()
  @AuthThrottle()
  @Post('register')
  @ApiOperation({
    summary: 'Create a password account',
    description:
      'Sends a verification email. If AUTH_REQUIRE_VERIFIED_EMAIL is on (default), no session is started and `verificationRequired` is true; otherwise the refresh cookie is set and an access token returned.',
  })
  @ApiCreatedResponse({ type: RegisterResultDto })
  @ApiConflictResponse({ description: 'EMAIL_TAKEN' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisterResultDto> {
    const { result, session } = await this.authService.register(
      dto,
      sessionContext(request),
    );
    if (session) this.writeSession(response, session);
    return result;
  }

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse({ type: AuthResultDto })
  @ApiUnauthorizedResponse({
    description: 'INVALID_CREDENTIALS (also for locked/disabled accounts)',
  })
  @ApiForbiddenResponse({ description: 'EMAIL_NOT_VERIFIED' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResultDto> {
    const issued = await this.authService.login(dto, sessionContext(request));
    return this.writeSession(response, issued);
  }

  // --- session lifecycle ---------------------------------------------------

  /**
   * Public with respect to the access token (it exists for when that has
   * expired); authenticated by the httpOnly refresh cookie alone.
   */
  @Public()
  @UseGuards(TrustedOriginGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_TOKEN_COOKIE)
  @ApiOperation({
    summary: 'Rotate the refresh cookie and get a new access token',
    description:
      'On REFRESH_CONFLICT another tab refreshed at the same moment: retry once. Any other 401 means sign in again.',
  })
  @ApiOkResponse({ type: AuthResultDto })
  @ApiUnauthorizedResponse({
    description:
      'REFRESH_TOKEN_MISSING | REFRESH_CONFLICT | SESSION_REVOKED | SESSION_EXPIRED',
  })
  @ApiForbiddenResponse({ description: 'ORIGIN_NOT_ALLOWED' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResultDto> {
    try {
      const issued = await this.authService.refresh(
        this.cookies.readRefreshToken(request),
        sessionContext(request),
      );
      return this.writeSession(response, issued);
    } catch (error) {
      // A conflict means the winning request already set a newer cookie that
      // this response must not wipe out; every other 401 is terminal.
      if (error instanceof UnauthorizedException && !isRefreshConflict(error)) {
        this.cookies.clearRefreshToken(response);
      }
      throw error;
    }
  }

  @Public()
  @UseGuards(TrustedOriginGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out of this device',
    description:
      'Uses the refresh cookie, or the bearer token (even if expired). Always 204.',
  })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(
      this.cookies.readRefreshToken(request),
      bearerToken(request),
    );
    this.cookies.clearRefreshToken(response);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of every device' })
  @ApiNoContentResponse()
  async logoutAll(
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logoutAll(userId);
    this.cookies.clearRefreshToken(response);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fetch the signed-in user' })
  @ApiOkResponse({ type: UserEntity })
  me(@CurrentUser('id') userId: string): Promise<UserEntity> {
    return this.authService.getProfile(userId);
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List devices where I am signed in' })
  @ApiOkResponse({ type: SessionDto, isArray: true })
  sessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionDto[]> {
    return this.authService.listSessions(user);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out one of my devices' })
  @ApiNoContentResponse()
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const { wasCurrent } = await this.authService.revokeSession(
      user,
      sessionId,
    );
    if (wasCurrent) this.cookies.clearRefreshToken(response);
  }

  // --- email verification ----------------------------------------------------

  @Public()
  @AuthThrottle()
  @Post('email/verification/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-send the verification email (same response for any email)',
  })
  @ApiAcceptedResponse({ type: AcceptedDto })
  async resendVerification(@Body() dto: EmailOnlyDto): Promise<AcceptedDto> {
    await this.authService.resendVerification(dto.email);
    return ACCEPTED_EMAIL;
  }

  @Public()
  @AuthThrottle()
  @Post('email/verification/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm an email address with the emailed token' })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'INVALID_TOKEN' })
  confirmEmail(@Body() dto: TokenDto): Promise<void> {
    return this.authService.confirmEmail(dto.token);
  }

  // --- passwords ---------------------------------------------------------------

  @Public()
  @AuthThrottle()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a password-reset link (same response for any email)',
  })
  @ApiAcceptedResponse({ type: AcceptedDto })
  async forgotPassword(@Body() dto: EmailOnlyDto): Promise<AcceptedDto> {
    await this.authService.forgotPassword(dto.email);
    return ACCEPTED_EMAIL;
  }

  @Public()
  @AuthThrottle()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password with the emailed token',
    description:
      'Signs out every device. The user signs in again with the new password.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'INVALID_TOKEN | VALIDATION_FAILED' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.resetPassword(dto);
    this.cookies.clearRefreshToken(response);
  }

  @AuthThrottle()
  @Post('password/change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change my password (other devices are signed out)',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS' })
  @ApiBadRequestResponse({
    description: 'PASSWORD_NOT_SET | PASSWORD_UNCHANGED',
  })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.authService.changePassword(user, dto);
  }

  private writeSession(response: Response, issued: IssuedAuth): AuthResultDto {
    this.cookies.setRefreshToken(
      response,
      issued.refreshToken,
      issued.refreshTokenExpiresAt,
    );
    return issued.result;
  }
}

function isRefreshConflict(error: UnauthorizedException): boolean {
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'REFRESH_CONFLICT'
  );
}
