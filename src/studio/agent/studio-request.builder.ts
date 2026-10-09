import type { BedrockRequest } from '../../ai/bedrock/bedrock.types';
import { convertTools } from '../../ai/bedrock/bedrock-tools';
import { STUDIO_MAX_TOKENS, STUDIO_TEMPERATURE } from '../studio.types';
import { toConverseMessages } from './message-normalizer';
import { buildStudioTools } from './studio-tools';
import { buildStudioSystemPrompt } from './studio-system-prompt';

export interface StudioRequestInput {
  modelId: string;
  /** Client history (frontend content blocks). */
  messages: readonly unknown[];
  /** Active-branch snapshot; anything but a plain object counts as `{}`. */
  projectState: unknown;
  topologyIds: readonly string[];
  signal: AbortSignal;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One Studio agent step as a Bedrock request: the same system prompt,
 * history repair, tools and inference settings as the Python
 * `stream_agent_step` (verified against the parity fixtures).
 */
export function buildStudioRequest(input: StudioRequestInput): BedrockRequest {
  const projectState = isObject(input.projectState) ? input.projectState : {};
  return {
    modelId: input.modelId,
    system: [buildStudioSystemPrompt(projectState, input.topologyIds)],
    messages: toConverseMessages(input.messages),
    toolConfig: convertTools(buildStudioTools(input.topologyIds)),
    maxTokens: STUDIO_MAX_TOKENS,
    temperature: STUDIO_TEMPERATURE,
    signal: input.signal,
  };
}
