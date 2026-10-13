import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';

import type { JsonObject, JsonValue } from '../../ai/bedrock/bedrock.types';
import { pythonStr, pythonStrip } from '../../common/python/python-json';

/** One Converse turn (assignable to the SDK `Message`). */
export interface ConverseTurn {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

const NO_RESULT = '(no result recorded)';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Python truthiness of a decoded JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function toolResultContent(
  content: unknown,
): ContentBlock.ToolResultMember['toolResult']['content'] {
  if (isObject(content)) return [{ json: content as JsonObject }];
  if (Array.isArray(content))
    return [{ json: { items: content as JsonValue[] } }];
  const text = pythonStr(content);
  return [{ text: text || '(empty)' }];
}

const missingResult = (toolUseId: string): ContentBlock => ({
  toolResult: { toolUseId, content: [{ text: NO_RESULT }], status: 'error' },
});

const toolUseIds = (turn: ConverseTurn): string[] =>
  turn.content.flatMap((block) =>
    block.toolUse?.toolUseId ? [block.toolUse.toolUseId] : [],
  );

/** Frontend blocks of one message -> Converse blocks (unusable ones dropped). */
function convertBlocks(
  role: 'user' | 'assistant',
  content: unknown,
): ContentBlock[] {
  const items: unknown[] =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [];
  const blocks: ContentBlock[] = [];
  for (const block of items) {
    if (!isObject(block)) continue;
    if (block.type === 'text') {
      const text = pythonStrip(
        typeof block.text === 'string' ? block.text : '',
      );
      if (text) blocks.push({ text });
    } else if (
      block.type === 'tool_use' &&
      role === 'assistant' &&
      truthy(block.id) &&
      truthy(block.name)
    ) {
      blocks.push({
        toolUse: {
          toolUseId: pythonStr(block.id),
          name: pythonStr(block.name),
          input: isObject(block.input) ? (block.input as JsonObject) : {},
        },
      });
    } else if (
      block.type === 'tool_result' &&
      role === 'user' &&
      truthy(block.tool_use_id)
    ) {
      blocks.push({
        toolResult: {
          toolUseId: pythonStr(block.tool_use_id),
          content: toolResultContent(block.content),
          status: truthy(block.is_error) ? 'error' : 'success',
        },
      });
    }
  }
  return blocks;
}

/**
 * Client history -> a valid Converse conversation (port of qdonis-core
 * `studio_agent.to_converse_messages`). Converse needs alternating roles, a
 * leading user turn, and every toolUse answered by a toolResult in the very
 * next user turn; the client history can be trimmed or interrupted, so all
 * of that is repaired here instead of trusted.
 *
 * One deliberate difference: synthesized "(no result recorded)" results are
 * in the assistant turn's tool-use order (Python iterated a set, so its
 * order was hash-dependent).
 */
export function toConverseMessages(
  history: readonly unknown[],
): ConverseTurn[] {
  // 1. Convert blocks; merge consecutive same-role messages.
  const raw: ConverseTurn[] = [];
  for (const message of history) {
    if (!isObject(message)) continue;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const blocks = convertBlocks(role, message.content);
    if (!blocks.length) continue;
    const last = raw[raw.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else raw.push({ role, content: blocks });
  }

  // 2. Pair tool uses with results.
  const fixed: ConverseTurn[] = [];
  for (const message of raw) {
    const previous = fixed[fixed.length - 1];
    if (message.role === 'user') {
      // Drop results whose tool use isn't in the immediately preceding assistant turn.
      const expected =
        previous?.role === 'assistant' ? toolUseIds(previous) : [];
      const kept = message.content.filter(
        (block) =>
          !block.toolResult ||
          expected.includes(block.toolResult.toolUseId ?? ''),
      );
      const present = new Set(
        kept.flatMap((block) =>
          block.toolResult ? [block.toolResult.toolUseId] : [],
        ),
      );
      const missing = [...new Set(expected)].filter((id) => !present.has(id));
      const results = [
        ...kept.filter((block) => block.toolResult),
        ...missing.map(missingResult),
      ];
      const others = kept.filter((block) => !block.toolResult);
      // Converse wants tool results first in the user turn.
      const blocks = [...results, ...others];
      if (blocks.length) fixed.push({ role: 'user', content: blocks });
    } else if (previous?.role === 'assistant') {
      previous.content.push(...message.content);
    } else {
      fixed.push(message);
    }
  }

  // 3. An assistant turn with tool uses must be followed by a user turn with results.
  let final: ConverseTurn[] = [];
  fixed.forEach((message, index) => {
    final.push(message);
    if (message.role !== 'assistant') return;
    const ids = toolUseIds(message);
    const nextIsUser = fixed[index + 1]?.role === 'user';
    if (ids.length && !nextIsUser) {
      final.push({ role: 'user', content: ids.map(missingResult) });
    }
  });

  // 4. Start on a real user turn.
  const dropLeadingAssistants = () => {
    while (final.length && final[0].role !== 'user') final.shift();
  };
  dropLeadingAssistants();
  // A leading user turn made only of tool results (history trimmed mid-pair) is invalid.
  while (
    final.length &&
    final[0].role === 'user' &&
    final[0].content.every((block) => block.toolResult)
  ) {
    final.shift();
    dropLeadingAssistants();
  }
  if (!final.length) final = [{ role: 'user', content: [{ text: 'Hello' }] }];
  if (final[final.length - 1].role !== 'user') {
    final.push({ role: 'user', content: [{ text: 'Continue.' }] });
  }
  return final;
}
