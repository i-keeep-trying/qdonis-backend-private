import { AppError, ErrorCode } from '../../common/errors/error-codes';

/**
 * Model output -> JSON object, with the same recovery steps the old frontend
 * used: strip a ```json fence, cut to the outermost braces, and drop stray
 * backslashes that are not valid JSON escapes.
 */
export function extractJsonText(raw: string): string {
  let text = raw;
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  if (fence?.[1]) text = fence[1];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) text = text.substring(first, last + 1);
  return text.trim().replace(/\\(?![u"\\/bfnrt])/g, '');
}

export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly fragment: string,
  ) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

/** Parses a JSON object out of a model reply; 502 when it cannot. */
export function parseModelJson(
  raw: string,
  what: string,
): Record<string, unknown> {
  const text = extractJsonText(raw);
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  throw AppError.badGateway(
    ErrorCode.AiResponseInvalid,
    `The AI response for ${what} could not be parsed. Please try again.`,
  );
}

/**
 * Rejects placeholder / local / malformed citation links before they reach
 * the UI (port of the old `isLikelyValidUrl`).
 */
export function isLikelyValidUrl(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!host || !host.includes('.')) return false;
    return !(
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host === 'example.com' ||
      host === 'example.org' ||
      host === 'example.net'
    );
  } catch {
    return false;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Citations with a title and a plausible URL only. */
export function validCitations(
  value: unknown,
): Array<{ title: string; uri: string }> {
  return asArray(value)
    .filter(isRecord)
    .filter(
      (c) =>
        typeof c.title === 'string' &&
        c.title.trim().length > 0 &&
        isLikelyValidUrl(c.uri),
    )
    .map((c) => ({ title: String(c.title), uri: String(c.uri).trim() }));
}
