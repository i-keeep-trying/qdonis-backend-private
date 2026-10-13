import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { documentUpload, requireFile } from '../storage/files.controller';
import {
  AnswerWidgetDto,
  SendChatMessageDto,
  UploadAttachmentDto,
} from './dto/studio-chat.dto';
import { type ChatRun, StudioChatService } from './studio-chat.service';

const HEARTBEAT_MS = 20_000;

const STREAM_DOC =
  'Server-Sent Events, `event:` = the event type, `data:` = the event (`run.accepted`, `message.started`, `text.delta`, `tool.started`, `tool.finished`, `widget`, `workspace.updated`, `usage`, then `run.completed` / `run.cancelled` / `run.failed`). Access, validation and balance failures are answered before the stream as normal JSON errors.';

@ApiTags('studio chat')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class StudioChatController {
  private readonly logger = new Logger(StudioChatController.name);

  constructor(private readonly chat: StudioChatService) {}

  @Post('chat/messages')
  @ApiOperation({
    summary:
      'Send a chat message; Q answers and runs Studio tools (SSE, charged)',
    description: STREAM_DOC,
  })
  @ApiProduces('text/event-stream')
  @ApiForbiddenResponse({ description: 'View-only project' })
  @ApiPaymentRequiredResponse({ description: 'INSUFFICIENT_TOKENS' })
  @ApiConflictResponse({ description: 'CHAT_BUSY, IDEMPOTENCY_CONFLICT' })
  @ApiServiceUnavailableResponse({ description: 'AI_NOT_CONFIGURED' })
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SendChatMessageDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.chat.prepareSend(user, projectId, dto);
    await this.stream(res, run, req);
  }

  @Post('chat/widgets/:widgetId/answer')
  @ApiOperation({
    summary:
      'Answer a question / card / approval in the chat; starts the next turn (SSE)',
    description: STREAM_DOC,
  })
  @ApiProduces('text/event-stream')
  @ApiConflictResponse({ description: 'CHAT_BUSY, WIDGET_ANSWERED' })
  async answer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('widgetId') widgetId: string,
    @Body() dto: AnswerWidgetDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.chat.prepareAnswer(
      user,
      projectId,
      widgetId.slice(0, 100),
      dto,
    );
    await this.stream(res, run, req);
  }

  @Get('chat/runs/active')
  @ApiOperation({
    summary: 'My turn still running in this project (null when Q is idle)',
    description:
      'A turn keeps running when the client disconnects; a client that comes back polls the message list until this is null.',
  })
  @ApiOkResponse({ description: '`{ run: { runId, messageId } | null }`' })
  activeRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.chat.activeRun(user, projectId);
  }

  @Post('chat/runs/:runId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Stop the running turn (the stream ends with run.cancelled)',
  })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<void> {
    return this.chat.cancel(user, projectId, runId);
  }

  @Post('attachments')
  @UseInterceptors(documentUpload())
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'kind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        kind: { type: 'string', enum: ['netlist', 'document'] },
      },
    },
  })
  @ApiOperation({
    summary:
      'Attach a file to the next chat message (stored in S3, never executed)',
  })
  @ApiOkResponse({ description: '`{ id, name, kind, sizeBytes, lineCount }`' })
  @ApiServiceUnavailableResponse({ description: 'STORAGE_NOT_CONFIGURED' })
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadAttachmentDto,
  ) {
    return this.chat.uploadAttachment(
      user,
      projectId,
      requireFile(file),
      dto.kind,
    );
  }

  /**
   * Streams a run. A client that disconnects (refresh, closed tab) does not
   * stop it: the turn finishes and is stored; the client picks it up again
   * through `GET chat/runs/active` and the message list.
   */
  private async stream(
    res: Response,
    run: ChatRun,
    req: Request,
  ): Promise<void> {
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const open = () => !closed && !res.writableEnded;
    const heartbeat = setInterval(() => {
      if (open()) res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    try {
      await run((event) => {
        if (open()) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      });
    } catch (error) {
      this.logger.error(
        `Studio chat stream failed (${typeof req.id === 'string' ? req.id : 'n/a'}): ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (open()) {
        const failed = {
          type: 'run.failed',
          messageId: null,
          error: {
            statusCode: 500,
            error: 'Internal Server Error',
            code: 'INTERNAL_ERROR',
            message: 'Q stopped unexpectedly. Retry to send the message again.',
          },
        };
        res.write(`event: run.failed\ndata: ${JSON.stringify(failed)}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }
}
