import type { ParsedClientConfig } from '@adk/shared';
import type { AnyToolDefinition } from '../tools/types';

/** Everything the engine needs to know about one company. Adding a client = adding one of these. */
export interface ClientModule {
  config: ParsedClientConfig;
  tools: AnyToolDefinition[];
  /** Path on MOCK_SERVICES_URL where this client's company API lives. */
  apiBasePath: string;
}
