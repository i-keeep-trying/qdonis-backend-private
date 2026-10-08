import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuthCookies } from '../auth/sessions/auth-cookies.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DeleteAccountDto, UpdateProfileDto } from './dto/self-service.dto';
import { UserEntity } from './entities/user.entity';
import { UsersService } from './users.service';

/** The signed-in user's own account. Any role. */
@ApiTags('users (self)')
@ApiBearerAuth()
@Controller('users/me')
export class MeController {
  constructor(
    private readonly usersService: UsersService,
    private readonly cookies: AuthCookies,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Fetch my profile' })
  @ApiOkResponse({ type: UserEntity })
  me(@CurrentUser('id') userId: string): Promise<UserEntity> {
    return this.usersService.findOne(userId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update my name or avatar' })
  @ApiOkResponse({ type: UserEntity })
  update(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserEntity> {
    return this.usersService.updateProfile(userId, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Permanently delete my account',
    description:
      'Password accounts must send `password`. Google-only accounts must have signed in within the last 15 minutes (REAUTH_REQUIRED otherwise).',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({
    description: 'INVALID_CREDENTIALS | REAUTH_REQUIRED',
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.usersService.deleteSelf(user.id, user.sessionId, dto);
    this.cookies.clearRefreshToken(response);
  }
}
