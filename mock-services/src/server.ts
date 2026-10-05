import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockApp, defaultOptions } from './app';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

const env = process.env;
const opts = defaultOptions({
  failureRate: Number(env.MOCK_FAILURE_RATE ?? 0),
  latencyMs: Number(env.MOCK_LATENCY_MS ?? 0),
  clientId: env.MOCK_CLIENT_ID ?? 'adk-backend',
  clientSecret: env.MOCK_CLIENT_SECRET ?? 'replace-me-client-secret',
  webhookSecret: env.WEBHOOK_SECRET ?? 'replace-me-webhook-secret',
});

const port = Number(env.MOCK_PORT ?? 4100);
createMockApp(opts).listen(port, () => console.log(`mock-services listening on :${port}`));
