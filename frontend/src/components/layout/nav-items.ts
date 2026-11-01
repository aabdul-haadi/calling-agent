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
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { VisualKey } from '@/components/visual/assets';

export interface NavItem {
  id: string;
  label: string;
  /** Builds the link for the selected tenant. */
  to: (tenantId: string) => string;
  icon: LucideIcon;
  /** The 3D picture shown in the sidebar (the line icon stays for the command palette). */
  asset: VisualKey;
  /** Matches the current path (also handles old URLs that now redirect). */
  match: (path: string) => boolean;
  hint: string;
  /** Sidebar section. */
  group: NavGroup;
  /** Navigation visibility only; the backend independently enforces this permission. */
  permission: string;
}

export type NavGroup =
  | 'Overview'
  | 'Support workspace'
  | 'Knowledge'
  | 'Learning lab'
  | 'AI studio'
  | 'Releases'
  | 'Administration';
export const NAV_GROUPS: NavGroup[] = [
  'Overview',
  'Support workspace',
  'Knowledge',
  'Learning lab',
  'AI studio',
  'Releases',
  'Administration',
];

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'overview',
    group: 'Overview',
    label: 'Overview',
    to: () => '/',
    icon: LayoutDashboard,
    asset: 'health',
    match: (p) => p === '/',
    hint: 'Live state of the platform',
    permission: 'platform:read',
  },
  {
    id: 'console',
    group: 'Support workspace',
    label: 'Support workspace',
    to: (t) => `/agent/${t}`,
    icon: Bot,
    asset: 'console',
    match: (p) => p.startsWith('/agent'),
    hint: 'Try chat or voice and inspect the current conversation',
    permission: 'support:operate',
  },
  {
    id: 'conversations',
    group: 'Support workspace',
    label: 'Conversation history',
    to: () => '/conversations',
    icon: Activity,
    asset: 'conversations',
    match: (p) => p.startsWith('/conversations'),
    hint: 'Find previous customer interactions',
    permission: 'support:read',
  },
  {
    id: 'handoffs',
    group: 'Support workspace',
    label: 'Human handoffs',
    to: () => '/handoffs',
    icon: Headset,
    asset: 'handoffs',
    match: (p) => p.startsWith('/handoffs') || p.startsWith('/inbox'),
    hint: 'Help customers who need a human',
    permission: 'support:handoff',
  },
  {
    id: 'knowledge',
    group: 'Knowledge',
    label: 'Policy documents',
    to: () => '/knowledge',
    icon: BookOpen,
    asset: 'knowledge',
    match: (p) => p.startsWith('/knowledge'),
    hint: 'Manage the policies Ava uses to answer customers',
    permission: 'knowledge:read',
  },
  {
    id: 'learning',
    group: 'Learning lab',
    label: 'Review & improve',
    to: () => '/learning',
    icon: GraduationCap,
    asset: 'learning',
    match: (p) => p.startsWith('/learning'),
    hint: 'Review examples and measure quality before publishing',
    permission: 'learning:read',
  },
  {
    id: 'evaluations',
    group: 'AI studio',
    label: 'Agent evaluations',
    to: () => '/evaluations',
    icon: FlaskConical,
    asset: 'quality',
    match: (p) => p.startsWith('/evaluations') || p.startsWith('/tests'),
    hint: 'Run customer scenarios and inspect failures',
    permission: 'evaluations:read',
  },
  {
    id: 'traces',
    group: 'AI studio',
    label: 'Traces & diagnostics',
    to: () => '/traces',
    icon: Waypoints,
    asset: 'traces',
    match: (p) => p.startsWith('/traces'),
    hint: 'Inspect agent decisions, tools, and response timing',
    permission: 'diagnostics:read',
  },
  {
    id: 'voice',
    group: 'AI studio',
    label: 'Voice lab',
    to: () => '/voice',
    icon: Mic,
    asset: 'voice',
    match: (p) => p.startsWith('/voice'),
    hint: 'Test the voice gateway and speech experience',
    permission: 'support:operate',
  },
  {
    id: 'architecture',
    group: 'AI studio',
    label: 'System guide',
    to: () => '/architecture',
    icon: Workflow,
    asset: 'architecture',
    match: (p) => p.startsWith('/architecture') || p.startsWith('/about'),
    hint: 'Understand how the platform components work together',
    permission: 'platform:read',
  },
  {
    id: 'models',
    group: 'Releases',
    label: 'Model candidates',
    to: () => '/models',
    icon: PackageCheck,
    asset: 'models',
    match: (p) => p.startsWith('/models'),
    hint: 'Compare candidates and review release status',
    permission: 'releases:read',
  },
  {
    id: 'settings',
    group: 'Administration',
    label: 'Company configuration',
    to: (t) => `/settings/${t}`,
    icon: Settings2,
    asset: 'settings',
    match: (p) => p.startsWith('/settings') || p.startsWith('/tenants') || p.startsWith('/clients'),
    hint: 'Configure company policies, tools, and integrations',
    permission: 'ai:configure',
  },
];
