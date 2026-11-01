import { describe, expect, it } from 'vitest';
import { loadEnv } from '@backend/config/env';

/** What docker-compose.prod.yml hands the backend: unset optional settings arrive as empty strings. */
const production = {
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://console.example.com',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://identity.example.com/tenant',
  OIDC_AUDIENCE: 'agent-delivery-api',
  DATABASE_URL: 'postgres://adk:pw@db:5432/adk',
  LLM_REASONING_EFFORT: '',
  LLM_FALLBACK_MODEL: '',
  LLM_CLASSIFIER_MODEL: '',
  OPENAI_API_KEY: '',
  OPENAI_BASE_URL: '',
  MOCK_CLIENT_ID: 'adk-backend',
  MOCK_CLIENT_SECRET: 'secret',
  WEBHOOK_SECRET: 'webhook-secret',
  VOICE_GATEWAY_SECRET: 'voice-secret',
  VOICE_GATEWAY_URL: 'wss://console.example.com/voice/ws',
  VOICE_GATEWAY_HTTP_URL: 'http://voice:8765',
};

describe('deployment environment', () => {
  it('accepts the production settings with every optional value left empty', () => {
    const env = loadEnv(production);
    expect(env.LLM_CLASSIFIER_MODEL).toBeUndefined();
    expect(env.LLM_FALLBACK_MODEL).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.AUTH_MODE).toBe('oidc');
  });

  it('accepts the private-demo preset, where no identity provider is configured', () => {
    const env = loadEnv({
      ...production,
      NODE_ENV: 'development',
      AUTH_MODE: 'development',
      OIDC_ISSUER: '',
      OIDC_AUDIENCE: '',
    });
    expect(env.OIDC_ISSUER).toBeUndefined();
    expect(env.OIDC_AUDIENCE).toBeUndefined();
  });

  it('still refuses to run production without OIDC, with an insecure issuer, or with none', () => {
    expect(() => loadEnv({ ...production, AUTH_MODE: 'development' })).toThrow(/AUTH_MODE=oidc is required/);
    expect(() => loadEnv({ ...production, OIDC_ISSUER: 'http://identity.example.com' })).toThrow(/HTTPS/);
    expect(() => loadEnv({ ...production, OIDC_ISSUER: '' })).toThrow(/OIDC_ISSUER and OIDC_AUDIENCE are required/);
    expect(() => loadEnv({ ...production, OIDC_AUDIENCE: '' })).toThrow(/OIDC_ISSUER and OIDC_AUDIENCE are required/);
  });

  it('still rejects a missing required secret', () => {
    expect(() => loadEnv({ ...production, WEBHOOK_SECRET: '' })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadEnv({ ...production, MOCK_CLIENT_SECRET: '' })).toThrow(/MOCK_CLIENT_SECRET/);
  });
});
