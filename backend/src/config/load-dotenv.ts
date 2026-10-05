import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The single .env lives in the repo root and is shared by backend and mock-services.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');
config({ path: resolve(REPO_ROOT, '.env'), quiet: true });
