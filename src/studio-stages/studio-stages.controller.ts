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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { BomService } from './bom.service';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
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
