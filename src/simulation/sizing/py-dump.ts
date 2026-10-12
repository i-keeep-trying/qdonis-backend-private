/**
 * Python serialisations used to build the sizing prompt:
 * `yaml.dump(value, default_flow_style=True)` (PyYAML emitter, width 80,
 * indent 2, sorted keys) and `json.dumps(value, indent=2)`.
 * Values are PyYAML-typed: ints as bigint, floats as number.
 */

import { floatRepr } from '../netlist/py';

const BEST_WIDTH = 80;
const BEST_INDENT = 2;

// PyYAML 1.1 implicit resolvers (a plain scalar matching one is not a str).
const IMPLICIT = [
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:~|null|Null|NULL|)$/,
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  /^(?:<<)$/,
  /^(?:=)$/,
];

const resolvesToStr = (text: string): boolean =>
  !IMPLICIT.some((re) => re.test(text));

/** `Emitter.analyze_scalar` (the parts that decide plain / single quoted). */
function analyze(text: string): {
  allowFlowPlain: boolean;
  allowSingleQuoted: boolean;
} {
  if (!text) return { allowFlowPlain: false, allowSingleQuoted: true };
  let flowIndicators = false;
  let lineBreaks = false;
  let special = false;
  let leadingSpace = false;
  let trailingSpace = false;
  let spaceBreak = false;
  let breakSpace = false;
  let previousSpace = false;
  let previousBreak = false;
  if (text.startsWith('---') || text.startsWith('...')) flowIndicators = true;
  let precededByWs = true;
  const ws = '\0 \t\r\n\x85\u2028\u2029';
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const followedByWs = i + 1 >= chars.length || ws.includes(chars[i + 1]);
    if (i === 0) {
      if ('#,[]{}&*!|>\'"%@`'.includes(ch)) flowIndicators = true;
      if ('?:'.includes(ch)) flowIndicators = true;
      if (ch === '-' && followedByWs) flowIndicators = true;
    } else {
      if (',?[]{}'.includes(ch)) flowIndicators = true;
      if (ch === ':') flowIndicators = true;
      if (ch === '#' && precededByWs) flowIndicators = true;
    }
    if ('\n\x85\u2028\u2029'.includes(ch)) lineBreaks = true;
    const code = ch.codePointAt(0) ?? 0;
    const printable =
      ch === '\n' ||
      (code >= 0x20 && code <= 0x7e) ||
      ((code === 0x85 ||
        (code >= 0xa0 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code < 0x110000)) &&
        code !== 0xfeff);
    if (!printable) special = true;
    if (ch === ' ') {
      if (i === 0) leadingSpace = true;
      if (i === chars.length - 1) trailingSpace = true;
      if (previousBreak) breakSpace = true;
      previousSpace = true;
      previousBreak = false;
    } else if ('\n\x85\u2028\u2029'.includes(ch)) {
      if (i === 0) leadingSpace = true;
      if (i === chars.length - 1) trailingSpace = true;
      if (previousSpace) spaceBreak = true;
      previousSpace = false;
      previousBreak = true;
    } else {
      previousSpace = false;
      previousBreak = false;
    }
    precededByWs = ws.includes(ch);
  }
  let allowFlowPlain = true;
  let allowSingleQuoted = true;
  if (leadingSpace || breakSpace || trailingSpace || spaceBreak) {
    allowFlowPlain = false;
  }
  if (spaceBreak || special) {
    allowFlowPlain = false;
    allowSingleQuoted = false;
  }
  if (lineBreaks) allowFlowPlain = false;
  if (flowIndicators) allowFlowPlain = false;
  return { allowFlowPlain, allowSingleQuoted };
}

class FlowEmitter {
  out = '';
  private column = 0;
  private whitespace = true;
  private indention = true;
  private indent: number | null = null;
  private readonly indents: Array<number | null> = [];

  private write(data: string): void {
    this.out += data;
    this.column += data.length;
  }

  private indicator(text: string, needWs: boolean, whitespace = false): void {
    const data = this.whitespace || !needWs ? text : ` ${text}`;
    this.whitespace = whitespace;
    this.indention = false;
    this.write(data);
  }

  private lineBreak(): void {
    this.whitespace = true;
    this.indention = true;
    this.out += '\n';
    this.column = 0;
  }

