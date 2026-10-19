import type { BedrockRequest } from '../../ai/bedrock/bedrock.types';
import { convertTools } from '../../ai/bedrock/bedrock-tools';
import { STUDIO_MAX_TOKENS, STUDIO_TEMPERATURE } from '../studio.types';
import { toConverseMessages } from './message-normalizer';
import { buildStudioTools } from './studio-tools';
import { buildStudioSystemPrompt } from './studio-system-prompt';
import {
  type AgentScope,
  scopeAddendum,
  scopedTools,
} from './studio-scope-agent';

export interface StudioRequestInput {
  modelId: string;
  /** Client history (frontend content blocks). */
  messages: readonly unknown[];
  /** Active-branch snapshot; anything but a plain object counts as `{}`. */
  projectState: unknown;
  topologyIds: readonly string[];
  signal: AbortSignal;
  /**
   * The project's entry step (Studio chat). Omitted: the request is exactly
   * qdonis-core's (the parity fixtures check it byte for byte).
   */
  scope?: AgentScope;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One Studio agent step as a Bedrock request: the same system prompt,
 * history repair, tools and inference settings as the Python
 * `stream_agent_step` (verified against the parity fixtures), plus the
 * entry-step section and tool allow-list when a scope is given.
 */
export function buildStudioRequest(input: StudioRequestInput): BedrockRequest {
  const projectState = isObject(input.projectState) ? input.projectState : {};
  const system = buildStudioSystemPrompt(projectState, input.topologyIds);
  const tools = buildStudioTools(input.topologyIds);
  return {
    modelId: input.modelId,
    system: [input.scope ? system + scopeAddendum(input.scope) : system],
    messages: toConverseMessages(input.messages),
    toolConfig: convertTools(
      input.scope ? scopedTools(tools, input.scope) : tools,
    ),
    maxTokens: STUDIO_MAX_TOKENS,
    temperature: STUDIO_TEMPERATURE,
    signal: input.signal,
  };
}
