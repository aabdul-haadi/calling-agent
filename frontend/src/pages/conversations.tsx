import { ArrowRight, MessageSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ConversationSummary } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

function tone(c: ConversationSummary): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (c.handedOff) return 'warn';
  if (c.awaitingApproval) return 'warn';
  if (c.phase === 'FAILED') return 'danger';
  if (c.phase === 'COMPLETED') return 'ok';
  return 'neutral';
}

function label(c: ConversationSummary) {
  if (c.handedOff) return 'Needs a human';
  if (c.awaitingApproval) return 'Waiting for approval';
  return c.phase.replace(/_/g, ' ').toLowerCase();
}

export function ConversationsPage() {
  const { tenant } = useTenant();
  const conversations = useAsync(() => api.conversations(tenant?.id, 50), [tenant?.id], 8000);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Conversations"
        title="Conversations"
        description="Find a customer interaction, see how Ava handled it, and open the full record when you need more detail."
        actions={
          tenant && (
            <Link
              to={`/agent/${tenant.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-soft hover:bg-accent/90"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              Start a conversation
            </Link>
          )
        }
      />
      {conversations.error ? (
        <ErrorState message={conversations.error} onRetry={conversations.reload} />
      ) : conversations.loading ? (
        <div role="status" aria-label="Loading conversations" className="grid gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : !conversations.data?.length ? (
        <EmptyState
          asset="chat"
          title="No conversations yet"
          hint="Start a chat or voice test from the Agent Workspace. Completed interactions will appear here."
          action={
            tenant ? (
              <Link className="text-sm text-accent underline" to={`/agent/${tenant.id}`}>
                Open Agent Workspace
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul aria-label="Customer conversations" className="divide-y divide-border">
              {conversations.data.map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    to={`/traces?c=${encodeURIComponent(conversation.id)}`}
                    className="flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-elevated"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{conversation.id}</span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {conversation.messageCount} messages · {relativeTime(conversation.updatedAt)}
                      </span>
                    </span>
                    <Badge tone={tone(conversation)}>{label(conversation)}</Badge>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
