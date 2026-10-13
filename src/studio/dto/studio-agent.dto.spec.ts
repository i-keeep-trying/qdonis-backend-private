import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { loadStudioFixtures } from '../../../test/parity/studio-agent-fixtures';
import { StudioAgentRequestDto } from './studio-agent.dto';

/** Same options as the global pipe in AppModule. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  validationError: { target: false, value: false },
  stopAtFirstError: true,
});

const validate = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: StudioAgentRequestDto,
  }) as Promise<StudioAgentRequestDto>;

const fixtures = loadStudioFixtures();

describe('StudioAgentRequestDto', () => {
  it.each(
    fixtures.filter((f) => !f.wire_invalid).map((f) => [f.name, f] as const),
  )('accepts fixture %s unchanged', async (_, fixture) => {
    const body = {
      messages: fixture.input.messages,
      ...(fixture.input.project_state === undefined
        ? {}
        : { project_state: fixture.input.project_state }),
    };
    const dto = await validate(body);
    // Tool inputs / results pass through untouched (JSON-equal).
    expect(JSON.parse(JSON.stringify(dto))).toEqual(
      JSON.parse(JSON.stringify(body)),
    );
  });

  it.each(
    fixtures.filter((f) => f.wire_invalid).map((f) => [f.name, f] as const),
  )('rejects fixture %s (stricter than Python)', async (_, fixture) => {
    await expect(
      validate({
        messages: fixture.input.messages,
        project_state: fixture.input.project_state,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  const ok = { role: 'user', content: [{ type: 'text', text: 'hi' }] };

  it.each([
    ['empty messages', { messages: [] }],
    ['missing messages', {}],
    ['bad role', { messages: [{ role: 'system', content: [] }] }],
    ['string content', { messages: [{ role: 'user', content: 'hi' }] }],
    [
      'unknown block key',
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'x', extra: 1 }] },
        ],
      },
    ],
    ['unknown top-level key', { messages: [ok], model: 'opus' }],
    ['non-object project_state', { messages: [ok], project_state: [1] }],
    [
      'non-string text',
      { messages: [{ role: 'user', content: [{ type: 'text', text: 5 }] }] },
    ],
    [
      'non-boolean is_error',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'a', is_error: 'yes' },
            ],
          },
        ],
      },
    ],
    [
      'oversize text',
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(1_000_001) }],
          },
        ],
      },
    ],
    ['too many messages', { messages: Array.from({ length: 201 }, () => ok) }],
    [
      'too many blocks',
      {
        messages: [
          {
            role: 'user',
            content: Array.from({ length: 501 }, () => ({
              type: 'text',
              text: 'x',
            })),
          },
        ],
      },
    ],
    [
      'oversize id',
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'x'.repeat(257), name: 'a' }],
          },
        ],
      },
    ],
  ])('rejects %s', async (_, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
