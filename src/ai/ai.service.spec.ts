import { HttpException, HttpStatus, Logger } from '@nestjs/common';

import type { SubscriptionsService } from '../billing/subscriptions.service';
import type { TokensService } from '../billing/tokens.service';
import type { SettingsService } from '../settings/settings.service';
import { AiService } from './ai.service';
import type { BedrockClient } from './bedrock/bedrock.client';

const MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

function setup(
  options: { balance?: number; multipliers?: Record<string, number> } = {},
) {
  let balance = options.balance ?? 10_000;
  const consume = jest.fn((params: { amount: number }) => {
    if (params.amount > balance) {
      return Promise.reject(
        new HttpException('short', HttpStatus.PAYMENT_REQUIRED),
      );
    }
    balance -= params.amount;
    return Promise.resolve({ balance });
  });
  const tokens = {
    balance: jest.fn(() => Promise.resolve(balance)),
    consume,
  };
  const subscriptions = { ensureAccount: jest.fn(() => Promise.resolve()) };
  const settings = {
    get: jest.fn(() =>
      Promise.resolve({ multipliers: options.multipliers ?? {} }),
    ),
  };
  const bedrock = {
    assertConfigured: jest.fn(),
    resolveModel: jest.fn((requested?: string) => requested ?? MODEL),
    converse: jest.fn(() =>
      Promise.resolve({
        text: 'answer',
        content: [{ text: 'answer' }],
        usage: { inputTokens: 700, outputTokens: 300, totalTokens: 1000 },
      }),
    ),
  };
  const service = new AiService(
    bedrock as unknown as BedrockClient,
    tokens as unknown as TokensService,
    subscriptions as unknown as SubscriptionsService,
    settings as unknown as SettingsService,
  );
  return { service, tokens, bedrock, consume };
}

describe('AiService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('prepare: 402 INSUFFICIENT_TOKENS at zero balance', async () => {
    const { service } = setup({ balance: 0 });
    const failure = service.prepare('u1');
    await expect(failure).rejects.toBeInstanceOf(HttpException);
    await expect(failure).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_TOKENS' },
      status: 402,
    });
  });

  it('prepare: returns the resolved model', async () => {
    const { service, bedrock } = setup();
    await expect(service.prepare('u1')).resolves.toBe(MODEL);
    expect(bedrock.assertConfigured).toHaveBeenCalled();
  });

  it('chargeUsage: one consume call, multiplier applied by step key', async () => {
    const { service, consume } = setup({ multipliers: { studio_agent: 2 } });
    const outcome = await service.chargeUsage('u1', {
      modelId: MODEL,
      step: 'studio_agent',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(outcome).toEqual({ charged: 300, balance: 9_700, multiplier: 2 });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][0]).toMatchObject({
      amount: 300,
      reason: 'ai_usage',
      metadata: { step: 'studio_agent', inputTokens: 100, outputTokens: 50 },
    });
  });

  it('chargeUsage: charges the remainder when the balance ran short', async () => {
    const { service, consume } = setup({ balance: 120 });
    await expect(
      service.chargeUsage('u1', {
        modelId: MODEL,
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).resolves.toEqual({ charged: 120, balance: 0, multiplier: 1 });
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('converse: keeps the old contract (content, usage, charged, balance)', async () => {
    const { service, bedrock } = setup();
    const outcome = await service.converse(
      'u1',
      MODEL,
      { messages: [{ role: 'user', content: 'Hi' }] },
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      content: 'answer',
      usage: { inputTokens: 700, outputTokens: 300, totalTokens: 1000 },
      charged: 1000,
      balance: 9000,
    });
    expect(bedrock.converse).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        temperature: 0.25,
        maxTokens: 64_000,
      }),
    );
  });
});
