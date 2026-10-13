import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
} from '@aws-sdk/client-bedrock-runtime';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../../config/configuration';
import { BEDROCK_RUNTIME, type BedrockRuntime } from './bedrock.types';

/** TCP connect timeout (Python core: BEDROCK_CONNECT_TIMEOUT = 10 s). */
const CONNECT_TIMEOUT_MS = 10_000;
/** 1 call + 2 retries, as botocore `retries.max_attempts=2` in the core. */
const MAX_ATTEMPTS = 3;

/**
 * Builds the SDK client from validated config. Credentials are passed
 * explicitly so the SDK never falls back to ambient AWS profiles. In mode
 * `none` a client is still built; `BedrockClient.assertConfigured` blocks
 * every call before it is sent.
 */
export function createBedrockRuntime(
  settings: AppConfiguration['bedrock'],
): BedrockRuntime {
  const config: BedrockRuntimeClientConfig = {
    region: settings.region,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: CONNECT_TIMEOUT_MS,
      // Socket inactivity limit; the overall deadline is enforced per call.
      requestTimeout: settings.timeoutMs,
    },
  };
  if (
    settings.authMode === 'sigv4' &&
    settings.accessKeyId &&
    settings.secretAccessKey
  ) {
    config.credentials = {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    };
  } else if (settings.authMode === 'bearer' && settings.apiKey) {
    config.token = { token: settings.apiKey };
    config.authSchemePreference = ['httpBearerAuth'];
  }
  return new BedrockRuntimeClient(config);
}

export const bedrockRuntimeProvider: FactoryProvider<BedrockRuntime> = {
  provide: BEDROCK_RUNTIME,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfiguration, true>) =>
    createBedrockRuntime(config.get('bedrock', { infer: true })),
};
