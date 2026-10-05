import { config } from 'dotenv';
import { resolve } from 'node:path';
import { REPO_ROOT } from './repo-root';

// The single .env lives in the repo root and is shared by backend and mock-services.
config({ path: resolve(REPO_ROOT, '.env'), quiet: true });
