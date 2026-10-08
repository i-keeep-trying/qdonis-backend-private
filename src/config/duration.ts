const MULTIPLIERS_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/**
 * Converts a `jsonwebtoken`-style duration (`900`, `15m`, `7d`) to
 * milliseconds. A bare number means seconds, matching `jsonwebtoken`.
 */
export function durationToMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)?$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Unsupported duration format: ${duration}`);
  }
  return Number(match[1]) * MULTIPLIERS_MS[match[2] ?? 's'];
}

/** Same as {@link durationToMs}, floored to whole seconds. */
export function durationToSeconds(duration: string): number {
  return Math.floor(durationToMs(duration) / 1_000);
}
