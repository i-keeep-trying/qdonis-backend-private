import { configuration } from './configuration';
import { validateEnv } from './env.validation';

const BASE: Record<string, string> = {
  NODE_ENV: 'test',
  FRONTEND_URL: 'http://localhost:5173',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  OAUTH_STATE_SECRET: 'b'.repeat(40),
};

const KEY_ID = 'AKIATESTKEY000000000';
const SECRET = 'test-secret-0000000000000000';
const API_KEY = 'bedrock-api-key-00000000000';

describe('bedrock configuration', () => {
  const saved = process.env;

  afterEach(() => {
    process.env = saved;
  });

  const bedrock = (env: Record<string, string>) => {
    process.env = { ...BASE, ...env };
    return configuration().bedrock;
  };

  it('selects sigv4 when the AWS key pair is set (even with an API key)', () => {
    const config = bedrock({
      AWS_ACCESS_KEY_ID: KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET,
      BEDROCK_API_KEY: API_KEY,
    });
    expect(config.authMode).toBe('sigv4');
    expect(config.accessKeyId).toBe(KEY_ID);
    expect(config.secretAccessKey).toBe(SECRET);
  });

  it('selects bearer with only BEDROCK_API_KEY', () => {
    expect(bedrock({ BEDROCK_API_KEY: API_KEY }).authMode).toBe('bearer');
  });

  it('selects none without credentials', () => {
    expect(bedrock({}).authMode).toBe('none');
  });

  it('treats blank values as unset', () => {
    const config = bedrock({
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '  ',
      BEDROCK_API_KEY: '',
      BEDROCK_REGION: '',
      AWS_REGION: '',
    });
    expect(config.authMode).toBe('none');
    expect(config.region).toBe('us-east-1');
  });

  it('prefers BEDROCK_REGION, then AWS_REGION, then us-east-1', () => {
    expect(
      bedrock({ BEDROCK_REGION: 'eu-west-1', AWS_REGION: 'us-west-2' }).region,
    ).toBe('eu-west-1');
    expect(bedrock({ AWS_REGION: 'us-west-2' }).region).toBe('us-west-2');
    expect(bedrock({}).region).toBe('us-east-1');
  });

  it('rejects half an AWS key pair', () => {
    expect(() => validateEnv({ ...BASE, AWS_ACCESS_KEY_ID: KEY_ID })).toThrow(
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/,
    );
    expect(() =>
      validateEnv({ ...BASE, AWS_SECRET_ACCESS_KEY: SECRET }),
    ).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
  });

  it('rejects malformed AWS values', () => {
    expect(() =>
      validateEnv({
        ...BASE,
        AWS_ACCESS_KEY_ID: 'not a key',
        AWS_SECRET_ACCESS_KEY: SECRET,
      }),
    ).toThrow(/AWS_ACCESS_KEY_ID/);
    expect(() => validateEnv({ ...BASE, AWS_REGION: 'Mars' })).toThrow(
      /AWS_REGION/,
    );
  });
});
