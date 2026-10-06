import '../config/load-dotenv';
import { resolve } from 'node:path';
import { loadEnv } from '../config';
import { connectDb, runMigrations } from '../database';
import { clientDir, loadClients } from '../clients';
import { createEmbeddingProvider } from './embeddings';
import { ingestClient } from './ingest';

const env = loadEnv();
const handle = await connectDb(env.DATABASE_URL, env.DATABASE_SSL);
await runMigrations(handle);
const embeddings = createEmbeddingProvider(env);
const wanted = process.argv[2];

for (const module of loadClients().list()) {
  if (wanted && module.config.id !== wanted) continue;
  const n = await ingestClient(
    handle.db,
    embeddings,
    module.config.id,
    resolve(clientDir(module), module.config.knowledgeDir),
  );
  console.log(`${module.config.id}: ingested ${n} chunks`);
}
await handle.close();
