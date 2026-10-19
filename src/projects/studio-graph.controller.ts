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
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CreateBranchDto,
  ParseGraphIdPipe,
  ParseStagePipe,
  RenameBranchDto,
  SetActiveBranchDto,
  SetEntryStepDto,
  WorkspaceQueryDto,
} from './dto/studio-graph.dto';
import { ProjectAccessService } from './project-access.service';
import type { StageKind } from './studio/studio-graph';
import { StudioGraphService } from './studio/studio-graph.service';

/**
 * The Studio graph of a project: branches, their results and the history.
 * Branches are shared by everyone with access; "my branch" is per user.
 * Viewers may read and switch branch; changing branches needs edit rights.
 */
@ApiTags('studio graph')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class StudioGraphController {
  constructor(
    private readonly graph: StudioGraphService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get('studio')
  @ApiOperation({ summary: 'Workspace: branches and the state of every stage' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND' })
  async workspace(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: WorkspaceQueryDto,
  ) {
    const access = await this.access.require(user, projectId);
    return this.graph.workspace(
      projectId,
      user.id,
      !access.permissions.canEdit,
      query.branchId,
    );
  }

  @Put('studio/active-branch')
  @ApiOperation({ summary: 'Switch my branch (viewers too)' })
  async setActiveBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SetActiveBranchDto,
  ) {
    const access = await this.access.require(user, projectId);
    await this.graph.setActiveBranch(projectId, user.id, dto.branchId);
    return this.graph.workspace(
      projectId,
      user.id,
      !access.permissions.canEdit,
    );
  }

  @Put('studio/entry-step')
  @ApiOperation({
    summary:
      'Choose the step the project starts at (editors; `specs` = full design). Refused once that step ran.',
  })
  @ApiConflictResponse({ description: 'ENTRY_STEP_LOCKED' })
  async setEntryStep(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SetEntryStepDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    await this.graph.chooseEntryStep(projectId, user.id, dto.step);
    return this.graph.workspace(projectId, user.id, false);
  }

  @Get('branches/:branchId/stages/:stage')
  @ApiOperation({
    summary: 'Latest result of a stage on a branch (null: none yet)',
  })
  async stage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Param('stage', ParseStagePipe) stage: StageKind,
  ) {
    await this.access.require(user, projectId);
    return this.graph.stage(projectId, user.id, branchId, stage);
  }

  @Post('branches')
  @ApiOperation({ summary: 'Create a branch and switch to it (editors)' })
  @ApiConflictResponse({ description: 'STUDIO_LIMIT_REACHED' })
  async createBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateBranchDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    return this.graph.createBranch(projectId, user.id, {
      name: dto.name,
      fromBranchId: dto.fromBranchId,
      ...(dto.fromNodeId !== undefined ? { atNodeId: dto.fromNodeId } : {}),
      forkBeforeStage: dto.forkBeforeStage,
    });
  }

  @Patch('branches/:branchId')
  @ApiOperation({ summary: 'Rename a branch (editors)' })
  @ApiConflictResponse({ description: 'BRANCH_NAME_TAKEN' })
  async renameBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: RenameBranchDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    return this.graph.renameBranch(projectId, user.id, branchId, dto.name);
  }

  @Delete('branches/:branchId')
  @ApiOperation({
    summary:
      'Delete a branch and the results only it has (editors; not the last one)',
  })
  @ApiConflictResponse({ description: 'LAST_BRANCH' })
  async deleteBranch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    return this.graph.deleteBranch(projectId, user.id, branchId);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Every result of every branch, laid out as a graph',
  })
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    await this.access.require(user, projectId);
    return this.graph.history(projectId, user.id);
  }

  @Post('history/:nodeId/checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Switch to the branch that has this result' })
  @ApiNotFoundResponse({ description: 'NODE_NOT_FOUND' })
  async checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('nodeId', ParseGraphIdPipe) nodeId: string,
  ) {
    await this.access.require(user, projectId);
    return this.graph.checkout(projectId, user.id, nodeId);
  }
}
