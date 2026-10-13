import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuthThrottle } from '../common/decorators/auth-throttle.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  AccessShareLinkDto,
  CreateInvitationsDto,
  CreateShareLinkDto,
  UpdateMemberRoleDto,
} from './dto/sharing.dto';
import { SharingService } from './sharing.service';

@ApiTags('sharing')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class ProjectSharingController {
  constructor(private readonly sharing: SharingService) {}

  @Get('collaborators')
  @ApiOperation({
    summary: 'Owner, collaborators and (for sharers) invitations and links',
  })
  collaborators(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.sharing.collaborators(user, projectId);
  }

  @Post('invitations')
  @AuthThrottle()
  @ApiOperation({ summary: 'Share with registered users or email invitations' })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateInvitationsDto,
  ) {
    return this.sharing.invite(user, projectId, dto);
  }

  @Delete('invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<void> {
    return this.sharing.revokeInvitation(user, projectId, invitationId);
  }

  @Post('share-links')
  @ApiOperation({ summary: 'Create a share link' })
  createShareLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateShareLinkDto,
  ) {
    return this.sharing.createShareLink(user, projectId, dto);
  }

  @Delete('share-links/:linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivateShareLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<void> {
    return this.sharing.deactivateShareLink(user, projectId, linkId);
  }

  @Patch('members/:memberId')
  updateMemberRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.sharing.updateMemberRole(user, projectId, memberId, dto.role);
  }

  @Delete('members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke access (or leave, for your own membership)',
  })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<void> {
    return this.sharing.removeMember(user, projectId, memberId);
  }
}

/**
 * Token-based entry points. Previews are public (the accept page renders
 * before sign-in); joining needs an account. Throttled like credential routes
 * because share-link passwords are guessable secrets.
 */
@ApiTags('sharing')
@Controller()
export class SharingTokensController {
  constructor(private readonly sharing: SharingService) {}

  @Public()
  @AuthThrottle()
  @Get('invitations/:token')
  @ApiOperation({ summary: 'Preview a project invitation' })
  previewInvitation(@Param('token') token: string) {
    return this.sharing.previewInvitation(token);
  }

  @ApiBearerAuth()
  @AuthThrottle()
  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a project invitation (email must match)' })
  acceptInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ) {
    return this.sharing.acceptInvitation(user, token);
  }

  @Public()
  @AuthThrottle()
  @Get('share-links/:token')
  @ApiOperation({ summary: 'Preview a share link' })
  previewShareLink(@Param('token') token: string) {
    return this.sharing.previewShareLink(token);
  }

  @ApiBearerAuth()
  @AuthThrottle()
  @Post('share-links/:token/access')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a project through a share link' })
  accessShareLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
    @Body() dto: AccessShareLinkDto,
  ) {
    return this.sharing.accessShareLink(user, token, dto.password);
  }
}
