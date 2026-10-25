import {
  Brain,
  BookOpen,
  Database,
  Headset,
  Lock,
  ScrollText,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';

interface Stage {
  id: string;
  icon: LucideIcon;
  title: string;
  short: string;
  body: string;
  enforcedBy: 'code' | 'model' | 'mixed';
  where: string;
}

/** The turn lifecycle, in the order the engine runs it (backend/src/agent/loop.ts). */
const STAGES: Stage[] = [
  {
    id: 'understand',
    icon: Brain,
    title: 'Understand',
    short: 'Intent · tone · yes/no',
    body: 'One small model call classifies the message: intent, tone, whether the customer wants a person, whether it is a policy question and, only while a change is pending, whether they said yes or no to it. A failure falls back to "neutral", never blocks the chat.',
    enforcedBy: 'model',
    where: 'agent/classify.ts',
  },
  {
    id: 'settle',
    icon: Lock,
    title: 'Settle approval',
    short: 'Before the model runs',
    body: "If a change is waiting for approval, the customer's own message decides it now: yes approves, no rejects, anything else leaves it pending. A proposal expires after ten minutes, and an approval that was not used in its turn is discarded. The agent model has not run yet, so nothing it says, and no document it reads, can approve a change.",
    enforcedBy: 'code',
    where: 'agent/approval.ts',
  },
  {
    id: 'handoff-pre',
    icon: Headset,
    title: 'Handoff check',
    short: 'Ask · anger · always-escalate',
    body: 'If the customer asked for a person, is angry, or the intent is configured as always-escalate (for example lost baggage), the conversation goes to a human before any tool is tried.',
    enforcedBy: 'code',
    where: 'handoff/triggers.ts',
  },
  {
    id: 'retrieve',
    icon: BookOpen,
    title: 'Retrieve policy',
    short: 'Top 5 excerpts · cited',
    body: 'The five most relevant policy excerpts are found with vector search. If a policy question has no relevant excerpt, the engine answers "I am not sure" and offers a human instead of letting the model improvise.',
    enforcedBy: 'mixed',
    where: 'knowledge/retrieve.ts',
  },
  {
    id: 'model',
    icon: Brain,
    title: 'Model loop',
    short: 'At most 6 steps',
    body: 'The model gets the rules, the facts gathered so far, the excerpts and only the tools this tenant allows. It may call tools up to six times per message; a seventh attempt stops the turn and hands off.',
    enforcedBy: 'model',
    where: 'agent/loop.ts',
  },
  {
    id: 'dispatch',
    icon: ShieldCheck,
    title: 'Dispatch',
    short: 'One door for every tool',
    body: "Every tool call passes the allow-list, schema validation, the verification gate and the tenant's business rules. A tool that changes something only proposes at first; it runs once an approved proposal matches the live record exactly.",
    enforcedBy: 'code',
    where: 'tools/dispatcher',
  },
  {
    id: 'system',
    icon: Wrench,
    title: 'Company system',
    short: 'Timeouts · retries · keys',
    body: "OAuth tokens are cached, requests time out, only safe requests are retried (writes only with an idempotency key), and every response is validated before it is trusted. If a write's answer is lost, the tool reads the record back before reporting failure.",
    enforcedBy: 'code',
    where: 'tools/http',
  },
  {
    id: 'post',
    icon: Headset,
    title: 'Post-turn checks',
    short: 'Loop guard · outages',
    body: 'Two "service unavailable" results in a row, repeated failed turns, an AI outage or hitting the step limit trigger a signed webhook to the contact centre with a masked summary.',
    enforcedBy: 'code',
    where: 'handoff/webhook.ts',
  },
  {
    id: 'persist',
    icon: Database,
    title: 'Persist',
    short: 'Messages · trace · audit',
    body: 'Messages, tool calls, the step-by-step trace and the audit log are saved with the conversation state, with personal data masked first.',
    enforcedBy: 'code',
    where: 'database/repositories',
  },
];

const ENFORCER = {
  code: { label: 'Enforced in code', tone: 'ok' },
  model: { label: 'Done by the model', tone: 'warn' },
  mixed: { label: 'Code gate + model', tone: 'accent' },
} as const;

const PHASES = [
  'NEW',
  'VERIFYING',
  'VERIFIED',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'COMPLETED',
] as const;

const PRINCIPLES: [string, string][] = [
  [
    'A prompt is not a boundary',
    'Authorization, approval, tool permissions and business rules are checked by code the model cannot talk its way past.',
  ],
  [
    'Approval is bound to the exact change',
    'The customer agrees to one specific change. A different flight, or a record that changed since, needs a new yes.',
  ],
  [
    'Untrusted by default',
    'Customer text, retrieved documents and tool results are treated as data, never as instructions.',
  ],
  [
    'Idempotent writes',
    'The same request twice cannot book twice: writes carry an idempotency key, and a lost response is reconciled.',
  ],
  [
    'Masked at the source',
    'Booking references, names, e-mail and phone numbers are masked before logs, traces and handoff summaries are stored.',
  ],
  [
    'Signed handoffs',
    'The contact-centre webhook is HMAC-signed over timestamp and body, compared in constant time, rejected if old, and ignored if replayed.',
  ],
  [
    'Every decision is recorded',
    'Proposals, approvals, rejections, expiries, changes and reconciliations go to an append-only audit log.',
  ],
];

const STACK: [string, string][] = [
  ['Language', 'TypeScript everywhere (strict, no any), pnpm workspaces'],
  ['Backend', 'Node, Express 5, zod 4, pino with PII masking'],
  ['Data', 'Postgres + pgvector via Drizzle, or a zero-install local PGlite folder'],
  [
    'AI',
    'Anthropic or any OpenAI-compatible API (Groq, OpenRouter, Ollama); local hash embeddings need no key',
  ],
  ['Frontend', 'React 19, Vite, Tailwind, React Three Fiber for the agent visual (lazy-loaded)'],
  ['Voice', 'Browser speech recognition and synthesis, with barge-in'],
  [
    'Quality',
    'Vitest unit and integration tests, axe accessibility tests, YAML scenarios against the real model',
  ],
];

const LIMITS = [
  'Company systems are simulated mock APIs; a real tenant needs real API access.',
  'There is no login or user accounts. Do not expose this to the internet as is.',
  'Responses are not streamed; tool activity in the UI is shown right after each reply.',
  'Token usage and cost are not recorded yet.',
  'Configuration is read from files; there is no versioning, rollback or in-app editing.',
  "The yes/no reading of an approval is still done by a model, on the customer's message only.",
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function ArchitecturePage() {
  const [active, setActive] = useState(STAGES[1]!.id);
  const stage = STAGES.find((s) => s.id === active) ?? STAGES[0]!;
  const enforcer = ENFORCER[stage.enforcedBy];

  return (
    <div className="mx-auto max-w-5xl space-y-9 pb-8">
      <PageHeader
        eyebrow="Architecture"
        title="Architecture"
        description="A config-driven platform that turns a company's policies, tools and rules into a support agent that can act, stays inside its limits, hands over to a person when it should, and can be tested before it meets a customer."
      />

      <Section id="problem" title="The problem it solves">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            [
              'A chatbot that only talks is useless',
              'Customers want the booking changed or the bill explained, which needs a safe link to real systems.',
            ],
            [
              'An agent that can act is dangerous',
              'A model can be tricked, invent policy, or rebook twice. Every action needs rules it cannot bypass.',
            ],
            [
              'Every company wants it different',
              'Tools, tone, rules, policies and escalation live in configuration, so a new tenant is a folder, not a rewrite.',
            ],
            [
              'Nobody can tell if it still works',
              'Prompts and models change. Scenario tests find regressions before a customer does.',
            ],
          ].map(([t, b]) => (
            <Card key={t} className="p-4">
              <h3 className="font-medium">{t}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{b}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="lifecycle" title="What happens to every message">
        <p className="text-sm text-muted-foreground">
          Select a stage. The badge says whether the stage is enforced by deterministic code or
          depends on the model, which is the honest answer to “how do you control the agent?”.
        </p>
        <ol
          className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-9"
          aria-label="Turn lifecycle"
        >
          {STAGES.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setActive(s.id)}
                aria-pressed={active === s.id}
                className={cn(
                  'flex h-full w-full flex-col items-start gap-1 rounded-md border p-2.5 text-left transition-colors',
                  active === s.id
                    ? 'border-accent/60 bg-accent/10'
                    : 'border-border bg-card hover:border-accent/40 hover:bg-elevated',
                )}
              >
                <span className="flex w-full items-center justify-between">
                  <s.icon className="h-4 w-4 text-accent" aria-hidden="true" />
                  <span className="font-mono text-[0.65rem] text-muted-foreground">{i + 1}</span>
                </span>
                <span className="text-xs font-medium leading-tight">{s.title}</span>
                <span className="text-[0.65rem] leading-tight text-muted-foreground">
                  {s.short}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <Card className="space-y-2 p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{stage.title}</h3>
            <Badge tone={enforcer.tone}>{enforcer.label}</Badge>
            <code className="text-xs text-muted-foreground">{stage.where}</code>
          </div>
          <p className="text-sm leading-relaxed">{stage.body}</p>
        </Card>
      </Section>

      <Section id="phases" title="Conversation phases">
        <p className="text-sm text-muted-foreground">
          Only the engine moves a conversation between phases, along allowed edges. An event with no
          edge from the current phase is refused and recorded. Failed, cancelled and handoff paths
          also exist.
        </p>
        <ol className="flex flex-wrap items-center gap-1.5" aria-label="Phase sequence">
          {PHASES.map((p, i) => (
            <li key={p} className="flex items-center gap-1.5">
              <Badge
                tone={p === 'AWAITING_APPROVAL' ? 'warn' : p === 'COMPLETED' ? 'ok' : 'neutral'}
                className="font-mono"
              >
                {p.toLowerCase().replace(/_/g, ' ')}
              </Badge>
              {i < PHASES.length - 1 && (
                <span aria-hidden="true" className="text-muted-foreground">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </Section>

      <Section id="principles" title="Security principles">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PRINCIPLES.map(([t, b]) => (
            <li key={t}>
              <Card className="h-full p-4">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <ScrollText className="h-4 w-4 text-accent" aria-hidden="true" /> {t}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{b}</p>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="tenants" title="Tenants">
        <p className="text-sm text-muted-foreground">
          Two fictional tenants prove the engine is reusable: <strong>SkyLink Air</strong> (airline,
          chat and voice) and <strong>NovaTel</strong> (telecom, chat). Each is a folder with a
          config file, tool files, policy documents and test scenarios. See{' '}
          <Link to="/tenants" className="text-accent underline-offset-2 hover:underline">
            Tenants &amp; Config
          </Link>
          .
        </p>
      </Section>

      <Section id="stack" title="Technology">
        <Card className="divide-y divide-border">
          {STACK.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
              <span className="font-medium sm:w-32 sm:shrink-0">{k}</span>
              <span className="text-sm text-muted-foreground">{v}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section id="limits" title="Honest limits">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
