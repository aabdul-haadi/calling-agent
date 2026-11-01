import { Link } from 'react-router-dom';
import type { ClientSummary } from '@adk/shared';
import { avatarFor } from '@/avatar/avatar-config';
import { cn } from '@/lib/utils';
import { VisualAsset } from './visual-asset';

/**
 * Who answers customers for one company. The portrait is the real 3D character, the status is the
 * real voice-engine status (`voiceReady` undefined while it is still being checked), and the two
 * links go straight to chatting or talking with that agent.
 */
export function AgentIdentityCard({
  client,
  selected,
  voiceReady,
  onSelect,
  onPreload,
}: {
  client: ClientSummary;
  selected: boolean;
  voiceReady?: boolean;
  /** Make this company the one every page is scoped to. */
  onSelect: (id: string) => void;
  onPreload?: (id: string) => void;
}) {
  const avatar = avatarFor(client.id);
  const name = avatar?.name ?? client.displayName;
  const hasVoice = client.channels.includes('voice');
  const preload = () => onPreload?.(client.id);
  return (
    <article
      aria-label={`${name}, agent for ${client.displayName}`}
      className={cn(
        'relative flex items-center gap-4 rounded-2xl bg-card p-4 shadow-soft',
        selected ? 'ring-2 ring-accent/40' : 'ring-1 ring-border/60',
      )}
    >
      {avatar ? (
        <img
          src={avatar.portraitUrl}
          alt={`${name}, the ${client.displayName} agent`}
          width={80}
          height={80}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-20 w-20 shrink-0 rounded-2xl object-cover shadow-soft"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-2xl font-semibold text-accent"
        >
          {client.initials}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-base font-semibold leading-tight">{name}</h3>
          <span className="text-sm text-muted-foreground">{client.displayName}</span>
          {selected && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[0.7rem] font-semibold text-accent">
              Selected
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{client.tagline}</p>
        <ul aria-label="Channels" className="mt-2 flex flex-wrap items-center gap-1.5">
          {client.channels.map((c) => (
            <li
              key={c}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
            >
              <VisualAsset asset={c === 'voice' ? 'voice' : 'chat'} size={16} />
              {c === 'voice' ? 'Voice' : 'Chat'}
            </li>
          ))}
          {hasVoice && voiceReady !== undefined && (
            <li
              className={cn(
                'inline-flex items-center gap-1.5 text-xs',
                voiceReady ? 'text-ok' : 'text-muted-foreground',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('h-1.5 w-1.5 rounded-full', voiceReady ? 'bg-ok' : 'bg-muted-foreground')}
              />
              {voiceReady ? 'Voice engine ready' : 'Voice engine not running'}
            </li>
          )}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            to={`/agent/${client.id}`}
            onClick={() => onSelect(client.id)}
            onPointerEnter={preload}
            onFocus={preload}
            className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:bg-accent/90"
          >
            Open workspace
          </Link>
          {hasVoice && (
            <Link
              to="/voice"
              onClick={() => onSelect(client.id)}
              onPointerEnter={preload}
              onFocus={preload}
              className="inline-flex h-8 items-center rounded-md bg-muted px-3 text-xs font-medium hover:bg-muted/70"
            >
              Talk to {name}
            </Link>
          )}
        </div>
        {avatar?.credit && (
          <p className="mt-2 text-xs text-muted-foreground">Portrait: {avatar.credit.text}</p>
        )}
      </div>
    </article>
  );
}
