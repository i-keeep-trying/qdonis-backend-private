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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { BomService } from './bom.service';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ParseGraphIdPipe } from '../projects/dto/studio-graph.dto';
import {
  RunBomStageDto,
  RunMagneticsStageDto,
  RunMtbfStageDto,
  RunThermalStageDto,
} from './dto/stage-runs.dto';
import {
  BomExportDto,
  BomQuantityDto,
  EmcParametersDto,
  EmcSpectrumDto,
  MtbfDto,
  RunMagneticsDto,
  RunThermalDto,
} from './dto/stages.dto';
import { StudioStagesService } from './studio-stages.service';

const STAGE_DOC =
  'Answers `{ ok, summary, payload, revision }`. `ok: false` (HTTP 200) means inputs are missing; `payload` lists them.';

@ApiTags('studio stages')
@ApiBearerAuth()
@Controller('projects/:projectId/studio')
export class StudioStagesController {
  constructor(private readonly stages: StudioStagesService) {}

  @Post('magnetics')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Design the magnetic parts (entered parts, or the branch circuit)',
    description: STAGE_DOC,
  })
  magnetics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RunMagneticsDto,
  ) {
    return this.stages.runMagnetics(user, projectId, dto);
  }

  @Post('thermal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Thermal & loss analysis (entered losses, Devices stage, or simulation)',
    description: STAGE_DOC,
  })
  thermal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RunThermalDto,
  ) {
    return this.stages.runThermal(user, projectId, dto);
  }
}

const STAGE_RESULT =
  'Answers `{ node, branchId, forked, branchName, workspaceVersion }`. Later work on the branch makes the result fork a new branch.';

@ApiTags('studio stages')
@ApiBearerAuth()
@Controller('projects/:projectId/branches/:branchId/stages')
export class StudioStageRunsController {
  constructor(
    private readonly stages: StudioStagesService,
    private readonly boms: BomService,
  ) {}

  @Post('magnetics/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Design the magnetic parts of the branch (circuit, or entered parts)',
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING' })
  magnetics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: RunMagneticsStageDto,
  ) {
    return this.stages.runMagneticsStage(user, projectId, branchId, dto);
  }

  @Post('thermal/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Thermal analysis of the branch (simulation, Devices stage, or entered losses)',
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING' })
  thermal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: RunThermalStageDto,
  ) {
    return this.stages.runThermalStage(user, projectId, branchId, dto);
  }

  @Post('mtbf/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'MTBF of the branch (circuit parts with their simulated stresses and temperatures, or entered parts)',
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING' })
  mtbf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: RunMtbfStageDto,
  ) {
    return this.stages.runMtbfStage(user, projectId, branchId, dto);
  }

  @Post('bom/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'BOM of the branch (circuit parts, selected devices, custom magnetics, heatsink), with line changes',
    description: STAGE_RESULT,
  })
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiNotFoundResponse({ description: 'PROJECT_NOT_FOUND, BRANCH_NOT_FOUND' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING' })
  bom(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: RunBomStageDto,
  ) {
    return this.stages.runBomStage(user, projectId, branchId, dto);
  }

  @Post('bom/export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Generate the branch BOM file (stored in S3) and a signed download URL',
  })
  @ApiForbiddenResponse({ description: 'No export permission' })
  @ApiConflictResponse({ description: 'STAGE_INPUT_MISSING (no BOM yet)' })
  bomExport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('branchId', ParseGraphIdPipe) branchId: string,
    @Body() dto: BomExportDto,
  ) {
    return this.boms.exportStage(user, projectId, branchId, dto.format);
  }
}

@ApiTags('reliability')
@ApiBearerAuth()
@Controller('projects/:projectId/mtbf')
export class ProjectMtbfController {
  constructor(private readonly stages: StudioStagesService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "MTBF of the project's selected parts (stored on the project)",
  })
  calculate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: MtbfDto,
  ) {
    return this.stages.projectMtbf(user, projectId, dto);
  }
}

@ApiTags('bom')
@ApiBearerAuth()
@Controller('projects/:projectId/bom')
export class BomController {
  constructor(private readonly bom: BomService) {}

  @Get()
  @ApiOperation({
    summary: 'Bill of materials of the selected parts, with totals',
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.bom.get(user, projectId);
  }

  @Patch('parts/:partId')
  @ApiOperation({ summary: 'Change the quantity of one selected part' })
  setQuantity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('partId') partId: string,
    @Body() dto: BomQuantityDto,
  ) {
    return this.bom.setQuantity(user, projectId, partId, dto.quantity);
  }

  @Post('export')
  @ApiOperation({
    summary: 'Generate the BOM file (stored in S3) and a signed download URL',
  })
  export(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: BomExportDto,
  ) {
    return this.bom.export(user, projectId, dto.format);
  }
}

/** Stateless engineering calculators (no project needed). */
@ApiTags('calculators')
@ApiBearerAuth()
@Controller('calculators')
export class CalculatorsController {
  constructor(private readonly stages: StudioStagesService) {}

  @Post('emc/scan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'PFC boost conducted-emissions scan (108-264 V)' })
  emcScan(@Body() dto: EmcParametersDto) {
    return this.stages.emcScan(dto);
  }

  @Post('emc/spectrum')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Emission spectrum and EN 55015 limits at one input voltage',
  })
  emcSpectrum(@Body() dto: EmcSpectrumDto) {
    return this.stages.emcSpectrum(dto);
  }

  @Get('mtbf/options')
  @ApiOperation({ summary: 'Prediction methods and their environments' })
  mtbfOptions() {
    return this.stages.mtbfOptions();
  }

  @Post('mtbf')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'MTBF prediction for the given parts' })
  mtbf(@Body() dto: MtbfDto) {
    return this.stages.calculateMtbf(dto);
  }

  @Get('magnetics/options')
  @ApiOperation({
    summary: 'Cores and materials known to the magnetics engine',
  })
  magneticsOptions() {
    return this.stages.magneticsOptions();
  }
}
