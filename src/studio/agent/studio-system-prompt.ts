import { PROJECT_STATE_LIMIT } from '../studio.types';
import {
  pythonJsonDumps,
  truncateCodePoints,
} from '../../common/python/python-json';
import { STUDIO_SYSTEM_PROMPT } from './studio-system-prompt.text';

const FAMILY: Record<string, string> = {
  dcdc: 'DC-DC',
  acdc: 'AC-DC',
  dcac: 'DC-AC',
};

/** Python `str.title()` for ASCII: capitalise each run of letters. */
function pythonTitle(text: string): string {
  let previousIsLetter = false;
  let out = '';
  for (const char of text) {
    const isLetter = /[A-Za-z]/.test(char);
    out += isLetter
      ? previousIsLetter
        ? char.toLowerCase()
        : char.toUpperCase()
      : char;
    previousIsLetter = isLetter;
  }
  return out;
}

/** `dcdc_synchronous_buck` -> `Synchronous Buck (DC-DC)`. */
export function humanizeTopology(topologyId: string): string {
  const separator = topologyId.indexOf('_');
  const prefix = separator >= 0 ? topologyId.slice(0, separator) : topologyId;
  const family = FAMILY[prefix] ?? '';
  const rest =
    separator >= 0 && family ? topologyId.slice(separator + 1) : topologyId;
  const name = pythonTitle(rest.replaceAll('_', ' '));
  return family ? `${name} (${family})` : name;
}

/** Python `_compact`: JSON text, truncated to `limit` code points. */
export function compactJson(value: unknown, limit: number): string {
  return truncateCodePoints(pythonJsonDumps(value), limit, '…(truncated)');
}

/**
 * The prompt plus the topology library and the active-branch snapshot
 * (port of qdonis-core `build_system_prompt`).
 */
export function buildStudioSystemPrompt(
  projectState: Record<string, unknown>,
  topologyIds: readonly string[],
): string {
  const library =
    topologyIds.map((id) => `\`${id}\` (${humanizeTopology(id)})`).join(', ') ||
    '(unavailable)';
  const stateBlock = compactJson(projectState, PROJECT_STATE_LIMIT);
  return (
    STUDIO_SYSTEM_PROMPT +
    '\n\n## Topology library (only these ids can be visualised, designed and simulated)\n' +
    library +
    '\n\n## Current project snapshot (active branch)\n```json\n' +
    stateBlock +
    '\n```\n'
  );
}
