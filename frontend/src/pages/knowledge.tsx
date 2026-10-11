import { BookOpen, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

export function KnowledgePage() {
  const { tenant } = useTenant();
  const docs = useAsync(
    () => (tenant ? api.knowledge(tenant.id) : Promise.resolve([])),
    [tenant?.id],
  );
  const chunks = docs.data?.reduce((n, d) => n + d.chunks, 0) ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Knowledge · ${tenant?.displayName ?? ''}`}
        title="What the agent is allowed to cite"
        description="The agent states company policy only from these documents, with a source on every claim. If nothing relevant is found it says it is not sure and offers a human."
        actions={
          docs.data && (
            <Badge tone="accent">
              {docs.data.length} documents · {chunks} chunks
            </Badge>
          )
        }
      />
      {docs.error ? (
        <ErrorState message={docs.error} onRetry={docs.reload} />
      ) : docs.loading ? (
        <div
          role="status"
          aria-label="Loading knowledge"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : !docs.data || docs.data.length === 0 ? (
        <EmptyState
          title="No documents indexed"
          hint="Policy files from the tenant's knowledge folder are indexed when the backend starts."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {docs.data.map((d) => (
            <li key={d.source}>
              <Card className="h-full space-y-3 p-4">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
                  >
                    <FileText className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate font-mono text-sm font-medium">{d.source}</h2>
                    <p className="text-xs text-muted-foreground">
                      {d.chunks} {d.chunks === 1 ? 'section' : 'sections'} ·{' '}
                      {d.characters.toLocaleString()} characters · indexed{' '}
                      {relativeTime(d.updatedAt)}
                    </p>
                  </div>
                </div>
                <ul className="flex flex-wrap gap-1.5" aria-label={`Sections in ${d.source}`}>
                  {d.headings.map((h) => (
                    <li key={h}>
                      <Badge>{h}</Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
        To see which excerpts a reply used, open the{' '}
        {tenant && (
          <Link to={`/agent/${tenant.id}`} className="underline">
            Agent Console
          </Link>
        )}{' '}
        and check the State tab. Document upload and versioning are not supported yet.
      </p>
    </div>
  );
}
