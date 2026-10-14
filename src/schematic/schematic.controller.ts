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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseGraphIdPipe } from '../projects/dto/studio-graph.dto';
import { RenderSchematicDto, SchematicEditDto } from './dto/schematic.dto';
import { SchematicService } from './schematic.service';

@ApiTags('studio stages')
@ApiBearerAuth()
@Controller(
  'projects/:projectId/branches/:branchId/stages/visualization/schematic',
)
export class SchematicController {
  constructor(private readonly schematic: SchematicService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Draw one sheet of the branch circuit (synced schematic)',
    description:
      'Answers `{ schematic, layout, sheet, sheets, palette, basis, groupsExplicit, seededFromDrawing, libraryLayout }`. The drawing is derived from the circuit that is simulated; positions come from the project layout over the library layout.',
  })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, SHEET_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING (no circuit yet)' })
  render(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: RenderSchematicDto,
  ) {
    return this.schematic.render(user, projectId, branchId, dto);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'What an edited drawing would change in the circuit (nothing is stored)',
    description:
      'Answers `{ layoutOnly, layout, paramChanges, added, removed, rewired, changes, errors, inventory }`.',
  })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED (malformed drawing)',
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, SHEET_NOT_FOUND' })
  check(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: SchematicEditDto,
  ) {
    return this.schematic.check(user, projectId, branchId, dto);
  }

  @Post('apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply an edited drawing to the circuit',
    description:
      'Answers `{ node, branchId, forked, branchName, workspaceVersion, changes }`. Moves only update the Circuit node in place; circuit changes record the edited circuit, on a new branch when later stages build on it.',
  })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, SCHEMATIC_INVALID (the edit has errors)',
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, SHEET_NOT_FOUND' })
  @ApiConflictResponse({
    description: 'REVISION_CONFLICT (the circuit changed meanwhile)',
  })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: SchematicEditDto,
  ) {
    return this.schematic.apply(user, projectId, branchId, dto);
  }
}
