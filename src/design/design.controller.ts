import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DesignService } from './design.service';
import {
  AnalyzeDesignIntentDto,
  EditDesignParameterDto,
  GenerateConstraintsDto,
  ProcessRequirementsDto,
  RecommendTopologiesDto,
  UpdateConstraintsDto,
  UpdateSpecsDto,
} from './dto/design.dto';
import { streamResult } from './sse-result';

const SSE_DOC =
  'Server-Sent Events: `: heartbeat` comments, then one `data:` event `{done, result}` or `{error}`. Pre-checks fail as normal JSON errors (402 INSUFFICIENT_TOKENS, 404, 400).';

const requestId = (req: Request): string | undefined =>
  typeof req.id === 'string' ? req.id : undefined;

@ApiTags('design')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class DesignController {
  constructor(private readonly design: DesignService) {}

  @Post('name/generate')
  @ApiOperation({
    summary: 'Generate a project name from the requirements (AI)',
    description: SSE_DOC,
  })
  @ApiProduces('text/event-stream')
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  async generateName(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const work = await this.design.prepareName(user, projectId);
    await streamResult(res, work, requestId(req));
  }

  @Post('design-intent/analyze')
  @ApiOperation({
    summary: 'Design intent: stage-specific + mandatory parameters (AI)',
    description: SSE_DOC,
  })
  @ApiProduces('text/event-stream')
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  async analyzeDesignIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: AnalyzeDesignIntentDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const work = await this.design.prepareDesignIntent(user, projectId, dto);
    await streamResult(res, work, requestId(req));
  }

  @Patch('design-intent/parameters')
  @ApiOperation({
    summary: 'Review a mandatory parameter (set, accept, approve, reset)',
  })
  editDesignParameter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: EditDesignParameterDto,
  ) {
    return this.design.editDesignParameter(user, projectId, dto);
  }

  @Post('requirements/process')
  @ApiOperation({
    summary: 'Requirements -> engineering specification with citations (AI)',
    description: SSE_DOC,
  })
  @ApiProduces('text/event-stream')
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  async processRequirements(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ProcessRequirementsDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const work = await this.design.prepareRequirements(user, projectId, dto);
    await streamResult(res, work, requestId(req));
  }

  @Post('topologies/recommend')
  @ApiOperation({
    summary:
      'Top-3 topology recommendation (AI; cached for unchanged parameters)',
    description: SSE_DOC,
  })
  @ApiProduces('text/event-stream')
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  async recommendTopologies(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RecommendTopologiesDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const work = await this.design.prepareTopologies(user, projectId, dto);
    await streamResult(res, work, requestId(req));
  }

  // --- Studio specs stage ---------------------------------------------------------

  @Patch('studio/specs')
  @ApiOperation({
    summary: 'Merge spec rows (by name); content changes void approval',
  })
  @ApiOkResponse({ description: '{ ok, summary, payload, revision }' })
  updateSpecs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateSpecsDto,
  ) {
    return this.design.updateSpecs(user, projectId, dto);
  }

  @Post('studio/specs/approve')
  @HttpCode(HttpStatus.OK)
  approveSpecs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.design.approveSpecs(user, projectId);
  }

  @Patch('studio/constraints')
  @ApiOperation({
    summary: 'Edit constraints (merged by name; edits become source user)',
  })
  updateConstraints(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateConstraintsDto,
  ) {
    return this.design.updateConstraints(user, projectId, dto);
  }

  @Post('studio/constraints/generate')
  @ApiOperation({
    summary:
      'Generate the full engineering constraints list from the specs (AI)',
    description: SSE_DOC,
  })
  @ApiProduces('text/event-stream')
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  async generateConstraints(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: GenerateConstraintsDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const work = await this.design.prepareConstraints(user, projectId, dto);
    await streamResult(res, work, requestId(req));
  }
}
