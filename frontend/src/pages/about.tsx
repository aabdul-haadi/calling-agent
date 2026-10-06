import {
  ArrowDown,
  Bot,
  Brain,
  FlaskConical,
  Headset,
  Layers,
  Lock,
  Search,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section aria-labelledby={id} className="space-y-3">
    <h2 id={id} className="text-xl font-semibold tracking-tight">
      {title}
    </h2>
    {children}
  </section>
);

const problems = [
  {
    title: 'A chatbot that only talks is useless',
    body: 'Customers do not want advice, they want the booking changed or the bill explained. That needs a safe connection to real company systems.',
  },
  {
    title: 'An agent that can act is dangerous',
    body: 'A model can be tricked, can invent policy, or can rebook twice. Every action needs rules the model cannot talk its way around.',
  },
  {
    title: 'Every company wants it different',
    body: 'Rebuilding the agent for each client is slow. The tools, tone, rules, policies and handoff triggers must live in configuration, not in the engine.',
  },
  {
    title: 'Nobody can tell if it still works',
    body: 'Prompts and models change. Without repeatable scenario tests you only find regressions when a customer complains.',
  },
];

const flow = [
  {
    icon: Brain,
    title: '1. Understand',
    body: 'The message is classified: intent, tone (neutral, frustrated, angry) and whether the customer wants a human.',
  },
  {
    icon: Headset,
    title: '2. Pre-turn handoff check',
    body: 'If the customer asked for a person, is angry, or the topic is always-escalate (for example lost baggage), the conversation goes to a human now.',
  },
  {
    icon: Search,
    title: '3. Retrieve policy (RAG)',
    body: 'The five most relevant policy excerpts are found. If a policy question has no relevant excerpt the agent says "I am not sure" and offers a human, instead of guessing.',
  },
  {
    icon: Bot,
    title: '4. Reason with the model',
    body: 'The model gets the rules, the facts gathered so far, the excerpts and the allowed tools. It may call tools, up to six times per turn.',
  },
  {
    icon: Lock,
    title: '5. Dispatch every tool call',
    body: 'One gate checks the tool is allowed, the input matches its schema, the customer is verified and the company rules pass. Only then is the real API called.',
  },
  {
    icon: Wrench,
    title: '6. Call the company system',
    body: 'Token cached, timeout set, retries only where safe, an idempotency key on writes, and the response validated before it is trusted.',
  },
  {
    icon: Headset,
    title: '7. Post-turn handoff check',
    body: 'Loop guard, two "service unavailable" results, repeated failures or an AI outage trigger a signed webhook to the human contact centre with a masked summary.',
  },
];

const layers = [
  ['Routes', 'HTTP, input validation, a { data } or { error } envelope'],
  ['Chat service', 'Loads and saves each conversation, one turn at a time per conversation'],
  [
    'Agent loop',
    'Classify, retrieve, call the model, dispatch tools, check handoff, record a trace',
  ],
  ['Dispatcher', 'The only door to tools: allow-list, zod validation, auth gate, company rules'],
  [
    'Tools and API client',
    'OAuth token cache, timeouts, safe retries, idempotency keys, response validation',
  ],
  ['Knowledge', 'Markdown policies split by heading, embedded, searched in Postgres with pgvector'],
  [
    'Handoff',
    'HMAC-signed webhook with a timestamp, replay protection and duplicate-event ignoring',
  ],
  [
    'Evals',
    'YAML scenarios, deterministic checks plus an LLM judge, results stored and shown in the UI',
  ],
];

const guardrails = [
  'Customer text is treated as data, never as instructions (prompt-injection resistance).',
  'Rebooking needs a verified customer, options shown in an earlier message, and an explicit "yes" before the change.',
  'The same request twice never books twice: writes carry an idempotency key.',
  'Policy answers must cite a source and quote exact numbers, or say "I am not sure".',
  'Logs and handoff summaries mask booking references, names, emails and phone numbers.',
  'If the AI model is down, the customer gets a safe message and a human handoff, not an error page.',
];

const stack = [
  ['Language', 'TypeScript everywhere, strict mode, no any'],
  ['Backend', 'Node, Express 5, zod 4 validation, pino logging with PII masking'],
  [
    'Database',
    'Postgres with pgvector via Drizzle ORM. Docker, a hosted database (Supabase), or a zero-install local PGlite folder',
  ],
  [
    'AI',
    'Anthropic or any OpenAI-compatible API (Groq, OpenRouter, Ollama). Local hash embeddings need no key',
  ],
  [
    'Frontend',
    'React 19, Vite, Tailwind with light/dark themes, accessible by default (axe and WCAG contrast tests)',
  ],
  ['Voice', 'Browser speech recognition and synthesis with barge-in, same agent behind it'],
  ['Testing', 'Vitest unit and integration tests, plus YAML scenario evals against the real model'],
  [
    'Monorepo',
    'pnpm workspaces: frontend, backend, mock-services, shared types, per-client folders',
  ],
];

const screens: { to: string; name: string; what: string }[] = [
  { to: '/', name: 'Agents', what: 'Pick a company and open its agent.' },
  {
    to: '/agent/skylink-air',
    name: 'Agent console',
    what: 'Chat or talk, with a live trace of every step, tool call and cited source.',
  },
  {
    to: '/inbox',
    name: 'Handoff inbox',
    what: 'Conversations the agent escalated, with the reason and a masked summary.',
  },
  {
    to: '/tests',
    name: 'Test dashboard',
    what: 'Run the scenario suite and see pass/fail with the judge reason.',
  },
  {
    to: '/clients/skylink-air',
    name: 'Config viewer',
    what: 'The persona, scope, tools, rules and triggers that define a client.',
  },
];

