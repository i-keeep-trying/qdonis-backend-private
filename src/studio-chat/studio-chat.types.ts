import type { StageKind } from '../projects/studio/studio-graph';

/**
 * Wire shapes of the Studio chat (qdonis-web `types/chat.ts`): messages are
 * stored as `project_chat_messages` rows, the display blocks and the model
 * transcript in `metadata`.
 */

export type StudioView =
  'specs' | 'circuit' | 'design' | 'simulation' | 'magnetics' | 'thermal';

export const VIEW_OF_STAGE: Record<StageKind, StudioView> = {
  specs: 'specs',
  visualization: 'circuit',
  design: 'design',
  simulation: 'simulation',
  // Former stage: its results open the Simulation view.
  devices: 'simulation',
  magnetics: 'magnetics',
  thermal: 'thermal',
};

export type AttachmentKind = 'netlist' | 'document';

export interface AttachmentRef {
  id: string;
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
  lineCount: number | null;
}

export interface TopologyOptionView {
  topologyId: string;
  title: string;
  summary: string;
  pros: string[];
  cons: string[];
  recommended: boolean;
}

interface WidgetBase {
  id: string;
  resolution: string | null;
}

export type ChatWidget =
  | (WidgetBase & {
      kind: 'question';
      prompt: string;
      options: Array<{ id: string; label: string }>;
      multiple: boolean;
    })
  | (WidgetBase & {
      kind: 'fields';
      prompt: string;
      fields: Array<{
        name: string;
        unit: string | null;
        suggestion: string | null;
        required: boolean;
      }>;
    })
  | (WidgetBase & { kind: 'topologies'; options: TopologyOptionView[] })
  | (WidgetBase & { kind: 'spec_approval'; approved: boolean });

export type WidgetAnswer =
  | { kind: 'question'; optionIds: string[] }
  | { kind: 'fields'; values: Record<string, string> }
  | { kind: 'topologies'; topologyId: string }
  | { kind: 'spec_approval'; approve: boolean };

export type ToolStatus = 'running' | 'done' | 'error';

export type ChatBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      toolUseId: string;
      tool: string;
      label: string;
      stage: StageKind | null;
      status: ToolStatus;
      summary: string | null;
    }
  | { type: 'widget'; widget: ChatWidget };

export type ChatMessageStatus = 'complete' | 'streaming' | 'stopped' | 'error';

/** The API error envelope, as the client shows it. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  meta?: Record<string, unknown>;
}

export interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  attachments: AttachmentRef[];
  events: string[];
  createdAt: string;
  status: ChatMessageStatus;
  error: ApiErrorBody | null;
  branchId: string | null;
}

/** One message of the model conversation, in the Studio agent's block format. */
export interface LlmTurn {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | {
        type: 'tool_result';
        tool_use_id: string;
        content: unknown;
        is_error: boolean;
      }
  >;
}

/** `project_chat_messages.metadata` of a Studio chat message. */
export interface StudioChatMeta {
  studio: 1;
  blocks: ChatBlock[];
  attachments: AttachmentRef[];
  events: string[];
  status: ChatMessageStatus;
  error: ApiErrorBody | null;
  branchId: string | null;
  /** User message: the text the model sees (attachments, hidden context). */
  llmText?: string;
  /** Assistant message: the model turns of its run. */
  llm?: LlmTurn[];
  runId?: string;
}

export type ChatStreamEvent =
  | { type: 'run.accepted'; runId: string; userMessage: ChatMessageView | null }
  | { type: 'message.started'; message: ChatMessageView }
  | { type: 'text.delta'; messageId: string; text: string }
  | {
      type: 'tool.started';
      messageId: string;
      toolUseId: string;
      tool: string;
      label: string;
      stage: StageKind | null;
    }
  | {
      type: 'tool.finished';
      messageId: string;
      toolUseId: string;
      status: 'done' | 'error';
      summary: string | null;
      stage: StageKind | null;
    }
  | { type: 'widget'; messageId: string; widget: ChatWidget }
  | {
      type: 'workspace.updated';
      branchId: string;
      stages: StageKind[];
      focus: StudioView | null;
      forked: { branchId: string; branchName: string } | null;
    }
  | { type: 'usage'; tokensUsed: number; tokensRemaining: number }
  | { type: 'run.completed'; messageId: string }
  | { type: 'run.cancelled'; messageId: string }
  | { type: 'run.failed'; messageId: string | null; error: ApiErrorBody };

/** What a tool returns to the model (old frontend `StageResult`). */
export interface StageResult {
  ok: boolean;
  /** Short line shown on the chat's tool chip. */
  summary: string;
  /** Returned to the model as the tool result. */
  payload: Record<string, unknown>;
}

/** A tool run: the model's result plus what changed in the workspace. */
export interface ToolOutcome {
  result: StageResult;
  /** Branch the work landed on (a fork moves it). */
  branchId: string;
  /** Stages whose results changed. */
  stages: StageKind[];
  focus: StudioView | null;
  forked: { branchId: string; branchName: string } | null;
  /** Shown in the chat; ends the turn until the user answers. */
  widget?: ChatWidget;
}
