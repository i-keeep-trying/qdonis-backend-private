import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseGraphIdPipe } from '../projects/dto/studio-graph.dto';
import {
  AiFixDesignDto,
  ModifyDesignDto,
  RunSimulationDto,
  SelectDevicesDto,
  SetDesignValuesDto,
  VerifySimulationDto,
  UpdateDesignDecksDto,
} from './dto/simulation.dto';
import { SimulationService } from './simulation.service';

const STAGE_RESULT =
  'Answers `{ node, branchId, forked, branchName, workspaceVersion }`. Later work on the branch makes the result fork a new branch.';

@ApiTags('studio stages')
@ApiBearerAuth()
@Controller('projects/:projectId/branches/:branchId/stages')
export class SimulationStagesController {
  constructor(private readonly simulation: SimulationService) {}

  @Post('design/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Build the SPICE decks of the branch's circuit (Design stage)",
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING: no circuit yet' })
  runDesign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
  ) {
    return this.simulation.runDesign(user, projectId, branchId);
  }

  @Put('design/decks')
  @ApiOperation({
    summary: 'Replace SPICE decks of the design (hand edits)',
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING: no design yet' })
  updateDecks(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: UpdateDesignDecksDto,
  ) {
    return this.simulation.updateDesignDecks(
      user,
      projectId,
      branchId,
      dto.decks,
    );
  }

  @Patch('design/values')
  @ApiOperation({
    summary: 'Set component values and rebuild the decks',
    description: `${STAGE_RESULT} Hand-edited decks are replaced.`,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING: no design yet' })
  setValues(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: SetDesignValuesDto,
  ) {
    return this.simulation.setDesignValues(
      user,
      projectId,
      branchId,
      dto.values,
    );
  }

  @Post('design/modify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'AI change of the design decks from an instruction (charged)',
    description: `${STAGE_RESULT} The node is \`running\` until the model answers; poll the stage.`,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING: no design yet' })
  modifyDesign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: ModifyDesignDto,
  ) {
    return this.simulation.editDesign(
      user,
      projectId,
      branchId,
      'modify',
      dto.instruction,
    );
  }

  @Post('design/ai-fix')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'AI repair of the design decks (syntax, convergence; charged)',
    description: `${STAGE_RESULT} The \`.end\` / \`.control\` part of each deck is kept verbatim.`,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING: no design yet' })
  aiFixDesign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: AiFixDesignDto,
  ) {
    return this.simulation.editDesign(
      user,
      projectId,
      branchId,
      'fix',
      dto.instruction ?? '',
    );
  }

  @Post('devices/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Select the power devices (entered stresses, or the simulation)',
    description: `${STAGE_RESULT} Without \`inputs\` the parts are chosen on the branch simulation's waveforms and its losses are updated.`,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({
    description: 'STAGE_INPUT_MISSING: no simulation (or its waveforms)',
  })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_NOT_CONFIGURED' })
  selectDevices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: SelectDevicesDto,
  ) {
    return this.simulation.selectDevices(user, projectId, branchId, dto);
  }

  @Post('simulation/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue ngspice on the design decks (Simulation stage)',
    description: `${STAGE_RESULT} The node is \`running\` until the run finishes; poll the stage.`,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING: no design yet' })
  runSimulation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: RunSimulationDto,
  ) {
    return this.simulation.runSimulation(
      user,
      projectId,
      branchId,
      dto.analyses,
    );
  }
}

@ApiTags('studio stages')
@ApiBearerAuth()
@Controller('projects/:projectId/simulations')
export class SimulationWaveformsController {
  constructor(private readonly simulation: SimulationService) {}

  @Get(':nodeId/waveforms')
  @ApiOperation({
    summary: 'Plot samples of a simulation result (`{ plots }`)',
    description: 'Empty `plots` while the run is not finished.',
  })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, NODE_NOT_FOUND' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_NOT_CONFIGURED' })
  waveforms(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('nodeId', ParseGraphIdPipe) nodeId: string,
  ) {
    return this.simulation.waveforms(user, projectId, nodeId);
  }

  @Get(':nodeId/waveforms/url')
  @ApiOperation({
    summary: 'Signed CDN URL of the plot samples (gzipped `{ plots }`)',
    description:
      'Answers `{ url, expiresAt, encoding: "gzip" }`, or `{ url: null }` when the samples must be read through `GET …/waveforms` (simulations stored before the CDN layout, or not finished).',
  })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, NODE_NOT_FOUND' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_NOT_CONFIGURED' })
  waveformsUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('nodeId', ParseGraphIdPipe) nodeId: string,
  ) {
    return this.simulation.waveformsUrl(user, projectId, nodeId);
  }

  @Post(':nodeId/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a requested netlist change against a finished simulation',
    description:
      'Answers `{ verification: { status, summary, evidence, limitations }, metadata }`. Charged; changes nothing.',
  })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, NODE_NOT_FOUND' })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('nodeId', ParseGraphIdPipe) nodeId: string,
    @Body() dto: VerifySimulationDto,
  ) {
    return this.simulation.verifySimulation(user, projectId, nodeId, dto);
  }
}
