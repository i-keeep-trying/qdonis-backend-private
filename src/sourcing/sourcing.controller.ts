import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { streamResult } from '../design/sse-result';
import { ProjectAccessService } from '../projects/project-access.service';
import { KeywordSearchDto, MOUSER_PART_PATTERN, SpecSearchDto } from './dto/sourcing.dto';
import { SourcingService } from './sourcing.service';

/**
 * Supplier (Mouser) search through the server, which holds the API key,
 * the quota and the cache. Spec searches are slow by design (paced calls),
 * so they stream like the AI steps.
 */
@ApiTags('sourcing')
@ApiBearerAuth()
@Controller('sourcing/mouser')
export class SourcingController {
  constructor(
    private readonly sourcing: SourcingService,
    private readonly access: ProjectAccessService,
  ) {}

  private async projectFor(user: AuthenticatedUser, projectId?: string): Promise<string | null> {
    if (!projectId) return null;
    await this.access.require(user, projectId);
    return projectId;
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Keyword search (manual part search)' })
  async search(@CurrentUser() user: AuthenticatedUser, @Body() dto: KeywordSearchDto) {
    const projectId = await this.projectFor(user, dto.projectId);
    return this.sourcing.keywordSearch({ userId: user.id, projectId }, dto);
  }

  @Get('parts/:mouserPartNumber')
  @ApiOperation({ summary: 'Full details of one Mouser part number' })
  async part(@CurrentUser() user: AuthenticatedUser, @Param('mouserPartNumber') mouserPartNumber: string) {
    if (!MOUSER_PART_PATTERN.test(mouserPartNumber)) {
      throw AppError.badRequest(ErrorCode.ValidationFailed, 'invalid part number');
    }
    const part = await this.sourcing.partDetails({ userId: user.id }, mouserPartNumber);
    if (!part) throw AppError.notFound(ErrorCode.FileNotFound, 'Part not found');
    return part;
  }

  @Post('search-by-specs')
  @ApiOperation({
    summary: 'Search every listed component by its specs (cached; SSE)',
    description: 'Heartbeats, then one `data:` event `{done, result}` or `{error}`.',
  })
  @ApiProduces('text/event-stream')
  async searchBySpecs(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SpecSearchDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const projectId = await this.projectFor(user, dto.projectId);
    const all = dto.components;
    await streamResult(
      res,
      (signal) =>
        this.sourcing.searchMany(
          { userId: user.id, projectId, signal },
          all.map((c) => ({ name: c.name, specs: c.specs, keyword: c.keyword })),
          dto.maxResults,
        ),
      typeof req.id === 'string' ? req.id : undefined,
    );
  }
}
