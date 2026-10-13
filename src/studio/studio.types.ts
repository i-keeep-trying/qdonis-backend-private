import type { JsonValue } from '../ai/bedrock/bedrock.types';

/**
 * Admin step-multiplier key charged for every agent step (listed in the
 * `step_multipliers` defaults; unset = multiplier 1).
 */
export const STUDIO_AGENT_STEP = 'studio_agent';

/** Python core defaults (`studio_agent.MAX_TOKENS` / `TEMPERATURE`). */
export const STUDIO_MAX_TOKENS = 4096;
export const STUDIO_TEMPERATURE = 0.3;

/** Max code points of the project snapshot embedded in the system prompt. */
export const PROJECT_STATE_LIMIT = 9000;

/**
 * Wire events, byte-compatible with the Python endpoint so the frontend
 * loop is unchanged: text deltas, tool calls after the stream, then `done`
 * (or a single `error`).
 */
export type StudioAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: JsonValue }
  | {
      type: 'done';
      /** `{}` when the provider sent no usage metadata. */
      usage: StudioUsage | Record<string, never>;
      stop_reason: string | null;
      model: string;
    }
  | { type: 'error'; error: string };

export interface StudioUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Prefix of every `error` event (kept from the Python endpoint). */
export const STUDIO_ERROR_PREFIX = 'The assistant could not respond: ';
