import { createHash } from 'node:crypto';

/**
 * Fingerprint of a deck map as core's verifier compares it: dc/ac/transient
 * with non-empty text, line ends normalised.
 */
export function decksSha256(decks: Record<string, unknown>): string {
  const normalized: string[] = [];
  for (const kind of ['dc', 'ac', 'transient']) {
    const deck = decks[kind];
    if (typeof deck === 'string' && deck.trim()) {
      normalized.push(`${kind}\u0000${deck.replace(/\r\n?/g, '\n')}`);
    }
  }
  return createHash('sha256').update(normalized.join('\u0001')).digest('hex');
}
