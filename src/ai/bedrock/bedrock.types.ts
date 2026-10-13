import type {
  BedrockRuntimeClient,
  ContentBlock,
  Message,
  ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';

/** Injection token of the Bedrock runtime SDK client (see the provider). */
export const BEDROCK_RUNTIME = Symbol('BEDROCK_RUNTIME');

/** The part of the SDK client the app uses; tests replace it. */
export type BedrockRuntime = Pick<BedrockRuntimeClient, 'send'>;

/** Plain JSON, structurally the SDK's document type. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** OpenAI-style function tool, the format prompts and tool registries use. */
export interface FunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
  };
}

/** One Converse call; shared by every feature that talks to Bedrock. */
export interface BedrockRequest {
  modelId: string;
  /** System prompt blocks; omitted from the call when empty. */
  system?: string[];
  messages: Message[];
  toolConfig?: ToolConfiguration;
  /** Capped at BEDROCK_MAX_OUTPUT_TOKENS. */
  maxTokens: number;
  temperature: number;
  /** Cancels the call, e.g. when the client disconnects. */
  signal: AbortSignal;
}

export interface BedrockUsage {
  inputTokens: number;
  outputTokens: number;
  /** As reported by the provider (may include cache tokens). */
  totalTokens: number;
}

export interface BedrockConverseResult {
  /** Concatenated text blocks. */
  text: string;
  /** Every content block of the reply (text, toolUse, ...). */
  content: ContentBlock[];
  usage: BedrockUsage;
  stopReason?: string;
}

/** ConverseStream events, normalised; `index` is the content block index. */
export type BedrockStreamEvent =
  | { type: 'text'; index: number; text: string }
  | { type: 'tool_use_start'; index: number; id: string; name: string }
  | { type: 'tool_use_delta'; index: number; input: string }
  | { type: 'stop'; stopReason?: string }
  | { type: 'usage'; usage: BedrockUsage };
