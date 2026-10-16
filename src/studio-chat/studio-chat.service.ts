import { randomUUID } from 'node:crypto';

import {
  HttpException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { BedrockError } from '../ai/bedrock/bedrock-errors';
import { BedrockClient } from '../ai/bedrock/bedrock.client';
import type { BedrockUsage, JsonObject } from '../ai/bedrock/bedrock.types';
import type { AuthenticatedUser } from '../auth/auth.types';
import { pythonStrip } from '../common/python/python-json';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { AiStepRunner, type StepPayer } from '../design/ai/ai-step.runner';
import { approveSpecs } from '../design/studio-specs.logic';
import { ChatSender, StoredFileKind } from '../generated/prisma/enums';
import type {
  Prisma,
  ProjectChatMessage,
  StoredFile,
} from '../generated/prisma/client';
import { ProjectChatRepository } from '../project-chat/project-chat.repository';
import { ProjectAccessService } from '../projects/project-access.service';
import type { ProjectAccess } from '../projects/project-permissions';
import { ProjectsService } from '../projects/projects.service';
import { STAGE_LABEL } from '../projects/studio/studio-graph';
import { StudioGraphService } from '../projects/studio/studio-graph.service';
import {
  allowedStages,
  FULL_SCOPE,
  nextSteps,
  readyOn,
  scopeOf,
} from '../projects/studio/studio-scope';
import { STUDIO_AGENT_STEP } from '../studio/studio.types';
import { namedSteps } from '../studio/agent/stage-contracts';
import { buildStudioRequest } from '../studio/agent/studio-request.builder';
import { isNetlistFile } from '../storage/document-text';
import { StoredFilesService } from '../storage/stored-files.service';
import { TopologiesService } from '../topologies/topologies.service';
import { buildAgentSnapshot } from './agent-snapshot';
import type {
  AnswerWidgetDto,
  SendChatMessageDto,
} from './dto/studio-chat.dto';
import {
  type ApiErrorBody,
  type AttachmentRef,
  type ChatBlock,
  type ChatMessageView,
  type ChatStreamEvent,
  type ChatWidget,
  type LlmTurn,
  type StudioChatMeta,
  VIEW_OF_STAGE,
  type WidgetAnswer,
} from './studio-chat.types';
import {
  type ChatAttachment,
  StudioToolsExecutor,
  TOOL_INFO,
  type ToolContext,
} from './studio-tools.executor';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

/** Writes one event to the open stream (a no-op once the client has gone). */
export type Emit = (event: ChatStreamEvent) => void;
/**
 * A run started after every check passed. It runs to the end even when the
 * client disconnects; only `cancel` (the Stop button) ends it early.
 */
export type ChatRun = (emit: Emit) => Promise<void>;

/** Model steps per turn (old frontend `MAX_STEPS`). */
const MAX_STEPS = 10;
/** Stored messages fed back to the model (old frontend `HISTORY_WINDOW`). */
const HISTORY_WINDOW = 60;
/** Tool results kept in the transcript are capped (they go back to the model). */
const RESULT_CHARS = 8_000;
/** Lines of an attached netlist shown to the model inline. */
const NETLIST_PREVIEW_LINES = 150;
const DOCUMENT_PREVIEW_CHARS = 12_000;
/** Tools that hand the turn back to the user. */
const BLOCKING_TOOLS = new Set(['ask_user', 'suggest_topologies']);

interface ActiveRun {
  runId: string;
  controller: AbortController;
  /** The assistant message being written, once it exists. */
  messageId: string | null;
}

/** Streamed text is stored at most this often, so a returning client sees it grow. */
const TEXT_SAVE_MS = 1_500;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stored metadata of a Studio chat message (null for older messages). */
function metaOf(row: ProjectChatMessage): StudioChatMeta | null {
  const meta = row.metadata;
  return isObject(meta) && meta.studio === 1
    ? (meta as unknown as StudioChatMeta)
    : null;
}

export function messageView(row: ProjectChatMessage): ChatMessageView {
  const meta = metaOf(row);
  const role = row.sender === ChatSender.USER ? 'user' : 'assistant';
  return {
    id: row.id,
    role,
    blocks: meta?.blocks ?? [{ type: 'text', text: row.content }],
    attachments: meta?.attachments ?? [],
    events: meta?.events ?? [],
    createdAt: row.createdAt.toISOString(),
    status: meta?.status ?? 'complete',
    error: meta?.error ?? null,
    branchId: meta?.branchId ?? null,
  };
}

/** The API error envelope of any failure (as the global filter would send it). */
function errorBody(error: unknown): ApiErrorBody {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const record = isObject(body) ? body : {};
    return {
      statusCode: error.getStatus(),
      error: typeof record.error === 'string' ? record.error : 'Error',
      message:
        typeof record.message === 'string' ? record.message : error.message,
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      ...(isObject(record.meta) ? { meta: record.meta } : {}),
    };
  }
  if (error instanceof BedrockError) {
    return {
      statusCode: 502,
      error: 'Bad Gateway',
      code: 'AI_ERROR',
      message: error.message,
    };
  }
  return {
    statusCode: 500,
    error: 'Internal Server Error',
    code: 'INTERNAL_ERROR',
    message: 'Q stopped unexpectedly. Retry to send the message again.',
  };
}

