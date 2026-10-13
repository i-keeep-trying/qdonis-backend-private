import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';

import type { JsonValue } from '../../src/ai/bedrock/bedrock.types';

/**
 * Loader for the qdonis-core parity fixtures (test-only; written by
 * test/parity/capture/studio_agent_capture.py).
 */
export const FIXTURE_DIR = join(__dirname, 'fixtures', 'studio-agent');

export interface StudioFixture {
  name: string;
  description: string;
  topology_ids: string[];
  input: { messages: unknown[]; project_state: unknown };
  bedrock_stream: ConverseStreamOutput[];
  bedrock_error: {
    on_call?: boolean;
    after_events?: number;
    message: string;
  } | null;
  expected_request: Record<string, JsonValue>;
  expected_events: Array<Record<string, JsonValue>>;
  /** Set when the Nest DTO (stricter than Python) rejects the input. */
  wire_invalid?: string;
}

export function loadStudioFixtures(): StudioFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => /^\d+-.*\.json$/.test(file))
    .sort()
    .map(
      (file) =>
        JSON.parse(
          readFileSync(join(FIXTURE_DIR, file), 'utf8'),
        ) as StudioFixture,
    );
}

export function loadTopologyIds(): string[] {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'topology-ids.json'), 'utf8'),
  ) as string[];
}
