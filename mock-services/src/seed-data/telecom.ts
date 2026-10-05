import { FIRST_NAMES, LAST_NAMES, createRng } from './rng';

// All data here is fictional. "NovaTel" is not a real operator.
export interface Account {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  area: string;
  plan: { name: string; monthlyPrice: number; dataGb: number };
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface Bill {
  accountId: string;
  period: string;
  lineItems: { label: string; amount: number }[];
  total: number;
  previousTotal: number;
  dueDate: string;
  status: 'PAID' | 'DUE' | 'OVERDUE';
}

export interface Outage {
  area: string;
  status: 'OK' | 'DEGRADED' | 'OUTAGE';
  message: string;
  etaRestored?: string;
}

export interface TelecomSeed {
  accounts: Account[];
  bills: Bill[];
  outages: Outage[];
}

const PLANS = [
  { name: 'Nova Lite', monthlyPrice: 25, dataGb: 10 },
  { name: 'Nova Plus', monthlyPrice: 40, dataGb: 50 },
  { name: 'Nova Max', monthlyPrice: 65, dataGb: 200 },
];
export const AREAS = [
  'Northgate',
  'Riverside',
  'Old Harbour',
  'Maple Hill',
  'Eastfield',
  'Westmere',
];

export function buildTelecomSeed(): TelecomSeed {
  const rng = createRng(2001);
  const accounts: Account[] = [];
  const bills: Bill[] = [];
  for (let i = 0; i < 20; i++) {
    const plan = PLANS[i % PLANS.length]!;
    const id = `NT${2001 + i}`;
    accounts.push({
      id,
      firstName: FIRST_NAMES[(i + 7) % 20]!,
      lastName: LAST_NAMES[(i + 3) % 20]!,
      phone: `+1555020${String(i).padStart(4, '0')}`,
      area: AREAS[i % AREAS.length]!,
      plan,
      status: 'ACTIVE',
    });
    const lineItems = [{ label: `${plan.name} plan`, amount: plan.monthlyPrice }];
    // Every 4th customer has an extra charge so "why is my bill higher?" has a real answer.
    if (i % 4 === 1) lineItems.push({ label: 'International roaming (3 days)', amount: 18 });
    if (i % 5 === 2) lineItems.push({ label: 'Extra data pack', amount: 10 });
    const total = lineItems.reduce((s, l) => s + l.amount, 0);
    bills.push({
      accountId: id,
      period: '2026-10',
      lineItems,
      total,
      previousTotal: plan.monthlyPrice,
      dueDate: '2026-11-15',
      status: i % 7 === 6 ? 'OVERDUE' : rng.next() > 0.5 ? 'PAID' : 'DUE',
    });
  }
  const outages: Outage[] = [
    {
      area: 'Northgate',
      status: 'OUTAGE',
      message: 'Fibre cut under repair',
      etaRestored: '2026-11-11T18:00:00Z',
    },
    { area: 'Riverside', status: 'OK', message: 'All services normal' },
    { area: 'Old Harbour', status: 'DEGRADED', message: 'Slow mobile data during maintenance' },
    { area: 'Maple Hill', status: 'OK', message: 'All services normal' },
    { area: 'Eastfield', status: 'OK', message: 'All services normal' },
    { area: 'Westmere', status: 'OK', message: 'All services normal' },
  ];
  return { accounts, bills, outages };
}