  private writeIndent(): void {
    const indent = this.indent ?? 0;
    if (
      !this.indention ||
      this.column > indent ||
      (this.column === indent && !this.whitespace)
    ) {
      this.lineBreak();
    }
    if (this.column < indent) {
      this.whitespace = true;
      this.write(' '.repeat(indent - this.column));
    }
  }

  private increaseIndent(): void {
    this.indents.push(this.indent);
    this.indent =
      this.indent === null ? BEST_INDENT : this.indent + BEST_INDENT;
  }

  private wrapCheck(): void {
    if (this.column > BEST_WIDTH) this.writeIndent();
  }

  /** `write_plain` / `write_single_quoted` with splitting at spaces. */
  private scalar(text: string, quoted: boolean): void {
    if (quoted) this.indicator("'", true);
    else {
      if (!text) return;
      if (!this.whitespace) this.write(' ');
      this.whitespace = false;
      this.indention = false;
    }
    let spaces = false;
    let start = 0;
    const flush = (end: number) => {
      let data = text.slice(start, end);
      if (quoted) data = data.replace(/'/g, "''");
      this.write(data);
      start = end;
    };
    for (let end = 0; end <= text.length; end += 1) {
      const ch = end < text.length ? text[end] : null;
      if (spaces) {
        if (ch !== ' ') {
          if (
            start + 1 === end &&
            this.column > BEST_WIDTH &&
            end !== 0 &&
            end !== text.length
          ) {
            this.writeIndent();
            this.whitespace = false;
            this.indention = false;
            start = end;
          } else flush(end);
        }
      } else if (ch === null || ch === ' ') {
        flush(end);
      }
      spaces = ch === ' ';
    }
    if (quoted) this.indicator("'", false);
  }

  node(value: unknown): void {
    if (Array.isArray(value)) {
      this.indicator('[', true, true);
      this.increaseIndent();
      value.forEach((item, i) => {
        if (i > 0) this.indicator(',', false);
        this.wrapCheck();
        this.node(item);
      });
      this.indent = this.indents.pop() ?? null;
      this.indicator(']', false);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      this.indicator('{', true, true);
      this.increaseIndent();
      entries.forEach(([key, item], i) => {
        if (i > 0) this.indicator(',', false);
        this.wrapCheck();
        this.node(key);
        this.indicator(':', false);
        this.node(item);
      });
      this.indent = this.indents.pop() ?? null;
      this.indicator('}', false);
      return;
    }
    this.scalarNode(value);
  }

  private scalarNode(value: unknown): void {
    if (value === null || value === undefined)
      return this.scalar('null', false);
    if (typeof value === 'boolean')
      return this.scalar(value ? 'true' : 'false', false);
    if (typeof value === 'bigint') return this.scalar(value.toString(), false);
    if (typeof value === 'number') {
      let text: string;
      if (Number.isNaN(value)) text = '.nan';
      else if (value === Infinity) text = '.inf';
      else if (value === -Infinity) text = '-.inf';
      else {
        text = floatRepr(value).toLowerCase();
        if (!text.includes('.') && text.includes('e'))
          text = text.replace('e', '.0e');
      }
      return this.scalar(text, false);
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const analysis = analyze(text);
    const plain = resolvesToStr(text) && analysis.allowFlowPlain;
    if (plain) return this.scalar(text, false);
    if (analysis.allowSingleQuoted) return this.scalar(text, true);
    // Double quotes for non-printable text (not expected in topology nets).
    this.indicator('"', true);
    this.write(JSON.stringify(text).slice(1, -1));
    this.indicator('"', false);
  }

  finish(): string {
    this.writeIndent();
    return this.out;
  }
}

/** `yaml.dump(value, default_flow_style=True)` for a list / dict root. */
export function yamlDumpFlow(value: unknown): string {
  const emitter = new FlowEmitter();
  emitter.node(value);
  return emitter.finish();
}

const escapeAscii = (text: string): string =>
  JSON.stringify(text).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** `json.dumps(value, indent=2)` (ensure_ascii, Python number text). */
export function jsonDumpsIndent(value: unknown, level = 0): string {
  const pad = (n: number) => '  '.repeat(n);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return floatRepr(value);
  }
  if (typeof value === 'string') return escapeAscii(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => pad(level + 1) + jsonDumpsIndent(v, level + 1)).join(',\n')}\n${pad(level)}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(
      ([k, v]) =>
        `${pad(level + 1)}${escapeAscii(k)}: ${jsonDumpsIndent(v, level + 1)}`,
    )
    .join(',\n')}\n${pad(level)}}`;
}
