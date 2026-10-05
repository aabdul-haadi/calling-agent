import type { ClientModule } from '@backend/clients/types';
import { skylinkModule } from './skylink-air';

// Adding a client = create its folder and add it to this list. No engine changes.
export const allClients: ClientModule[] = [skylinkModule];
