import '../config/load-dotenv';
import { loadEnv } from '../config';
import { createServices } from '../container';
import { connectDb, runMigrations } from '../database';
import { ingestClient, createEmbeddingProvider } from '../knowledge';
import { clientDir } from '../clients';
import { createLogger } from '../logger';
import { resolve } from 'node:path';

// Usage: pnpm eval skylink-air
const clientId = process.argv[2];
if (!clientId) {
  console.error('Usage: pnpm eval <client-id>   e.g. pnpm eval skylink-air');
  process.exit(1);
}

const env = loadEnv();
const logger = createLogger('warn');
const handle = await connectDb(env.DATABASE_URL, env.DATABASE_SSL);
await runMigrations(handle);
const services = createServices(env, handle.db, logger);

const module = services.registry.get(clientId);
if (!module) {
  console.error(
    `Unknown client "${clientId}". Known: ${services.registry
      .list()
      .map((m) => m.config.id)
      .join(', ')}`,
  );
  process.exit(1);
}
// Make sure policies are ingested so knowledge scenarios are meaningful.
await ingestClient(
  handle.db,
  createEmbeddingProvider(env),
  clientId,
  resolve(clientDir(module), module.config.knowledgeDir),
);

console.log(
  `Running scenario suite for ${module.config.displayName} (real LLM: ${env.LLM_PROVIDER}/${env.LLM_MODEL})...\n`,
);
const run = await services.evals.run(clientId, (r) => {
  console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.scenarioId}  - ${r.title}`);
  for (const f of r.failures) console.log(`        ${f}`);
});
console.log(`\nSCORE: ${run.passed}/${run.total}  (run ${run.id}, status ${run.status})`);
await handle.close();