export function AboutPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-10 pb-8">
      <header className="space-y-3">
        <Badge tone="accent">About</Badge>
        <h1 className="text-3xl font-semibold tracking-tight">
          Agent Delivery Kit: one engine, many support agents
        </h1>
        <p className="text-muted-foreground">
          A config-driven platform that turns a company's policies, tools and rules into a customer
          support agent that can actually do things, stays inside its limits, hands over to a human
          when it should, and can be tested before it meets a customer.
        </p>
      </header>

      <Section id="problem" title="The problem it solves">
        <div className="grid gap-3 sm:grid-cols-2">
          {problems.map((p) => (
            <Card key={p.title} className="p-4">
              <h3 className="font-medium">{p.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{p.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="solution" title="The approach">
        <p className="text-sm text-muted-foreground">
          The engine is written once. Each client is a folder with a config file (persona, scope,
          rules, handoff triggers), its tool files, its policy documents and its test scenarios.
          Adding a company means adding a folder, not changing the engine. Two fictional clients
          prove it: <strong>SkyLink Air</strong> (airline, chat and voice) and{' '}
          <strong>NovaTel</strong> (telecom, chat). Their company systems are simulated by mock
          APIs, so the whole thing runs on one laptop.
        </p>
      </Section>

      <Section id="flow" title="What happens when a customer sends a message">
        <ol className="space-y-2">
          {flow.map(({ icon: Icon, title, body }, i) => (
            <li key={title}>
              <Card className="flex gap-3 p-4">
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground"
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <h3 className="font-medium">{title}</h3>
                  <p className="text-sm text-muted-foreground">{body}</p>
                </div>
              </Card>
              {i < flow.length - 1 && (
                <ArrowDown
                  aria-hidden="true"
                  className="mx-auto my-1 h-4 w-4 text-muted-foreground"
                />
              )}
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">
          Finally the reply, the full trace (every step with timing), the updated state and the
          citations go back to the customer and are saved with the conversation.
        </p>
      </Section>

      <Section id="example" title="Example: a cancelled flight">
        <Card className="space-y-2 p-4 text-sm">
          <p>
            <strong>Customer:</strong> My flight was cancelled.
          </p>
          <p className="text-muted-foreground">
            Agent asks for the booking reference and last name, verifies them, reads the booking,
            searches alternatives and lists the options with times and seats.
          </p>
          <p>
            <strong>Customer:</strong> The first one, please.
          </p>
          <p className="text-muted-foreground">
            Agent restates exactly what will change and waits for a clear "yes". Only a later
            confirmed message makes the rebooking call, with an idempotency key so a repeat cannot
            double-book. If the booking system is down twice, a human takes over.
          </p>
        </Card>
      </Section>

      <Section id="layers" title="Architecture, layer by layer">
        <Card className="divide-y divide-border">
          {layers.map(([name, what]) => (
            <div key={name} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
              <div className="flex items-center gap-2 sm:w-44 sm:shrink-0">
                <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">{name}</span>
              </div>
              <p className="text-sm text-muted-foreground">{what}</p>
            </div>
          ))}
        </Card>
      </Section>

      <Section id="guardrails" title="Safety and reliability">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {guardrails.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </Section>

      <Section id="handoff" title="Human handoff">
        <p className="text-sm text-muted-foreground">
          A handoff is a signed webhook (HMAC SHA-256 over timestamp and body, compared in constant
          time, rejected if old, ignored if the event id repeats) sent to the company's contact
          centre. It carries the reason and a summary with personal data masked. The same record
          appears in the Handoff inbox so you can see what a human agent would receive.
        </p>
      </Section>

      <Section id="evals" title="Testing the agent, not just the code">
        <Card className="flex gap-3 p-4">
          <FlaskConical
            className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">
            Each scenario is a scripted conversation with hard checks (right tools in order,
            forbidden tools must not succeed, forbidden phrases, handoff expected or not) and an LLM
            judge for tone and accuracy. SkyLink's 20 scenarios scored 12/20 on the first run
            against a real model and 17/20 after fixing test data, prompts and retrieval. Free-tier
            models vary run to run, so treat the score as a trend, not a guarantee.
          </p>
        </Card>
      </Section>

      <Section id="stack" title="Technology">
        <Card className="divide-y divide-border">
          {stack.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
              <span className="font-medium sm:w-44 sm:shrink-0">{k}</span>
              <span className="text-sm text-muted-foreground">{v}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section id="screens" title="Where to find things in this app">
        <ul className="space-y-2">
          {screens.map(({ to, name, what }) => (
            <li key={to} className="text-sm">
              <Link to={to} className="font-medium underline underline-offset-2">
                {name}
              </Link>
              <span className="text-muted-foreground"> — {what}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="limits" title="Honest limits">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Company systems are mocks. A real client needs real API access and approval.</li>
          <li>
            Local embeddings are simple hashes; a hosted embedding model would retrieve better.
          </li>
          <li>The judge is also an LLM and can be wrong, so failures show its reason.</li>
          <li>Voice depends on the browser's speech support and works best in Chrome or Edge.</li>
          <li>There is no login yet: this is a demo and engineering kit, not a hosted product.</li>
        </ul>
      </Section>
    </div>
  );
}
