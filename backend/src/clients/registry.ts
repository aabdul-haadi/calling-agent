import type { ClientSummary } from '@adk/shared';
import type { ClientModule } from './types';

export interface ClientRegistry {
  list(): ClientModule[];
  get(id: string): ClientModule | undefined;
  summaries(): ClientSummary[];
}

/** Validates the wiring at startup so a typo in a client folder fails loudly, not mid-conversation. */
export function createRegistry(modules: ClientModule[]): ClientRegistry {
  const byId = new Map<string, ClientModule>();
  for (const m of modules) {
    const { config } = m;
    if (byId.has(config.id)) throw new Error(`Duplicate client id: ${config.id}`);
    const toolNames = new Set(m.tools.map((t) => t.name));
    for (const name of config.tools) {
      if (!toolNames.has(name)) throw new Error(`Client ${config.id}: config lists tool "${name}" but no such tool is registered`);
    }
    for (const rule of config.rules) {
      const referenced = rule.kind === 'requiresVerification' ? rule.tools : [rule.tool];
      for (const name of referenced) {
        if (!config.tools.includes(name)) throw new Error(`Client ${config.id}: rule "${rule.id}" references unknown tool "${name}"`);
      }
    }
    byId.set(config.id, m);
  }
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
    summaries: () =>
      [...byId.values()].map(({ config: c }) => ({
        id: c.id,
        displayName: c.displayName,
        initials: c.initials,
        accent: c.accent,
        tagline: c.tagline,
        channels: c.channels,
      })),
  };
}
