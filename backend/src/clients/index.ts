import { resolve } from 'node:path';
import { allClients } from '@clients/registry';
import { REPO_ROOT } from '../config/repo-root';
import { createRegistry, type ClientRegistry } from './registry';
import type { ClientModule } from './types';

export * from './types';
export * from './registry';

export const loadClients = (): ClientRegistry => createRegistry(allClients);

/** Absolute path of a client's folder (knowledge docs, scenarios live inside it). */
export const clientDir = (module: ClientModule): string =>
  resolve(REPO_ROOT, 'clients', module.config.id);
