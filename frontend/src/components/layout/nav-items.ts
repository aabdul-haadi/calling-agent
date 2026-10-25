import {
  Activity,
  BookOpen,
  Bot,
  FlaskConical,
  GraduationCap,
  Headset,
  LayoutDashboard,
  Mic,
  PackageCheck,
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
  /** Sidebar section. */
  group: NavGroup;
}

export type NavGroup =
  | 'Start here'
  | 'Operate'
  | 'Improve'
  | 'Manage'
  | 'Settings';
export const NAV_GROUPS: NavGroup[] = ['Start here', 'Operate', 'Improve', 'Manage', 'Settings'];

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'overview',
    group: 'Start here',
    label: 'Overview',
    to: () => '/',
    icon: LayoutDashboard,
    match: (p) => p === '/',
    hint: 'Live state of the platform',
  },
  {
    id: 'console',
    group: 'Operate',
    label: 'Agent workspace',
    to: (t) => `/agent/${t}`,
    icon: Bot,
    match: (p) => p.startsWith('/agent'),
    hint: 'Test Ava with chat and monitor each turn',
  },
  {
    id: 'conversations',
    group: 'Operate',
    label: 'Conversations',
    to: () => '/conversations',
    icon: Activity,
    match: (p) => p.startsWith('/conversations') || p.startsWith('/traces'),
    hint: 'Find and understand previous customer interactions',
  },
  {
    id: 'handoffs',
    group: 'Operate',
    label: 'Human handoffs',
    to: () => '/handoffs',
    icon: Headset,
    match: (p) => p.startsWith('/handoffs') || p.startsWith('/inbox'),
    hint: 'Help customers who need a human',
  },
  {
    id: 'knowledge',
    group: 'Improve',
    label: 'Knowledge base',
    to: () => '/knowledge',
    icon: BookOpen,
    match: (p) => p.startsWith('/knowledge'),
    hint: 'Manage the policies Ava uses to answer customers',
  },
  {
    id: 'learning',
    group: 'Improve',
    label: 'Learning & evaluation',
    to: () => '/learning',
    icon: GraduationCap,
    match: (p) =>
      p.startsWith('/learning') || p.startsWith('/evaluations') || p.startsWith('/tests'),
    hint: 'Review improvements and test them before publishing',
  },
  {
    id: 'evaluations',
    group: 'Improve',
    label: 'Test before publishing',
    to: () => '/evaluations',
    icon: FlaskConical,
    match: (p) => p.startsWith('/evaluations') || p.startsWith('/tests'),
    hint: 'Run customer scenarios and find failures',
  },
  {
    id: 'models',
    group: 'Manage',
    label: 'Models & releases',
    to: () => '/models',
    icon: PackageCheck,
    match: (p) => p.startsWith('/models'),
    hint: 'See what is active and safely roll back changes',
  },
  {
    id: 'settings',
    group: 'Settings',
    label: 'Settings',
    to: (t) => `/settings/${t}`,
    icon: Settings2,
    match: (p) => p.startsWith('/settings') || p.startsWith('/tenants') || p.startsWith('/clients'),
    hint: 'Manage companies, tools, rules and integrations',
  },
  {
    id: 'voice',
    group: 'Operate',
    label: 'Voice test',
    to: () => '/voice',
    icon: Mic,
    match: (p) => p.startsWith('/voice'),
    hint: 'Try Ava by voice in a safe test workspace',
  },
];
