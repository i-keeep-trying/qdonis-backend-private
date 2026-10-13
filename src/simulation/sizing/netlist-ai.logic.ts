/**
 * Netlist AI helpers, ported from qdonis-core `api_server.py`
 * (`/api/netlist/ai-fix`, `/api/design/modify-netlist`) and
 * `assistant_service.verify_post_rerun`: prompts, reply parsing and the
 * frozen-tail guarantee (the `.end` / `.control` part is never changed).
 */

import { splitNetlistAndTail } from '../rerun.pipeline';
import type { Dict } from '../netlist/py';
import { pyStr } from '../netlist/py';
import { AI_FIX_LABELS } from './netlist-ai-prompts.text';
import { jsonDumpsIndent } from './py-dump';
import { jsonLoadsPy, pyTyped, type ChangeRow } from './sizing.logic';

const normalizeNewlines = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** Python `str.strip()` (whitespace incl. the \x1c-\x1f separators and NEL). */
const PY_SPACE = String.raw`\s\u001c-\u001f\u0085`;
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu');
const strip = (text: string): string => text.replace(STRIP, '');

/** `_extract_netlist_text`: largest fenced block (language tag dropped), stripped. */
export function extractNetlistText(raw: string): string {
  if (!raw) return '';
  let text = strip(raw);
  if (text.includes('```')) {
    const parts = text.split('```');
    const candidates: string[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      let block = parts[i];
      const lines = block.split('\n');
      if (
        lines.length &&
        ['spice', 'cir', 'ngspice', 'text', 'plaintext'].includes(
          strip(lines[0]).toLowerCase(),
        )
      ) {
        block = lines.slice(1).join('\n');
      }
      candidates.push(block);
    }
    if (candidates.length) {
      // Python max(): the first of equally long blocks wins.
      text = candidates.reduce((best, c) =>
        c.length > best.length ? c : best,
      );
    }
  }
  return normalizeNewlines(strip(text));
}

/** Keeps the model's netlist part and re-attaches the original tail verbatim. */
export function freezeTail(original: string, cleaned: string): string {
  const [, tail] = splitNetlistAndTail(original);
  if (!strip(tail)) return cleaned;
  const [part] = splitNetlistAndTail(cleaned);
  return `${part.replace(/\n+$/, '')}\n${tail}`;
}

/** `_build_ai_fix_user_prompt`. */
export function buildAiFixUserPrompt(
  key: string,
  content: string,
  userPrompt: string,
): string {
  const label = AI_FIX_LABELS[key] ?? key.toUpperCase();
  const instruction =
    strip(userPrompt || '') ||
    'Verify and correct the netlist. If a user prompt is available, consider that before modifying the netlist.';
  return (
    `This is the ${label} analysis deck.\n\n` +
    `INSTRUCTIONS:\n${instruction}\n\n` +
    `--- BEGIN ${label}.cir ---\n${content}\n--- END ${label}.cir ---\n\n` +
    `Return ONLY the corrected ${label}.cir content.`
  );
}

/** One AI-fix reply -> the corrected deck (the original when it is empty). */
export function fixedDeck(original: string, reply: string): string {
  const base = normalizeNewlines(original);
  const cleaned = extractNetlistText(reply) || base;
  return freezeTail(base, cleaned);
}

/** The user message of a design modification, per deck. */
export function buildModifyUserPrompt(
  key: string,
  content: string,
  params: Dict,
  userPrompt: string,
): string {
  return `
USER CONSTRAINTS:
${jsonDumpsIndent(pyTyped(params))}

USER MODIFICATION REQUEST:
${userPrompt}

CURRENT ${key.toUpperCase()} NETLIST:
${content}
`;
}

const tag = (raw: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(raw);
  return m ? m[1] : null;
};

export interface ModifyReply {
  deck: string;
  reasoning: string | null;
  parameters: Dict | null;
}

/** One modification reply: `<reasoning>`, `<parameters>` JSON, `<netlist>`. */
export function parseModifyReply(original: string, raw: string): ModifyReply {
  const reasoning = tag(raw, 'reasoning');
  const paramsText = tag(raw, 'parameters');
  let parameters: Dict | null = null;
  if (paramsText !== null) {
    try {
      const value = jsonLoadsPy(strip(paramsText));
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        parameters = value as Dict;
      }
    } catch {
      parameters = null; // core printed the parse error and went on
    }
  }
  const netlist = tag(raw, 'netlist');
  const cleaned =
    netlist !== null ? strip(netlist) : extractNetlistText(raw) || original;
  return {
    deck: freezeTail(normalizeNewlines(original), cleaned),
    reasoning: reasoning !== null ? strip(reasoning) : null,
    parameters,
  };
}

/** Changed values of a modification as design-table rows (core: `param` = ref). */
export const modifyRows = (parameters: Dict): ChangeRow[] =>
  Object.entries(parameters).map(([ref, value]) => ({
    ref,
    param: ref,
    before: null,
    after: pyStr(value),
  }));

