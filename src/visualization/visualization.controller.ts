import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseGraphIdPipe } from '../projects/dto/studio-graph.dto';
import { SelectTopologyDto } from './dto/select-topology.dto';
import { VisualizationService } from './visualization.service';

@ApiTags('studio stages')
@ApiBearerAuth()
@Controller('projects/:projectId/branches/:branchId/stages')
export class VisualizationController {
  constructor(private readonly visualization: VisualizationService) {}

  @Post('visualization')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pick a library topology for the branch (Circuit stage)',
    description:
      'Answers `{ node, branchId, forked, branchName, workspaceVersion }`. A branch that already has another circuit keeps it; the pick lands on a new branch.',
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({
    description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND, TOPOLOGY_NOT_FOUND',
  })
  select(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: SelectTopologyDto,
  ) {
    return this.visualization.selectTopology(
      user,
      projectId,
      branchId,
      dto.topologyId,
    );
  }
}
