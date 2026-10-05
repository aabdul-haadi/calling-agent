import { z } from 'zod';
import { defineTool } from '@backend/tools/types';
import { outageSchema } from './api';

export const checkOutage = defineTool({
  name: 'check_outage',
  description: 'Check network status for a coverage area by name, for example "Northgate". Public information, no verification needed.',
  input: z.object({ area: z.string().trim().min(2).max(40) }),
  label: 'Checked the network status',
  run: (input, ctx) => ctx.api.request({ path: 'outages', query: { area: input.area }, schema: outageSchema }),
  summarize: (d) => (d.status === 'OK' ? `${d.area}: no problems` : `${d.area}: ${d.status.toLowerCase()}`),
  remember: (data) => ({ collected: { outage: data }, step: 'look_up' }),
});
