import { Injectable, Logger } from '@nestjs/common';

import { AiService } from '../../ai/ai.service';
import { BedrockError } from '../../ai/bedrock/bedrock-errors';
import { BedrockClient } from '../../ai/bedrock/bedrock.client';
import type { BedrockUsage, JsonValue } from '../../ai/bedrock/bedrock.types';
import type { StudioAgentRequestDto } from '../dto/studio-agent.dto';
import {
  STUDIO_AGENT_STEP,
  STUDIO_ERROR_PREFIX,
  type StudioAgentEvent,
  type StudioUsage,
} from '../studio.types';
import { pythonStrip } from '../../common/python/python-json';
import { buildStudioRequest } from './studio-request.builder';
import { STUDIO_TOPOLOGY_IDS } from './topology-library';

interface PendingToolUse {
  id: string;
  name: string;
  input: string;
}

/** Shown when something other than the provider fails. */
const GENERIC_FAILURE = 'The AI request failed; please retry';

const toWireUsage = (usage: BedrockUsage): StudioUsage => ({
  prompt_tokens: usage.inputTokens,
  completion_tokens: usage.outputTokens,
  total_tokens: usage.totalTokens,
});

/**
 * One step of the chat-first Studio agent (port of qdonis-core
 * `studio_agent.stream_agent_step`): streams text, then the tool calls the
 * client must execute, then `done`. The client runs the tools and calls
 * again with the results. Every completed step is charged exactly once from
 * the provider's usage.
 */
@Injectable()
export class StudioAgentService {
  private readonly logger = new Logger(StudioAgentService.name);

  constructor(
    private readonly ai: AiService,
    private readonly bedrock: BedrockClient,
  ) {}

  /** Config, model and balance checks; throws before any streaming. */
  prepare(userId: string): Promise<string> {
    return this.ai.prepare(userId);
  }

  async *runStep(
    userId: string,
    modelId: string,
    dto: StudioAgentRequestDto,
    signal: AbortSignal,
  ): AsyncGenerator<StudioAgentEvent, void, undefined> {
    const request = buildStudioRequest({
      modelId,
      messages: dto.messages,
      projectState: dto.project_state,
      topologyIds: STUDIO_TOPOLOGY_IDS,
      signal,
    });
    this.logger.log(`Studio agent step: ${request.messages.length} messages`);

    const toolUses = new Map<number, PendingToolUse>();
    let usage: BedrockUsage | undefined;
    let stopReason: string | null = null;

    try {
      for await (const event of this.bedrock.converseStream(request)) {
        if (event.type === 'text') {
          yield { type: 'text', text: event.text };
        } else if (event.type === 'tool_use_start') {
          toolUses.set(event.index, {
            id: event.id,
            name: event.name,
            input: '',
          });
        } else if (event.type === 'tool_use_delta') {
          const entry = toolUses.get(event.index) ?? {
            id: '',
            name: '',
            input: '',
          };
          entry.input += event.input;
          toolUses.set(event.index, entry);
        } else if (event.type === 'stop') {
          stopReason = event.stopReason ?? null;
        } else {
          usage = event.usage;
        }
      }
    } catch (error) {
      if (signal.aborted) return; // client gone: nothing to send, nothing to charge
      yield this.failure(userId, error);
      return;
    }
    if (signal.aborted) return;

    // The stream completed: charge it once, before reporting any result.
    if (usage) {
      try {
        await this.ai.chargeUsage(userId, {
          modelId,
          step: STUDIO_AGENT_STEP,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      } catch (error) {
        yield this.failure(userId, error);
        return;
      }
    }

    for (const index of [...toolUses.keys()].sort((a, b) => a - b)) {
      const entry = toolUses.get(index);
      if (!entry?.name) continue;
      yield {
        type: 'tool_call',
        id: entry.id,
        name: entry.name,
        input: this.parseToolInput(entry),
      };
    }

    yield {
      type: 'done',
      usage: usage ? toWireUsage(usage) : {},
      stop_reason: stopReason,
      model: modelId,
    };
  }

  /** Malformed or empty model JSON becomes `{}` (as in the core). */
  private parseToolInput(entry: PendingToolUse): JsonValue {
    if (!pythonStrip(entry.input)) return {};
    try {
      return JSON.parse(entry.input) as JsonValue;
    } catch {
      this.logger.warn(
        `Malformed tool input for ${entry.name}: ${entry.input.slice(0, 500)}`,
      );
      return {};
    }
  }

  private failure(userId: string, error: unknown): StudioAgentEvent {
    if (error instanceof BedrockError) {
      return { type: 'error', error: STUDIO_ERROR_PREFIX + error.message };
    }
    this.logger.error(
      `Studio agent step failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    return { type: 'error', error: STUDIO_ERROR_PREFIX + GENERIC_FAILURE };
  }
}
