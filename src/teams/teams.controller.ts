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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuthThrottle } from '../common/decorators/auth-throttle.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  CreateTeamDto,
  InviteTeamMemberDto,
  TeamUsageQueryDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from './dto/team.dto';
import { TeamsService } from './teams.service';

@ApiTags('teams')
@ApiBearerAuth()
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a team (Teams plan)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTeamDto) {
    return this.teams.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Teams I own or belong to' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.teams.listMine(user);
  }

  /** Declared before `:teamId` so it is not captured by it. */
  @Get('invitations/mine')
  @ApiOperation({ summary: 'Pending team invitations sent to my email' })
  myInvitations(@CurrentUser() user: AuthenticatedUser) {
    return this.teams.myInvitations(user);
  }

  @Public()
  @AuthThrottle()
  @Get('invitations/:token')
  @ApiOperation({ summary: 'Preview a team invitation' })
  previewInvitation(@Param('token') token: string) {
    return this.teams.previewInvitation(token);
  }

  @AuthThrottle()
  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a team (email must match)' })
  acceptInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ) {
    return this.teams.acceptInvitation(user, token);
  }

  @Get(':teamId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ) {
    return this.teams.get(user, teamId);
  }

  @Patch(':teamId')
  @ApiOperation({ summary: 'Rename / change the token cap (owner)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teams.update(user, teamId, dto);
  }

  @Delete(':teamId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete the team; its projects become personal (owner)',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<void> {
    return this.teams.remove(user, teamId);
  }

  @Get(':teamId/members')
  members(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ) {
    return this.teams.members(user, teamId);
  }

  @Patch(':teamId/members/:userId')
  updateMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    return this.teams.updateMemberRole(user, teamId, userId, dto.role);
  }

  @Delete(':teamId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member (or yourself, to leave)' })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.teams.removeMember(user, teamId, userId);
  }

  @Post(':teamId/invitations')
  @AuthThrottle()
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: InviteTeamMemberDto,
  ) {
    return this.teams.invite(user, teamId, dto);
  }

  @Get(':teamId/invitations')
  invitations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ) {
    return this.teams.invitations(user, teamId);
  }

  @Delete(':teamId/invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancelInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ): Promise<void> {
    return this.teams.cancelInvitation(user, teamId, invitationId);
  }

  @Get(':teamId/tokens')
  @ApiOperation({ summary: 'Team token cap, spend and the owner pool' })
  tokens(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ) {
    return this.teams.tokenSummary(user, teamId);
  }

  @Get(':teamId/usage')
  @ApiOperation({ summary: 'Tokens spent per member (owner/admin)' })
  usage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Query() query: TeamUsageQueryDto,
  ) {
    return this.teams.usageByMember(user, teamId, query);
  }
}
