import type { ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';

import type { JsonObject, JsonValue } from './bedrock.types';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * OpenAI function tools -> Converse `toolConfig` (port of qdonis-core
 * `bedrock_client.convert_tools`). A `{type:'function', function}` wrapper is
 * unwrapped; any other object is read as the function itself. Nameless tools
 * are skipped, the description falls back to the name and a missing schema to
 * an empty object schema. Returns `undefined` when nothing is left.
 */
export function convertTools(
  tools: readonly unknown[] | undefined,
): ToolConfiguration | undefined {
  if (!tools?.length) return undefined;
  const specs: NonNullable<ToolConfiguration['tools']> = [];
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    const fn = tool.type === 'function' ? tool.function : tool;
    if (!isObject(fn)) continue;
    const name = fn.name;
    if (typeof name !== 'string' || !name) continue;
    const schema: JsonObject = isObject(fn.parameters)
      ? (fn.parameters as JsonObject)
      : { type: 'object', properties: {} };
    const description =
      typeof fn.description === 'string' && fn.description
        ? fn.description
        : name;
    specs.push({
      toolSpec: {
        name,
        description,
        inputSchema: { json: schema as JsonValue },
      },
    });
  }
  return specs.length ? { tools: specs } : undefined;
}
