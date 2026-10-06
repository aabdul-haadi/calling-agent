import '../config/load-dotenv';
import { loadEnv } from '../config';
import { connectDb, runMigrations } from './client';

const env = loadEnv();
const handle = await connectDb(env.DATABASE_URL, env.DATABASE_SSL);
await runMigrations(handle);
console.log('Migrations applied.');
await handle.close();
