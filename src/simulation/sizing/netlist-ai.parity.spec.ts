/**
 * Netlist-AI helper parity with qdonis-core (canned replies; fixtures from
 * test/parity/capture/netlist_ai_capture.py).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildAiFixUserPrompt,
  buildModifyUserPrompt,
  extractNetlistText,
  fixedDeck,
  modifyRows,
  parseModifyReply,
  parseVerification,
} from './netlist-ai.logic';
import { jsonLoadsPy } from './sizing.logic';

interface Fixture {
  extract: Array<{ raw: string; text: string }>;
  fix: Array<{ reply: string; deck: string }>;
  fix_prompt: Array<{ key: string; prompt: string; text: string }>;
  modify: Array<{
    raw: string;
    deck: string;
    reasoning: string | null;
    parameters: Record<string, unknown>;
    rows: unknown[];
    user: string;
  }>;
  verify: Array<{
    content: string;
    verification: { evidence: Array<{ observed: string }> };
  }>;
}

const fx = jsonLoadsPy(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'test',
      'parity',
      'fixtures',
      'netlist-ai',
      'vectors.json',
    ),
    'utf8',
  ),
) as Fixture;

const DECK =
  '* buck\r\nV1 in 0 12\r\nL1 in out 47u\r\nR1 out 0 10\r\n.end\r\n.control\r\ntran 1u 1m\r\nmeas tran v avg v(out)\r\n.endc\r\n';

describe('netlist AI parity with qdonis-core', () => {
  it('extracts the netlist from a reply', () => {
    for (const c of fx.extract) expect(extractNetlistText(c.raw)).toBe(c.text);
  });

  it('keeps the frozen tail of a fixed deck', () => {
    for (const c of fx.fix) expect(fixedDeck(DECK, c.reply)).toBe(c.deck);
  });

  it('builds the ai-fix prompt', () => {
    for (const c of fx.fix_prompt) {
      expect(buildAiFixUserPrompt(c.key, DECK, c.prompt)).toBe(c.text);
    }
  });

  it('parses modification replies', () => {
    for (const c of fx.modify) {
      const reply = parseModifyReply(DECK, c.raw);
      expect(reply.deck).toBe(c.deck);
      expect(reply.reasoning).toBe(c.reasoning);
      expect(reply.parameters ?? {}).toEqual(c.parameters);
      expect(modifyRows(reply.parameters ?? {})).toEqual(c.rows);
      expect(
        buildModifyUserPrompt(
          'transient',
          DECK,
          { Vin: '48 V', n: 3, x: 1.5, é: ['ü'] },
          'make it better',
        ),
      ).toBe(c.user);
    }
  });

  it('validates verifier replies', () => {
    for (const c of fx.verify) {
      const got = parseVerification(c.content);
      const expected = c.verification;
      if (expected.evidence[0]?.observed === '<error>')
        got.evidence[0].observed = '<error>';
      expect(got).toEqual(expected);
    }
  });
});
