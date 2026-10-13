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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  ActivityQueryDto,
  CreateProjectDto,
  CreateVersionDto,
  DuplicateProjectDto,
  ListProjectsQueryDto,
  SaveStudioDto,
  UpdateProjectDto,
} from './dto/project.dto';
import {
  ProjectAccessEntity,
  ProjectDetailEntity,
  ProjectSummaryEntity,
  ProjectVersionEntity,
  SaveResultEntity,
} from './entities/project.entity';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a project (optionally in a team, from a prompt)',
  })
  @ApiCreatedResponse({ type: ProjectDetailEntity })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProjectDto,
  ): Promise<ProjectDetailEntity> {
    return this.projects.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Projects I can open (owned, shared, team)' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListProjectsQueryDto,
  ) {
    return this.projects.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A project with its data and Studio graph' })
  @ApiOkResponse({ type: ProjectDetailEntity })
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProjectDetailEntity> {
    return this.projects.detail(user, id);
  }

  @Get(':id/access')
  @ApiOperation({ summary: 'My role and permissions on a project' })
  @ApiOkResponse({ type: ProjectAccessEntity })
  async access(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProjectAccessEntity> {
    return new ProjectAccessEntity(await this.projects.accessOf(user, id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename / describe a project (editors)' })
  @ApiOkResponse({ type: ProjectSummaryEntity })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ): Promise<ProjectSummaryEntity> {
    return this.projects.update(user, id, dto);
  }

  @Put(':id/studio')
  @ApiOperation({
    summary: 'Save the Studio graph (compare-and-swap on revision)',
  })
  @ApiOkResponse({ type: SaveResultEntity })
  @ApiConflictResponse({
    description: 'REVISION_CONFLICT, meta.currentRevision',
  })
  saveStudio(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveStudioDto,
  ): Promise<SaveResultEntity> {
    return this.projects.saveStudio(user, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Owner: delete the project. Collaborator: leave it.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: boolean; left: boolean }> {
    return this.projects.remove(user, id);
  }

  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Copy a project (and its files) into my projects' })
  @ApiCreatedResponse({ type: ProjectDetailEntity })
  duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateProjectDto,
  ): Promise<ProjectDetailEntity> {
    return this.projects.duplicate(user, id, dto);
  }

  @Get(':id/versions')
  @ApiOkResponse({ type: ProjectVersionEntity, isArray: true })
  listVersions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProjectVersionEntity[]> {
    return this.projects.listVersions(user, id);
  }

  @Post(':id/versions')
  @ApiOperation({ summary: 'Snapshot the current project data' })
  @ApiCreatedResponse({ type: ProjectVersionEntity })
  createVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVersionDto,
  ): Promise<ProjectVersionEntity> {
    return this.projects.createVersion(user, id, dto);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SaveResultEntity })
  restoreVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<SaveResultEntity> {
    return this.projects.restoreVersion(user, id, versionId);
  }

  @Get(':id/activity')
  @ApiOperation({ summary: 'Activity feed' })
  activity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ActivityQueryDto,
  ) {
    return this.projects.activity(user, id, query);
  }
}
