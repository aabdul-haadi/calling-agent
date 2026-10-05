import { clientConfigSchema } from '@adk/shared';
import type { ClientModule } from '@backend/clients/types';
import { novatel } from './client.config';
import { novatelTools } from './tools';

export const novatelModule: ClientModule = {
  config: clientConfigSchema.parse(novatel),
  tools: novatelTools,
  apiBasePath: '/telecom',
};
