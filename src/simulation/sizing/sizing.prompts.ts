import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { SIZING_SYSTEM_PROMPT_TEMPLATE } from './sizing-system-prompt.text';

/** Python text-mode read: universal newlines. */
const readText = (path: string): string =>
  readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');

let base: string | null = null;

/**
 * Sizing system prompt: core's base rules with the MOSFET database, plus the
 * topology's own rules when `assets/topologies/prompts/<id>.prompt.md` exists.
 */
export function sizingSystemPrompt(topologyId: string | null): string {
  base ??= SIZING_SYSTEM_PROMPT_TEMPLATE.replace(
    '{{MOSFET_DB}}',
    readText(join(ASSETS_ROOT, 'mosfet_database.json')),
  );
  if (!topologyId || !/^[A-Za-z0-9_()-]+$/.test(topologyId)) return base;
  const path = join(
    ASSETS_ROOT,
    'topologies',
    'prompts',
    `${topologyId}.prompt.md`,
  );
  return existsSync(path) ? `${base}\n\n${readText(path)}` : base;
}