const clipJson = (value: unknown): unknown => {
  const text = JSON.stringify(value ?? {});
  return text.length > RESULT_CHARS
    ? { truncated: true, excerpt: `${text.slice(0, RESULT_CHARS)}…` }
    : value;
};

function describeAttachment(a: ChatAttachment): string {
  if (a.kind === 'netlist' && a.text) {
    const lines = a.text.split(/\r?\n/);
    const preview = lines.slice(0, NETLIST_PREVIEW_LINES).join('\n');
    return `[Attached netlist: ${a.name} — ${lines.length} lines]\n\`\`\`spice\n${preview}${lines.length > NETLIST_PREVIEW_LINES ? '\n…' : ''}\n\`\`\``;
  }
  return a.text
    ? `[Attached document: ${a.name}]\n${a.text.slice(0, DOCUMENT_PREVIEW_CHARS)}`
    : `[Attached document: ${a.name} (its text could not be read)]`;
}

/**
 * The Studio chat agent on the server (replaces the old frontend loop in
 * `lib/studio/agent.ts`): every turn streams the model, executes the tools
 * it asks for against the stage services, and keeps the conversation and
 * the model transcript in `project_chat_messages`. One run at a time per
 * person and project; every model step is charged (team pool for team
 * projects).
 */
@Injectable()
export class StudioChatService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StudioChatService.name);
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly chat: ProjectChatRepository,
    private readonly runner: AiStepRunner,
    private readonly bedrock: BedrockClient,
    private readonly tools: StudioToolsExecutor,
    private readonly topologies: TopologiesService,
    private readonly files: StoredFilesService,
    private readonly graph: StudioGraphService,
  ) {}

  // --- entry points (all checks happen before the stream opens) ------------------

  async prepareSend(
    user: Actor,
    projectId: string,
    dto: SendChatMessageDto,
  ): Promise<ChatRun> {
    const access = await this.access.require(user, projectId, 'canEdit');
    const text = dto.text.trim();
    if (!text && dto.attachmentIds.length === 0) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'Type a message or attach a file',
      );
    }
    if (await this.chat.exists(dto.clientMessageId)) {
      throw AppError.conflict(
        ErrorCode.IdempotencyConflict,
        'This message was already sent.',
      );
    }
    await this.projects.loadStudio(projectId, user.id, dto.branchId);
    const attachments = await this.attachmentsFor(projectId, dto.attachmentIds);
    const step = await this.runner.prepareStream({ actorId: user.id, access });
    // A step picked in the tool selector sets the entry step itself: the
    // model is told, it does not have to read it from the text.
    const requested = dto.requestedStep;
    if (requested) {
      await this.graph.chooseEntryStep(projectId, user.id, requested);
    }
    const run = this.claim(projectId, user.id);

    return async (emit) => {
      try {
        const picked = requested
          ? `[Tool selector] The user picked ${requested === 'specs' ? 'Start from scratch (full design)' : `the ${STAGE_LABEL[requested]} step`}; the entry step is set to \`${requested}\`.`
          : '';
        const llmText = [text, ...attachments.map(describeAttachment), picked]
          .filter(Boolean)
          .join('\n\n');
        const meta: StudioChatMeta = {
          studio: 1,
          blocks: text ? [{ type: 'text', text }] : [],
          attachments: attachments.map(refOf),
          events: [],
          status: 'complete',
          error: null,
          branchId: dto.branchId,
          llmText: llmText || '(continue)',
        };
        const row = await this.chat.create({
          id: dto.clientMessageId,
          projectId,
          userId: user.id,
          sender: ChatSender.USER,
          content: text,
          metadata: meta as unknown as Prisma.InputJsonObject,
        });
        emit({
          type: 'run.accepted',
          runId: run.runId,
          userMessage: messageView(row),
        });
        if (requested) {
          emit({
            type: 'workspace.updated',
            branchId: dto.branchId,
            stages: [],
            focus: VIEW_OF_STAGE[requested],
            forked: null,
            scopeChanged: true,
          });
        }
        await this.turn(
          {
            user,
            access,
            projectId,
            branchId: dto.branchId,
            after: row.createdAt,
          },
          step,
          null,
          emit,
          run,
        );
      } finally {
        this.release(projectId, user.id, run);
      }
    };
  }

  async prepareAnswer(
    user: Actor,
    projectId: string,
    widgetId: string,
    dto: AnswerWidgetDto,
  ): Promise<ChatRun> {
    const access = await this.access.require(user, projectId, 'canEdit');
    const row = await this.chat.findOne(projectId, user.id, dto.messageId);
    const meta = row ? metaOf(row) : null;
    const block = meta?.blocks.find(
      (b): b is Extract<ChatBlock, { type: 'widget' }> =>
        b.type === 'widget' && b.widget.id === widgetId,
    );
    if (!row || !meta || !block) {
      throw AppError.notFound(
        ErrorCode.WidgetNotFound,
        'This question is no longer available.',
      );
    }
    if (block.widget.resolution !== null) {
      throw AppError.conflict(
        ErrorCode.WidgetAnswered,
        'This question was already answered.',
      );
    }
    const answer = this.answerOf(block.widget, dto.answer as WidgetAnswer);
    const studio = await this.projects.loadStudio(projectId, user.id);
    const branchId =
      meta.branchId && studio.branches[meta.branchId]
        ? meta.branchId
        : studio.activeBranchId;
    const step = await this.runner.prepareStream({ actorId: user.id, access });
    // The choice of where to start is applied by the server, not the model.
    if (answer.step) {
      await this.graph.chooseEntryStep(projectId, user.id, answer.step);
    }
    const run = this.claim(projectId, user.id);

    return async (emit) => {
      try {
        emit({ type: 'run.accepted', runId: run.runId, userMessage: null });
        if (answer.step) {
          emit({
            type: 'workspace.updated',
            branchId,
            stages: [],
            focus: VIEW_OF_STAGE[answer.step],
            forked: null,
            scopeChanged: true,
          });
        }
        if (block.widget.kind === 'spec_approval' && answer.approve) {
          await this.projects.mutateStudio(
            projectId,
            user.id,
            (current) => {
              const outcome = approveSpecs(current);
              return outcome.result.ok ? outcome.project : current;
            },
            branchId,
          );
          emit({
            type: 'workspace.updated',
            branchId,
            stages: ['specs'],
            focus: null,
            forked: null,
          });
        }
        block.widget = {
          ...block.widget,
          resolution: answer.resolution,
          ...(block.widget.kind === 'spec_approval'
            ? { approved: answer.approve === true }
            : {}),
        };
        await this.chat.update(row.id, {
          metadata: meta as unknown as Prisma.InputJsonObject,
        });
        await this.turn(
          { user, access, projectId, branchId, after: new Date() },
          step,
          { role: 'user', content: [{ type: 'text', text: answer.llmText }] },
          emit,
          run,
        );
      } finally {
        this.release(projectId, user.id, run);
      }
    };
  }

  /** Stop: the open stream ends with `run.cancelled`; the partial reply is kept. */
  async cancel(user: Actor, projectId: string, runId: string): Promise<void> {
    await this.access.require(user, projectId);
    const run = this.active.get(this.key(projectId, user.id));
    if (run?.runId === runId) run.controller.abort();
  }

  /** The caller's turn still running in this project (a client that came back picks it up). */
  async activeRun(
    user: Actor,
    projectId: string,
  ): Promise<{ run: { runId: string; messageId: string | null } | null }> {
    await this.access.require(user, projectId);
    const run = this.active.get(this.key(projectId, user.id));
    return {
      run: run ? { runId: run.runId, messageId: run.messageId } : null,
    };
  }

  /**
   * Runs live in this process, so a reply still "streaming" after a restart
   * was cut off: it is stored as stopped, its running tools as failed.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows = await this.chat.streamingStudioMessages();
      for (const row of rows) {
        const meta = metaOf(row);
        if (!meta) continue;
        for (const block of meta.blocks) {
          if (block.type === 'tool' && block.status === 'running') {
            block.status = 'error';
            block.summary = 'Stopped';
          }
        }
        meta.status = 'stopped';
        await this.chat.update(row.id, {
          metadata: meta as unknown as Prisma.InputJsonObject,
        });
      }
      if (rows.length) {
        this.logger.warn(
          `Marked ${rows.length} interrupted chat replies as stopped`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Could not close interrupted chat replies: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A file for the next chat message, stored in S3 with its text. */
  async uploadAttachment(
    user: Actor,
    projectId: string,
    file: {
      originalname: string;
      buffer: Buffer;
      size: number;
      mimetype: string;
    },
    kind: 'netlist' | 'document',
  ): Promise<AttachmentRef> {
    await this.access.require(user, projectId, 'canEdit');
    const stored = await this.files.uploadDocument({
      ownerId: user.id,
      projectId,
      file: file,
    });
    const ref = this.attachmentRef(stored);
    if (kind === 'netlist' && ref.kind !== 'netlist') {
      throw AppError.badRequest(
        ErrorCode.UnsupportedFileType,
        'A netlist must be a SPICE file (.cir, .sp, .spice, .net, .ckt).',
      );
    }
    return ref;
  }

  // --- one turn ------------------------------------------------------------------

  private async turn(
    base: {
      user: Actor;
      access: ProjectAccess;
      projectId: string;
      branchId: string;
      after: Date;
    },
    step: { modelId: string; payer: StepPayer },
    preface: LlmTurn | null,
    emit: Emit,
    run: ActiveRun,
  ): Promise<void> {
    const { user, access, projectId } = base;
    const signal = run.controller.signal;
    const history = await this.chat.recent(projectId, user.id, HISTORY_WINDOW);
    const attachments = await this.conversationAttachments(projectId, history);
    const ctx: ToolContext = {
      user,
      projectId,
      branchId: base.branchId,
      attachments,
      signal,
      newId: (prefix) => `${prefix}_${randomUUID().slice(0, 12)}`,
      // Read from the graph at the start of every model step.
      scope: FULL_SCOPE,
      named: namedSteps(
        history.findLast((row) => row.sender === ChatSender.USER)?.content ??
          '',
      ),
      checked: new Set(),
    };

    const llm: LlmTurn[] = preface ? [preface] : [];
    const blocks: ChatBlock[] = [];
    const meta: StudioChatMeta = {
      studio: 1,
      blocks,
      attachments: [],
      events: [],
      status: 'streaming',
      error: null,
      branchId: ctx.branchId,
      llm,
    };
    const createdAt = new Date(Math.max(Date.now(), base.after.getTime() + 1));
    const row = await this.chat.create({
      id: randomUUID(),
      projectId,
      userId: user.id,
      sender: ChatSender.AI,
      content: '',
      createdAt,
      metadata: meta as unknown as Prisma.InputJsonObject,
    });
    const messageId = row.id;
    run.messageId = messageId;
    let savedAt = Date.now();
    const save = () => {
      savedAt = Date.now();
      return persist();
    };
    const persist = () =>
      this.chat.update(messageId, {
        content: blocks
          .flatMap((b) => (b.type === 'text' ? [b.text] : []))
          .join('\n\n'),
        metadata: {
          ...meta,
          branchId: ctx.branchId,
        } as unknown as Prisma.InputJsonObject,
      });
    emit({ type: 'message.started', message: messageView(row) });

    let tokensUsed = 0;
    let balance: number | null = null;
    try {
      for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex += 1) {
        const studio = await this.projects.loadStudio(
          projectId,
          user.id,
          ctx.branchId,
        );
        // The entry step decides the prompt section and which tools exist.
        ctx.scope = scopeOf(studio);
        const ready = readyOn(studio);
        const request = buildStudioRequest({
          modelId: step.modelId,
          messages: [...this.transcript(history), ...llm],
          projectState: buildAgentSnapshot(studio, attachments),
          topologyIds: this.topologies.ids(),
          signal,
          scope: {
            scope: ctx.scope,
            ready: allowedStages(ctx.scope).filter(ready),
            next: nextSteps(ctx.scope, ready),
            named: ctx.named,
          },
        });

        // 1. Stream the model's step.
        let text = '';
        let textBlock: { type: 'text'; text: string } | null = null;
        const calls = new Map<
          number,
          { id: string; name: string; input: string }
        >();
        let usage: BedrockUsage | undefined;
        for await (const event of this.bedrock.converseStream(request)) {
          if (event.type === 'text') {
            text += event.text;
            if (!textBlock) {
              textBlock = { type: 'text', text: '' };
              blocks.push(textBlock);
            }
            textBlock.text += event.text;
            emit({ type: 'text.delta', messageId, text: event.text });
            if (Date.now() - savedAt > TEXT_SAVE_MS) await save();
          } else if (event.type === 'tool_use_start') {
            calls.set(event.index, {
              id: event.id,
              name: event.name,
              input: '',
            });
          } else if (event.type === 'tool_use_delta') {
            const call = calls.get(event.index);
            if (call) call.input += event.input;
          } else if (event.type === 'usage') {
            usage = event.usage;
          }
        }
        if (signal.aborted) throw new CancelledRun();

        // 2. Charge the completed step once.
        if (usage) {
          const charge = await this.runner.chargeStream({
            actorId: user.id,
            access,
            step: STUDIO_AGENT_STEP,
            payer: step.payer,
            modelId: step.modelId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
          tokensUsed += charge.charged;
          balance = charge.balance;
        }

        const toolCalls = [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => call)
          .filter((call) => call.name)
          .map((call) => ({ ...call, parsed: this.parseInput(call) }));
        llm.push({
          role: 'assistant',
          content: [
            ...(text.trim() ? [{ type: 'text' as const, text }] : []),
            ...toolCalls.map((call) => ({
              type: 'tool_use' as const,
              id: call.id,
              name: call.name,
              input: call.parsed,
            })),
          ],
        });
        await save();
        if (toolCalls.length === 0) break;

        // 3. Run the tools.
        const results: LlmTurn['content'] = [];
        let blocking = false;
        for (const call of toolCalls) {
          const info = TOOL_INFO[call.name] ?? {
            label: call.name,
            stage: null,
          };
          const chip: Extract<ChatBlock, { type: 'tool' }> = {
            type: 'tool',
            toolUseId: call.id,
            tool: call.name,
            label: info.label,
            stage: info.stage,
            status: 'running',
            summary: null,
          };
          blocks.push(chip);
          emit({
            type: 'tool.started',
            messageId,
            toolUseId: call.id,
            tool: call.name,
            label: info.label,
            stage: info.stage,
          });
          await save();
          const outcome = await this.tools.execute(ctx, call.name, call.parsed);
          chip.status = outcome.result.ok ? 'done' : 'error';
          chip.summary = outcome.result.summary;
          emit({
            type: 'tool.finished',
            messageId,
            toolUseId: call.id,
            status: chip.status,
            summary: chip.summary,
            stage: info.stage,
          });
          if (
            outcome.stages.length ||
            outcome.focus ||
            outcome.forked ||
            outcome.scopeChanged
          ) {
            emit({
              type: 'workspace.updated',
              branchId: outcome.branchId,
              stages: outcome.stages,
              focus: outcome.focus,
              forked: outcome.forked,
              ...(outcome.scopeChanged ? { scopeChanged: true } : {}),
            });
          }
          if (outcome.widget) {
            blocks.push({ type: 'widget', widget: outcome.widget });
            emit({ type: 'widget', messageId, widget: outcome.widget });
            blocking = true;
          }
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: clipJson(outcome.result.payload),
            is_error: !outcome.result.ok,
          });
          if (BLOCKING_TOOLS.has(call.name)) blocking = true;
          if (signal.aborted) break;
        }
        llm.push({ role: 'user', content: results });
        await save();
        if (signal.aborted) throw new CancelledRun();
        if (blocking) break;
      }

      meta.status = 'complete';
      await save();
      if (balance !== null) {
        emit({ type: 'usage', tokensUsed, tokensRemaining: balance });
      }
      emit({ type: 'run.completed', messageId });
    } catch (error) {
      const cancelled = signal.aborted || error instanceof CancelledRun;
      for (const block of blocks) {
        if (block.type === 'tool' && block.status === 'running') {
          block.status = 'error';
          block.summary = cancelled ? 'Stopped' : 'Failed';
          emit({
            type: 'tool.finished',
            messageId,
            toolUseId: block.toolUseId,
            status: 'error',
            summary: block.summary,
            stage: block.stage,
          });
        }
      }
      if (cancelled) {
        meta.status = 'stopped';
        await save().catch(() => undefined);
        emit({ type: 'run.cancelled', messageId });
      } else {
        if (
          !(error instanceof HttpException) &&
          !(error instanceof BedrockError)
        ) {
          this.logger.error(
            `Studio chat run failed for ${user.id} on ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
        meta.status = 'error';
        meta.error = errorBody(error);
        await save().catch(() => undefined);
        emit({ type: 'run.failed', messageId, error: meta.error });
      }
      if (balance !== null) {
        emit({ type: 'usage', tokensUsed, tokensRemaining: balance });
      }
    }
  }

  // --- helpers -------------------------------------------------------------------

  /** Stored messages -> the model conversation (user text, then each run's turns). */
  private transcript(rows: ProjectChatMessage[]): LlmTurn[] {
    let window = rows;
    const firstUser = window.findIndex((r) => r.sender === ChatSender.USER);
    if (firstUser > 0) window = window.slice(firstUser);
    const turns: LlmTurn[] = [];
    for (const row of window) {
      const meta = metaOf(row);
      if (row.sender === ChatSender.USER) {
        const text = meta?.llmText ?? row.content;
        if (text.trim())
          turns.push({ role: 'user', content: [{ type: 'text', text }] });
      } else if (meta?.llm?.length) {
        turns.push(...meta.llm);
      } else if (row.content.trim()) {
        turns.push({
          role: 'assistant',
          content: [{ type: 'text', text: row.content }],
        });
      }
    }
    return turns;
  }

  /** Malformed or empty model JSON becomes `{}` (as in qdonis-core). */
  private parseInput(call: { name: string; input: string }): JsonObject {
    if (!pythonStrip(call.input)) return {};
    try {
      const parsed: unknown = JSON.parse(call.input);
      return isObject(parsed) ? (parsed as JsonObject) : {};
    } catch {
      this.logger.warn(
        `Malformed tool input for ${call.name}: ${call.input.slice(0, 500)}`,
      );
      return {};
    }
  }

  /** Resolution shown on the widget and the text the model receives. */
  private answerOf(widget: ChatWidget, answer: WidgetAnswer) {
    const mismatch = () =>
      AppError.badRequest(
        ErrorCode.ValidationFailed,
        'The answer does not match the question.',
      );
    if (answer.kind !== widget.kind) throw mismatch();
    if (widget.kind === 'question' && answer.kind === 'question') {
      const labels = widget.options
        .filter((o) => answer.optionIds?.includes(o.id))
        .map((o) => o.label);
      if (!labels.length) throw mismatch();
      const text = labels.join(', ');
      return { resolution: text, llmText: text, approve: undefined };
    }
    if (widget.kind === 'fields' && answer.kind === 'fields') {
      const values = answer.values ?? {};
      const rows = widget.fields.map((f) => ({
        name: f.name,
        value: (values[f.name] ?? '').trim(),
        unit: f.unit ?? '',
      }));
      const filled = rows.filter((r) => r.value);
      const assume = widget.allowAssume === true && answer.assumeRest === true;
      const table = [
        '| Parameter | Value | Unit |',
        '|---|---|---|',
        ...rows.map(
          (r) =>
            `| ${r.name} | ${r.value || (assume ? '(Q assumes)' : '(not specified)')} | ${r.unit} |`,
        ),
      ].join('\n');
      const instruction = !widget.step
        ? ''
        : assume
          ? `\n\nThat is everything I have: assume the values left blank yourself (typical for this application), run the ${STAGE_LABEL[widget.step]} step with them listed in \`assumed\`, then show your assumptions.`
          : `\n\nThese are the ${STAGE_LABEL[widget.step]} inputs. Check them with check_step_inputs, then run the step.`;
      return {
        resolution:
          [
            filled.map((r) => `${r.name}: ${r.value}`).join(' · '),
            assume ? 'Q fills the rest' : '',
          ]
            .filter(Boolean)
            .join(' · ') || 'No values given',
        llmText: `Filled in ${filled.length} of ${rows.length} values.\n\nValues from the table:\n${table}${instruction}`,
        approve: undefined,
      };
    }
    if (widget.kind === 'entry_step' && answer.kind === 'entry_step') {
      const option = widget.options.find((o) => o.step === answer.step);
      if (!option) throw mismatch();
      return {
        resolution: option.title,
        llmText:
          option.step === 'specs'
            ? 'Start from scratch: I want the full design.\n\n(Entry step set to `specs`.)'
            : `Let's do the ${STAGE_LABEL[option.step]} step only.\n\n(Entry step set to \`${option.step}\`. Check its inputs with check_step_inputs.)`,
        approve: undefined,
        step: option.step,
      };
    }
    if (widget.kind === 'topologies' && answer.kind === 'topologies') {
      const option = widget.options.find(
        (o) => o.topologyId === answer.topologyId,
      );
      if (!option) throw mismatch();
      return {
        resolution: option.title,
        llmText: `Let's go with the ${option.title}.\n\n(User selected topology_id: ${option.topologyId})`,
        approve: undefined,
      };
    }
    if (widget.kind === 'spec_approval' && answer.kind === 'spec_approval') {
      return answer.approve
        ? {
            resolution: 'Approved',
            llmText: 'The specification looks good — approved.',
            approve: true,
          }
        : {
            resolution: 'Changes requested',
            llmText:
              'I would like to change the specification before we continue.',
            approve: false,
          };
    }
    throw mismatch();
  }

  private attachmentRef(file: StoredFile): AttachmentRef {
    const netlist = isNetlistFile(file.filename);
    return {
      id: file.id,
      name: file.filename,
      kind: netlist ? 'netlist' : 'document',
      sizeBytes: file.sizeBytes,
      lineCount:
        netlist && file.extractedText
          ? file.extractedText.split(/\r?\n/).length
          : null,
    };
  }

  /** The files of a message: uploaded documents of this project. */
  private async attachmentsFor(
    projectId: string,
    ids: string[],
  ): Promise<ChatAttachment[]> {
    const out: ChatAttachment[] = [];
    for (const id of [...new Set(ids)]) {
      const file = await this.files.findById(id);
      if (
        !file ||
        file.projectId !== projectId ||
        file.kind !== StoredFileKind.DOCUMENT
      ) {
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          'An attachment is missing. Attach the file again.',
        );
      }
      out.push({ ...this.attachmentRef(file), text: file.extractedText });
    }
    return out;
  }

  /** Attachments of the messages in the window, with their text (for import_netlist). */
  private async conversationAttachments(
    projectId: string,
    rows: ProjectChatMessage[],
  ): Promise<ChatAttachment[]> {
    const refs = rows.flatMap((row) => metaOf(row)?.attachments ?? []);
    const out: ChatAttachment[] = [];
    for (const ref of refs) {
      const file = await this.files.findById(ref.id);
      if (file?.projectId === projectId) {
        out.push({ ...ref, text: file.extractedText });
      }
    }
    return out;
  }

  private key(projectId: string, userId: string): string {
    return `${projectId}:${userId}`;
  }

  /** One run per person and project at a time. */
  private claim(projectId: string, userId: string): ActiveRun {
    const key = this.key(projectId, userId);
    if (this.active.has(key)) {
      throw AppError.conflict(
        ErrorCode.ChatBusy,
        'Q is still answering. Wait for it, or stop it first.',
      );
    }
    const run: ActiveRun = {
      runId: randomUUID(),
      controller: new AbortController(),
      messageId: null,
    };
    this.active.set(key, run);
    return run;
  }

  private release(projectId: string, userId: string, run: ActiveRun): void {
    const key = this.key(projectId, userId);
    if (this.active.get(key) === run) this.active.delete(key);
  }
}

class CancelledRun extends Error {}

const refOf = (a: ChatAttachment): AttachmentRef => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  sizeBytes: a.sizeBytes,
  lineCount: a.lineCount,
});
