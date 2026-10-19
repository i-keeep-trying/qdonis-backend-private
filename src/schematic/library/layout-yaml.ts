/**
 * DEV-LAYOUT: the `schematic:` section of a topology YAML as text (one flow
 * mapping per part / wire, so diffs stay readable), and replacing that
 * section in a file while leaving the rest untouched. Port of
 * `layout_to_yaml` / `replace_schematic_section` of qdonis-core
 * `schematic_sync.py`. Temporary: the developer layout tool goes before the
 * public release.
 */

import { pythonFloatRepr } from '../../common/python/python-json';
import { pythonRound } from '../../common/python/python-semantics';
import {
  isDict,
  pyStr,
  toFloat,
  truthy,
  type Dict,
} from '../../simulation/netlist/py';
import type { SchematicLayout } from '../schematic.types';
import { cmpStr } from './model';

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Python `json.dumps(text)` (ASCII only). */
function jsonQuote(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Python `str(_num(value))`: an integer as such, else rounded to 2 decimals. */
function num(value: unknown): string {
  let f: number;
  try {
    f = toFloat(value);
  } catch {
    return '0';
  }
  if (Number.isInteger(f)) return String(f);
  if (!Number.isFinite(f)) return pythonFloatRepr(f);
  const rounded = pythonRound(f, 2);
  return pythonFloatRepr(rounded);
}

const yamlKey = (key: string) => (PLAIN_KEY.test(key) ? key : jsonQuote(key));

function yamlScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return num(value);
  const text = pyStr(value);
  return PLAIN_KEY.test(text) ? text : jsonQuote(text);
}

function endToYaml(end: Dict): string {
  if (end.type === 'pin')
    return yamlScalar(`${pyStr(end.compId)}.${pyStr(end.terminal)}`);
  return `{wire: ${yamlScalar(pyStr(end.wireId))}, x: ${num(end.x ?? 0)}, y: ${num(end.y ?? 0)}}`;
}

function wiresToYaml(wires: unknown, indent: string): string[] {
  const lines: string[] = [];
  for (const w of Array.isArray(wires) ? wires : []) {
    if (!isDict(w) || !isDict(w.from) || !isDict(w.to)) continue;
    const parts = [`id: ${yamlScalar(w.id ?? null)}`];
    parts.push(`from: ${endToYaml(w.from)}`, `to: ${endToYaml(w.to)}`);
    const path = w.manualPath;
    if (Array.isArray(path) && path.length >= 2) {
      const points = path
        .filter(isDict)
        .map((p) => `[${num(p.x)}, ${num(p.y)}]`);
      parts.push(`path: [${points.join(', ')}]`);
    }
    lines.push(`${indent}- {${parts.join(', ')}}`);
  }
  return lines;
}

/** The `schematic:` section text of a layout. */
export function layoutToYaml(layout: SchematicLayout, tuned = true): string {
  const lines = [
    'schematic:',
    `  tuned: ${tuned ? 'true' : 'false'}`,
    '  components:',
  ];
  const components = Object.entries(layout.components ?? {}).sort(([a], [b]) =>
    cmpStr(a, b),
  );
  for (const [cid, p] of components) {
    const place = p as unknown as Dict;
    const rotation =
      ((Math.trunc(toFloat(place.rotation || 0)) % 360) + 360) % 360;
    const fields = [
      `x: ${num(place.x ?? 0)}`,
      `y: ${num(place.y ?? 0)}`,
      `rotation: ${rotation}`,
    ];
    if (truthy(place.mirrorX)) fields.push('mirrorX: true');
    if (truthy(place.mirrorY)) fields.push('mirrorY: true');
    lines.push(`    ${yamlKey(cid)}: {${fields.join(', ')}}`);
  }
  lines.push('  wires:');
  lines.push(...wiresToYaml(layout.wires, '  '));
  if (isDict(layout.groups)) {
    const groups = Object.entries(layout.groups);
    lines.push(`  groups:${groups.length ? '' : ' {}'}`);
    for (const [gid, g] of groups) {
      const members = (g.members ?? []).map(yamlScalar).join(', ');
      lines.push(
        `    ${yamlKey(gid)}: {label: ${jsonQuote(pyStr(g.label || gid))}, members: [${members}]}`,
      );
    }
  }
  const sheets = Object.entries(layout.sheets ?? {}).filter(
    ([, sh]) => sh?.wires?.length,
  );
  if (sheets.length) {
    lines.push('  sheets:');
    for (const [gid, sh] of sheets) {
      lines.push(`    ${yamlKey(gid)}:`, '      wires:');
      lines.push(...wiresToYaml(sh.wires, '      '));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Replace (or append) the top-level `schematic:` section of a YAML text. */
export function replaceSchematicSection(text: string, section: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const start = lines.findIndex((line) =>
    /^schematic:\s*(#.*)?$/.test(line.replace(/\r?\n$/, '')),
  );
  if (start < 0) {
    const body = text.endsWith('\n') || !text ? text : `${text}\n`;
    return body + section;
  }
  let end = start + 1;
  while (
    end < lines.length &&
    (!lines[end].trim() || lines[end][0] === ' ' || lines[end][0] === '\t')
  ) {
    end += 1;
  }
  return lines.slice(0, start).join('') + section + lines.slice(end).join('');
}
