import { ArrowRight, Bot, Headset, MessageSquare, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/ui/state-views';
import { useAsync } from '@/hooks/use-async';
import { api } from '@/services/api';

const steps = [
  { icon: MessageSquare, label: 'Customer', hint: 'asks in chat or voice' },
  { icon: Bot, label: 'Agent', hint: 'understands and decides' },
  { icon: Wrench, label: 'Tools', hint: 'checks company systems' },
  { icon: Headset, label: 'Human', hint: 'takes over when needed' },
];

export function HomePage() {
  const clients = useAsync(() => api.clients());
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Launch support agents for any company</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          One shared engine, one config folder per client. Pick a company to chat with its agent.
        </p>
      </section>

      <section aria-labelledby="clients-heading">
        <h2 id="clients-heading" className="sr-only">
          Clients
        </h2>
        {clients.loading ? (
          <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="Loading clients">
            <Skeleton className="h-44" />
            <Skeleton className="h-44" />
          </div>
        ) : clients.error ? (
          <ErrorState message={clients.error} onRetry={clients.reload} />
        ) : clients.data?.length === 0 ? (
          <EmptyState title="No clients yet" hint="Add a folder under clients/ and register it." />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {clients.data?.map((c) => (
              <li key={c.id} data-accent={c.accent}>
                <Card className="flex h-full flex-col gap-4 p-6">
                  <div className="flex items-center gap-4">
                    <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-lg font-bold text-accent-foreground">
                      {c.initials}
                    </span>
                    <div>
                      <h3 className="text-xl font-semibold">{c.displayName}</h3>
                      <p className="text-xs text-muted-foreground">{c.channels.join(' + ')}</p>
                    </div>
                  </div>
                  <p className="flex-1 text-sm text-muted-foreground">{c.tagline}</p>
                  <Link
                    to={`/agent/${c.id}`}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90"
                  >
                    Open agent <span className="sr-only">for {c.displayName}</span>
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                  <Link to={`/clients/${c.id}`} className="text-center text-sm underline underline-offset-2">
                    View config
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="how-heading">
        <h2 id="how-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          How it works
        </h2>
        <ol className="flex flex-wrap items-center gap-3">
          {steps.map(({ icon: Icon, label, hint }, i) => (
            <li key={label} className="flex items-center gap-3">
              <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
                <Icon className="h-5 w-5 text-accent" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
              </div>
              {i < steps.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
