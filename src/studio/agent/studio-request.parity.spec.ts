import {
  loadStudioFixtures,
  loadTopologyIds,
} from '../../../test/parity/studio-agent-fixtures';
import { buildConverseInput } from '../../ai/bedrock/bedrock.client';
import { STUDIO_TOPOLOGY_IDS } from './topology-library';
import { buildStudioRequest } from './studio-request.builder';

const NO_RESULT = '(no result recorded)';

interface Block {
  toolResult?: {
    toolUseId?: string;
    content?: Array<{ text?: string }>;
    status?: string;
  };
}
interface Request {
  messages?: Array<{ content?: Block[] }>;
}

const isSynthesized = (block: Block) =>
  block.toolResult?.status === 'error' &&
  block.toolResult.content?.length === 1 &&
  block.toolResult.content[0].text === NO_RESULT;

/**
 * Python orders synthesized "(no result recorded)" results by set iteration
 * (hash order); Nest uses tool-use order. Sort each run of them by id on
 * both sides so only that known difference is ignored.
 */
function canonical<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T & Request;
  for (const message of copy.messages ?? []) {
    const blocks = message.content ?? [];
    let start = 0;
    while (start < blocks.length) {
      if (!isSynthesized(blocks[start])) {
        start++;
        continue;
      }
      let end = start;
      while (end < blocks.length && isSynthesized(blocks[end])) end++;
      const run = blocks
        .slice(start, end)
        .sort((a, b) =>
          (a.toolResult?.toolUseId ?? '').localeCompare(
            b.toolResult?.toolUseId ?? '',
          ),
        );
      blocks.splice(start, run.length, ...run);
      start = end;
    }
  }
  return copy;
}

const fixtures = loadStudioFixtures();

describe('Studio agent request parity with qdonis-core', () => {
  it('has fixtures to compare', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it('uses the same topology library as the core', () => {
    expect([...STUDIO_TOPOLOGY_IDS]).toEqual(loadTopologyIds());
  });

  describe.each(fixtures.map((f) => [f.name, f] as const))(
    '%s',
    (_, fixture) => {
      const build = () =>
        buildConverseInput(
          buildStudioRequest({
            modelId: fixture.expected_request.modelId as string,
            messages: fixture.input.messages,
            projectState: fixture.input.project_state,
            topologyIds: fixture.topology_ids,
            signal: new AbortController().signal,
          }),
          64_000,
        );

      it('builds the same system prompt', () => {
        expect(build().system).toEqual(fixture.expected_request.system);
      });

      it('builds the same tool config', () => {
        expect(JSON.parse(JSON.stringify(build().toolConfig))).toEqual(
          fixture.expected_request.toolConfig,
        );
      });

      it('builds the same messages', () => {
        expect(canonical({ messages: build().messages })).toEqual(
          canonical({ messages: fixture.expected_request.messages }),
        );
      });

      it('builds a deep-equal request', () => {
        expect(canonical(build())).toEqual(canonical(fixture.expected_request));
      });
    },
  );
});
