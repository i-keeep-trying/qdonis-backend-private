/**
 * The `* qdonis-design:` deck comment, ported from qdonis-core
 * `simulator/__init__.py` (`design_summary_line`, `apply_design_summary`).
 *
 * A stateless re-run only has the topology's template YAML, so result formulas
 * would be evaluated against the template's targets and values (e.g. a
 * regulation error against the template's 12 V target, or output power with
 * its load). The prepared decks carry what those formulas need from the
 * designed YAML: each requirement's criteria and the component parameters the
 * output formulas reference as `{components.REF.PARAM}`.
 */

import { pythonFloatRepr } from '../../common/python/python-json';
import { get, isDict, iter, or, pyStr, truthy, type Dict } from './py';

export const DESIGN_TAG = '* qdonis-design: ';

const KINDS = ['dc', 'ac', 'transient'] as const;
const COMPONENT_REF = /\{components\.([^.}]+)\.([^}]+)\}/g;

function requirements(design: Dict): unknown[] {
  const analysis = or(get(design, 'analysis'), {});
  const out: unknown[] = [];
  for (const kind of KINDS) {
    const section = or(get(analysis, kind), {});
    const reqs = isDict(section) ? get(section, 'requirements', []) : section;
    out.push(...iter(or(reqs, [])));
  }
  return out;
}

/** Every component, internal parts included, in the core's stack (LIFO) order. */
function* stackOrder(design: Dict): Generator<Dict> {
  const stack = [...iter(or(get(design, 'components'), []))];
  while (stack.length) {
    const comp = stack.pop();
    if (!isDict(comp)) continue;
    stack.push(...iter(or(get(comp, 'internal'), [])));
    yield comp;
  }
}

/** Python `json.dumps` string escaping with `ensure_ascii=True`. */
function asciiString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const ch = text[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** `json.dumps(value, separators=(",", ":"), default=str)` of YAML data. */
function compactJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return pythonFloatRepr(value);
  if (typeof value === 'string') return asciiString(value);
  if (Array.isArray(value)) return `[${value.map(compactJson).join(',')}]`;
  if (isDict(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${asciiString(k)}:${compactJson(v)}`)
      .join(',')}}`;
  }
  return asciiString(pyStr(value));
}

/** The summary comment line of a designed YAML ('' when there is nothing to carry). */
export function designSummaryLine(design: Dict): string {
  const criteria: Dict = {};
  const refs = new Map<string, [string, string]>();
  for (const req of requirements(design)) {
    if (!isDict(req)) continue;
    const reqCriteria = get(req, 'criteria');
    if (truthy(get(req, 'rid')) && isDict(reqCriteria) && truthy(reqCriteria)) {
      criteria[pyStr(get(req, 'rid'))] = reqCriteria;
    }
    for (const out of iter(or(get(req, 'outputs'), []))) {
      for (const m of pyStr(get(out, 'formula', '')).matchAll(COMPONENT_REF)) {
        refs.set(`${m[1]}\0${m[2]}`, [m[1], m[2]]);
      }
    }
  }
  const params: Record<string, Dict> = {};
  if (refs.size) {
    for (const comp of stackOrder(design)) {
      const ref = get(comp, 'ref');
      const compParams = or(get(comp, 'params'), {});
      for (const [r, p] of refs.values()) {
        if (r === ref && isDict(compParams) && p in compParams) {
          (params[r] ??= {})[p] = compParams[p];
        }
      }
    }
  }
  if (!truthy(criteria) && !Object.keys(params).length) return '';
  return `${DESIGN_TAG}${compactJson({ criteria, params })}`;
}

const PY_LINE_BREAK = new RegExp(
  `\r\n|[\n\r\v\f\x1c\x1d\x1e\x85${String.fromCharCode(0x2028, 0x2029)}]`,
);

type SourceReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context: { source?: string },
) => unknown;

/** `json.loads` keeping integer literals as `bigint`, like the YAML loader. */
function parsePythonJson(text: string): unknown {
  const reviver: SourceReviver = (_key, value, context) =>
    typeof value === 'number' &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value;
  return (JSON.parse as (text: string, reviver: SourceReviver) => unknown)(
    text,
    reviver,
  );
}

/**
 * Applies the first summary comment found in the deck texts to `design` (in
 * place): requirement criteria and the carried component parameters.
 */
export function applyDesignSummary(
  design: Dict,
  decks: Iterable<string | null | undefined>,
): boolean {
  for (const text of decks) {
    for (const line of (text ?? '').split(PY_LINE_BREAK)) {
      if (!line.startsWith(DESIGN_TAG)) continue;
      let summary: unknown;
      try {
        summary = parsePythonJson(line.slice(DESIGN_TAG.length));
      } catch {
        return false;
      }
      const carriedCriteria = or(get(summary, 'criteria'), {});
      for (const req of requirements(design)) {
        if (!isDict(req)) continue;
        const rid = get(req, 'rid');
        if (
          typeof rid === 'string' &&
          isDict(carriedCriteria) &&
          rid in carriedCriteria
        ) {
          req.criteria = carriedCriteria[rid];
        }
      }
      const wanted = or(get(summary, 'params'), {});
      if (!isDict(wanted)) return true;
      for (const comp of stackOrder(design)) {
        const ref = get(comp, 'ref');
        if (typeof ref !== 'string' || !(ref in wanted)) continue;
        if (!isDict(comp.params)) comp.params = {};
        Object.assign(comp.params as Dict, wanted[ref]);
      }
      return true;
    }
  }
  return false;
}
