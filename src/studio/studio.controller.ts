import { Body, Controller, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { StudioAgentService } from './agent/studio-agent.service';
import { StudioAgentRequestDto } from './dto/studio-agent.dto';
import { STUDIO_ERROR_PREFIX } from './studio.types';

const HEARTBEAT_MS = 20_000;

@ApiTags('studio')
@ApiBearerAuth()
@Controller('studio')
export class StudioController {
  private readonly logger = new Logger(StudioController.name);

  constructor(private readonly agent: StudioAgentService) {}

  /**
   * Runs ONE Studio agent step and streams it as Server-Sent Events, in the
   * same event format as the qdonis-core endpoint it replaces:
   * `{type:'text',text}` deltas, then `{type:'tool_call',id,name,input}` per
   * tool the client must run, then `{type:'done',usage,stop_reason,model}`,
   * or a single `{type:'error',error}`. `: heartbeat` comments keep proxies
   * open while the model works. Auth, validation and balance failures arrive
   * before the stream as normal JSON errors (401, 400, 402
   * INSUFFICIENT_TOKENS, 503 AI_NOT_CONFIGURED).
   */
  @Post('agent')
  @ApiOperation({
    summary: 'One Studio agent step (SSE), charged to my token balance',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'text/event-stream of agent events' })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  @ApiServiceUnavailableResponse({ description: 'AI_NOT_CONFIGURED' })
  async agentStep(
    @CurrentUser('id') userId: string,
    @Body() dto: StudioAgentRequestDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const modelId = await this.agent.prepare(userId);

    const aborter = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) aborter.abort();
    });

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('Connection', 'close');
    response.flushHeaders();

    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    try {
      for await (const event of this.agent.runStep(
        userId,
        modelId,
        dto,
        aborter.signal,
      )) {
        if (response.writableEnded) break;
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      this.logger.error(
        `Studio agent stream failed for ${userId} (${typeof request.id === 'string' ? request.id : 'n/a'}): ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (!response.writableEnded) {
        response.write(
          `data: ${JSON.stringify({ type: 'error', error: `${STUDIO_ERROR_PREFIX}The AI request failed; please retry` })}\n\n`,
        );
      }
    } finally {
      clearInterval(heartbeat);
      response.end();
    }
  }
}