// --- post-rerun verification ---------------------------------------------------------

export interface Verification {
  status: 'verified' | 'failed' | 'inconclusive';
  summary: string;
  evidence: Array<{
    source: string;
    analysis_type: string | null;
    claim: string;
    observed: string;
    supports: string;
  }>;
  limitations: string[];
}

export const inconclusive = (
  summary: string,
  limitation: string,
  observed = '',
): Verification => ({
  status: 'inconclusive',
  summary,
  evidence: [
    {
      source: 'simulation_response',
      analysis_type: null,
      claim: 'Verification could not establish the requested outcome.',
      observed: observed || limitation,
      supports: 'inconclusive',
    },
  ],
  limitations: [limitation],
});

const truncate = (text: unknown, limit = 24000): string => {
  const value = text === null || text === undefined ? '' : pyStr(text);
  return [...value].length <= limit
    ? value
    : `${[...value].slice(0, limit).join('')}\n[truncated]`;
};

/** `json.dumps(payload, ensure_ascii=False)` of the verifier input. */
export function verificationPayload(input: {
  userRequest: string;
  before: Record<string, string>;
  after: Record<string, string>;
  metadata: unknown;
  results: unknown;
  executed: Record<string, string>;
}): string {
  const map = (decks: Record<string, string>) =>
    Object.fromEntries(Object.entries(decks).map(([k, v]) => [k, truncate(v)]));
  return pyJson({
    user_request: input.userRequest,
    before_analysis_cirs: map(input.before),
    executed_analysis_cirs: map(input.after),
    simulation_response: {
      metadata: input.metadata ?? {},
      results: input.results ?? {},
      analysis_cirs: map(input.executed),
    },
  });
}

/** Python `json.dumps(v, ensure_ascii=False)` (", " / ": " separators). */
function pyJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return Number.isInteger(value) &&
      !Object.is(value, -0) &&
      Math.abs(value) < 1e16
      ? String(value)
      : pyStr(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  return `{${Object.entries(value as Dict)
    .map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`)
    .join(', ')}}`;
}

const SOURCES = new Set([
  'user_request',
  'before_deck',
  'after_deck',
  'simulation_response',
]);
const SUPPORTS = new Set(['verified', 'failed', 'inconclusive']);
const clip = (v: unknown, n: number) => [...pyStr(v)].slice(0, n).join('');

/** Validates the verifier's JSON reply into a {@link Verification}. */
export function parseVerification(content: string): Verification {
  if (!content || !strip(content)) {
    return inconclusive(
      'The simulation completed, but the requirement-verification response was empty.',
      'The verifier returned no usable conclusion.',
    );
  }
  try {
    let raw = strip(content);
    if (raw.startsWith('```')) {
      raw = raw.includes('\n') ? raw.slice(raw.indexOf('\n') + 1) : '';
      if (raw.replace(/\s+$/, '').endsWith('```')) {
        raw = raw.replace(/\s+$/, '').slice(0, -3).replace(/\s+$/, '');
      }
    }
    const parsed = jsonLoadsPy(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !SUPPORTS.has((parsed as Dict).status as string)
    ) {
      throw new Error('Verifier returned an invalid status payload');
    }
    const p = parsed as Dict;
    if (typeof p.summary !== 'string' || !strip(p.summary)) {
      throw new Error('Verifier returned no summary');
    }
    let status = p.status as Verification['status'];
    let evidence: Verification['evidence'] = [];
    for (const raw of (Array.isArray(p.evidence) ? p.evidence : []).slice(
      0,
      4,
    )) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        continue;
      const item = raw as Dict;
      const analysis = item.analysis_type;
      evidence.push({
        source: SOURCES.has(item.source as string)
          ? (item.source as string)
          : 'simulation_response',
        analysis_type:
          analysis === 'dc' || analysis === 'ac' || analysis === 'transient'
            ? analysis
            : null,
        claim: clip(
          'claim' in item ? item.claim : 'Verification evidence',
          500,
        ),
        observed: clip(
          'observed' in item ? item.observed : 'No observation supplied',
          1000,
        ),
        supports: SUPPORTS.has(item.supports as string)
          ? (item.supports as string)
          : 'inconclusive',
      });
    }
    if (evidence.length === 0) {
      evidence = inconclusive(
        'The simulation completed, but the verifier supplied no usable evidence.',
        'No evidence was returned for the requested outcome.',
      ).evidence;
      status = 'inconclusive';
    }
    const limitations = (Array.isArray(p.limitations) ? p.limitations : [])
      .slice(0, 4)
      .filter((l) => strip(pyStr(l)))
      .map((l) => clip(l, 500));
    return {
      status,
      summary: clip(strip(p.summary), 1600),
      evidence,
      limitations,
    };
  } catch (error) {
    return inconclusive(
      'The simulation completed, but the requested outcome could not be verified automatically.',
      'The verification service did not return a valid result.',
      error instanceof Error ? error.message : String(error),
    );
  }
}
