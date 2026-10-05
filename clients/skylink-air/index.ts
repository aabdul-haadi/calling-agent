import { clientConfigSchema } from '@adk/shared';
import type { ClientModule } from '@backend/clients/types';
import { skylinkAir } from './client.config';
import { skylinkTools } from './tools';

export const skylinkModule: ClientModule = {
  config: clientConfigSchema.parse(skylinkAir),
  tools: skylinkTools,
  apiBasePath: '/airline',
};
