import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseGraphIdPipe } from '../projects/dto/studio-graph.dto';
import { EditConstraintsDto, ReplaceSpecsDto } from './dto/specs.dto';
import { SpecsService } from './specs.service';

const STAGE_RESULT =
  'Answers `{ node, branchId, forked, branchName, workspaceVersion }`. Later work on the branch makes the result fork a new branch.';

@ApiTags('studio stages')
@ApiBearerAuth()
@Controller('projects/:projectId/branches/:branchId/stages')
export class SpecsController {
  constructor(private readonly specs: SpecsService) {}

  @Put('specs')
  @ApiOperation({
    summary: 'Replace the key spec table (Specs stage)',
    description: `${STAGE_RESULT} A content change voids the approval and the topology suggestions.`,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND' })
  replace(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: ReplaceSpecsDto,
  ) {
    return this.specs.replace(user, projectId, branchId, dto);
  }

  @Post('specs/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve the spec table',
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING: no specs yet' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
  ) {
    return this.specs.approve(user, projectId, branchId);
  }

  @Post('specs/constraints')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Generate the engineering constraints list from the specs (AI, charged)',
    description: `${STAGE_RESULT} \`constraints.status\` is \`running\` until the list lands; poll the stage. Hand-set items are kept.`,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  @ApiConflictResponse({
    description: 'STAGE_INPUT_MISSING: no specs; STAGE_RUNNING',
  })
  generateConstraints(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
  ) {
    return this.specs.generateConstraints(user, projectId, branchId);
  }

  @Put('specs/constraints')
  @ApiOperation({
    summary:
      'Set values of constraints (by id); edited items become the user’s',
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({
    description: 'STAGE_INPUT_MISSING: no constraints list; STAGE_RUNNING',
  })
  editConstraints(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: EditConstraintsDto,
  ) {
    return this.specs.editConstraints(user, projectId, branchId, dto);
  }
}
