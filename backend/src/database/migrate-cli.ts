import '../config/load-dotenv';
import { loadEnv } from '../config';
import { createPostgresDb, runMigrations } from './client';

const env = loadEnv();
const handle = await createPostgresDb(env.DATABASE_URL);
await runMigrations(handle, 'postgres');
console.log('Migrations applied.');
await handle.close();
