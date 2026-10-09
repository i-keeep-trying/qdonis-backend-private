import { convertTools } from './bedrock-tools';

describe('convertTools', () => {
  it('returns undefined for no tools', () => {
    expect(convertTools(undefined)).toBeUndefined();
    expect(convertTools([])).toBeUndefined();
    expect(convertTools([{ type: 'function', function: {} }])).toBeUndefined();
  });

  it('converts OpenAI function tools to Converse tool specs', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    };
    expect(
      convertTools([
        {
          type: 'function',
          function: { name: 'one', description: 'First', parameters: schema },
        },
        { type: 'function', function: { name: 'two' } },
        { name: 'bare', description: 'Not wrapped' },
        'garbage',
        { type: 'function', function: 'garbage' },
        { type: 'function', function: { description: 'nameless' } },
      ]),
    ).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'one',
            description: 'First',
            inputSchema: { json: schema },
          },
        },
        {
          toolSpec: {
            name: 'two',
            description: 'two',
            inputSchema: { json: { type: 'object', properties: {} } },
          },
        },
        {
          toolSpec: {
            name: 'bare',
            description: 'Not wrapped',
            inputSchema: { json: { type: 'object', properties: {} } },
          },
        },
      ],
    });
  });
});
