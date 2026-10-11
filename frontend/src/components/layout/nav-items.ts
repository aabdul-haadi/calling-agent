import {
  Activity,
  BookOpen,
  Bot,
  FlaskConical,
  Headset,
  LayoutDashboard,
  Mic,
  Network,
  Settings2,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  /** Builds the link for the selected tenant. */
  to: (tenantId: string) => string;
  icon: LucideIcon;
  /** Matches the current path (also handles old URLs that now redirect). */
  match: (path: string) => boolean;
  hint: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'overview',
    label: 'Overview',
    to: () => '/',
    icon: LayoutDashboard,
    match: (p) => p === '/',
    hint: 'Live state of the platform',
  },
  {
    id: 'console',
    label: 'Agent Console',
    to: (t) => `/agent/${t}`,
    icon: Bot,
    match: (p) => p.startsWith('/agent'),
    hint: 'Talk to the agent and watch it work',
  },
  {
    id: 'traces',
    label: 'Traces',
    to: () => '/traces',
    icon: Activity,
    match: (p) => p.startsWith('/traces'),
    hint: 'Step-by-step record of every turn',
  },
  {
    id: 'handoffs',
    label: 'Human Handoffs',
    to: () => '/handoffs',
    icon: Headset,
    match: (p) => p.startsWith('/handoffs') || p.startsWith('/inbox'),
    hint: 'Customers passed to a person',
  },
  {
    id: 'evaluations',
    label: 'Evaluations',
    to: () => '/evaluations',
    icon: FlaskConical,
    match: (p) => p.startsWith('/evaluations') || p.startsWith('/tests'),
    hint: 'Scenario tests and quality',
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    to: () => '/knowledge',
    icon: BookOpen,
    match: (p) => p.startsWith('/knowledge'),
    hint: 'Policy documents the agent cites',
  },
  {
    id: 'tenants',
    label: 'Tenants & Config',
    to: (t) => `/tenants/${t}`,
    icon: Settings2,
    match: (p) => p.startsWith('/tenants') || p.startsWith('/clients'),
    hint: 'Persona, tools, rules, escalation',
  },
  {
    id: 'voice',
    label: 'Voice Lab',
    to: () => '/voice',
    icon: Mic,
    match: (p) => p.startsWith('/voice'),
    hint: 'Browser voice with a live waveform',
  },
  {
    id: 'architecture',
    label: 'Architecture',
    to: () => '/architecture',
    icon: Network,
    match: (p) => p.startsWith('/architecture') || p.startsWith('/about'),
    hint: 'How the platform works',
  },
];
