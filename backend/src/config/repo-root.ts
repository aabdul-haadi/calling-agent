import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure path helper (no side effects), safe to import from tests.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
