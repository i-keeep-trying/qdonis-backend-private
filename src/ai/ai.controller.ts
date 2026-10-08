import {
  Body,
  Controller,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService } from './ai.service';
import { BedrockError } from './bedrock.client';
import { ConverseDto } from './dto/converse.dto';

const HEARTBEAT_MS = 20_000;

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly ai: AiService) {}

  /**
   * Runs one Bedrock Converse call and answers as Server-Sent Events:
   * comment heartbeats every 20 s (keeps proxies from timing out long
   * generations), then one `data:` event — `{done, content, usage, charged,
   * balance}` or `{error}`. Validation, auth and balance failures arrive
   * before the stream as normal JSON errors (402 INSUFFICIENT_TOKENS, ...).
   */
  @Post('bedrock/converse')
  @ApiOperation({ summary: 'AI completion, charged to my token balance' })
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  async converse(
    @CurrentUser('id') userId: string,
    @Body() dto: ConverseDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const modelId = await this.ai.prepare(userId, dto);

    const aborter = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) aborter.abort();
    });

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    const send = (payload: unknown) => {
      if (!response.writableEnded)
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);

    try {
      const outcome = await this.ai.converse(
        userId,
        modelId,
        dto,
        aborter.signal,
      );
      send({ done: true, ...outcome });
    } catch (error) {
      if (error instanceof BedrockError || error instanceof HttpException) {
        send({ error: error.message });
      } else {
        this.logger.error(
          `AI call failed for ${userId} (${typeof request.id === 'string' ? request.id : 'n/a'}): ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        send({ error: 'The AI request failed; please retry' });
      }
    } finally {
      clearInterval(heartbeat);
      response.end();
    }
  }
}
