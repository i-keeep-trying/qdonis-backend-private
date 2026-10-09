import { toConverseMessages } from './message-normalizer';

const user = (...content: unknown[]) => ({ role: 'user', content });
const assistant = (...content: unknown[]) => ({ role: 'assistant', content });
const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (id: string, name = 'run_design', input: unknown = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolResult = (id: string, content: unknown = 'ok', isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  is_error: isError,
});
const missing = (id: string) => ({
  toolResult: {
    toolUseId: id,
    content: [{ text: '(no result recorded)' }],
    status: 'error',
  },
});

describe('toConverseMessages (history repair)', () => {
  it('merges consecutive same-role turns', () => {
    expect(
      toConverseMessages([
        user(text('a')),
        user(text('b')),
        assistant(text('c')),
        assistant(text('d')),
        user(text('e')),
      ]),
    ).toEqual([
      { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
      { role: 'assistant', content: [{ text: 'c' }, { text: 'd' }] },
      { role: 'user', content: [{ text: 'e' }] },
    ]);
  });

  it('drops orphan results and puts results first', () => {
    expect(
      toConverseMessages([
        user(text('go')),
        assistant(toolUse('t1')),
        user(text('after'), toolResult('t1'), toolResult('nope')),
      ]),
    ).toEqual([
      { role: 'user', content: [{ text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { toolUse: { toolUseId: 't1', name: 'run_design', input: {} } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 't1',
              content: [{ text: 'ok' }],
              status: 'success',
            },
          },
          { text: 'after' },
        ],
      },
    ]);
  });

  it('synthesizes missing results in tool-use order', () => {
    const turns = toConverseMessages([
      user(text('go')),
      assistant(toolUse('t2'), toolUse('t1'), toolUse('t3')),
      user(toolResult('t1'), text('hm')),
    ]);
    expect(turns[2].content).toEqual([
      {
        toolResult: {
          toolUseId: 't1',
          content: [{ text: 'ok' }],
          status: 'success',
        },
      },
      missing('t2'),
      missing('t3'),
      { text: 'hm' },
    ]);
  });

  it('answers a trailing tool use and never ends on the assistant', () => {
    expect(
      toConverseMessages([
        user(text('go')),
        assistant(text('x'), toolUse('t9')),
      ]).at(-1),
    ).toEqual({ role: 'user', content: [missing('t9')] });
    expect(
      toConverseMessages([user(text('go')), assistant(text('x'))]).at(-1),
    ).toEqual({ role: 'user', content: [{ text: 'Continue.' }] });
  });

  it('starts on a real user turn', () => {
    expect(
      toConverseMessages([
        assistant(toolUse('t1')),
        user(toolResult('t1')),
        assistant(text('done')),
        user(text('real')),
      ]),
    ).toEqual([{ role: 'user', content: [{ text: 'real' }] }]);
  });

  it('falls back to Hello when nothing usable is left', () => {
    expect(
      toConverseMessages([
        assistant(text('hi')),
        user(text('  ')),
        { role: 'system', content: 'x' },
      ]),
    ).toEqual([{ role: 'user', content: [{ text: 'Hello' }] }]);
  });

  it('accepts string content and maps tool result shapes', () => {
    const turns = toConverseMessages([
      { role: 'user', content: '  plain  ' },
      assistant(
        toolUse('a'),
        toolUse('b'),
        toolUse('c'),
        toolUse('d'),
        toolUse('e'),
      ),
      user(
        toolResult('a', { x: 1 }),
        toolResult('b', [1, 'two']),
        toolResult('c', ''),
        toolResult('d', true, true),
        toolResult('e', null),
      ),
    ]);
    expect(turns[0]).toEqual({ role: 'user', content: [{ text: 'plain' }] });
    expect(turns[2].content.map((block) => block.toolResult)).toEqual([
      { toolUseId: 'a', content: [{ json: { x: 1 } }], status: 'success' },
      {
        toolUseId: 'b',
        content: [{ json: { items: [1, 'two'] } }],
        status: 'success',
      },
      { toolUseId: 'c', content: [{ text: '(empty)' }], status: 'success' },
      { toolUseId: 'd', content: [{ text: 'True' }], status: 'error' },
      { toolUseId: 'e', content: [{ text: '(empty)' }], status: 'success' },
    ]);
  });

  it('ignores tool uses from the user and results from the assistant', () => {
    expect(
      toConverseMessages([
        user(text('go'), toolUse('u1')),
        assistant(text('ok'), toolResult('x'), toolUse('a1', 'open_view', [1])),
        user(toolResult('a1')),
      ]),
    ).toEqual([
      { role: 'user', content: [{ text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { text: 'ok' },
          { toolUse: { toolUseId: 'a1', name: 'open_view', input: {} } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'a1',
              content: [{ text: 'ok' }],
              status: 'success',
            },
          },
        ],
      },
    ]);
  });
});
