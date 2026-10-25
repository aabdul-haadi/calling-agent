import { seconds, useResponseTimer } from '@/hooks/use-response-timer';
import { Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Citation, PendingApprovalView } from '@adk/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { UiMessage } from '@/hooks/use-chat';
import { ApprovalCard } from './approval-card';
import { CitationText } from './citation-text';

function Bubble({
  message,
  agentName,
  citations,
}: {
  message: UiMessage;
  agentName: string;
  citations: Citation[];
}) {
  const mine = message.role === 'user';
  const human = message.role === 'human';
  return (
    <li className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] whitespace-pre-wrap rounded-xl px-4 py-2.5 text-[0.9375rem] leading-relaxed',
          mine && 'rounded-br-md bg-accent text-accent-foreground',
          human && 'rounded-bl-md border border-accent-2/30 bg-accent-2/[0.07]',
          !mine && !human && 'rounded-bl-md bg-muted',
        )}
      >
        {human && (
          <span className="mb-0.5 block text-xs font-semibold text-accent-2">Human colleague</span>
        )}
        <span className="sr-only">
          {mine ? 'You: ' : human ? 'Human colleague: ' : `${agentName}: `}
        </span>
        {mine || human ? (
          message.content
        ) : (
          <CitationText text={message.content} citations={citations} />
        )}
      </div>
    </li>
  );
}

export function TypingIndicator({ name }: { name: string }) {
  return (
    <li className="flex justify-start" aria-label={`${name} is thinking`}>
      <div className="flex items-center gap-1.5 rounded-xl rounded-bl-md bg-muted px-4 py-3.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
    </li>
  );
}

export interface ChatPanelProps {
  agentName: string;
  messages: UiMessage[];
  sending: boolean;
  error?: string;
  starterPrompts: string[];
  citations: Citation[];
  pendingApproval?: PendingApprovalView;
  handedOff?: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  /** Extra controls (voice toggle) rendered next to the send button. */
  inputAddon?: React.ReactNode;
  className?: string;
}

export function ChatPanel({
  agentName,
  messages,
  sending,
  error,
  starterPrompts,
  citations,
  pendingApproval,
  handedOff,
  disabled,
  onSend,
  inputAddon,
  className,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const timer = useResponseTimer(sending ? 'thinking' : 'done', 'done');
  const bottom = useRef<HTMLLIElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [messages.length, sending, pendingApproval]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || sending || disabled) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <Card className={cn('flex min-h-[26rem] flex-col overflow-hidden', className)}>
      <ol
        aria-label="Conversation"
        aria-live="polite"
        className="flex-1 space-y-3 overflow-y-auto px-5 py-5"
      >
        {messages.length === 0 && (
          <li className="mx-auto max-w-lg py-8 text-center">
            <p className="text-lg font-semibold">Hi, I'm {agentName}. How can I help?</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start with a common request, or type your own below.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {starterPrompts.map((p) => (
                <Button
                  key={p}
                  variant="outline"
                  size="sm"
                  onClick={() => onSend(p)}
                  disabled={sending || disabled}
                >
                  {p}
                </Button>
              ))}
            </div>
          </li>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} agentName={agentName} citations={citations} />
        ))}
        {sending && <TypingIndicator name={agentName} />}
        <li ref={bottom} aria-hidden="true" />
      </ol>
      {(sending || timer.liveMs !== undefined) && (
        <p
          role="timer"
          aria-label="Agent response time"
          className="px-4 pb-1 text-xs tabular-nums text-muted-foreground"
        >
          {sending ? 'Thinking' : 'Answered in'}{' '}
          <span className="font-mono font-medium">{seconds(timer.liveMs ?? 0)}</span>
        </p>
      )}
      {handedOff && (
        <p
          role="status"
          className="mx-3 mb-2 rounded-md border border-accent-2/40 bg-accent-2/10 px-3 py-2 text-sm"
        >
          This conversation was handed to a human colleague. Their replies appear here.
        </p>
      )}
      {pendingApproval && !handedOff && (
        <ApprovalCard
          approval={pendingApproval}
          disabled={sending}
          onApprove={() => onSend('Yes, please go ahead.')}
          onDecline={() => onSend('No, please leave it as it is.')}
        />
      )}
      {error && (
        <p role="alert" className="mx-3 mb-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="flex gap-2 border-t border-border bg-elevated p-3 sm:px-4">
        <label htmlFor="chat-input" className="sr-only">
          Message to {agentName}
        </label>
        <input
          id="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type your message…"
          maxLength={2000}
          autoComplete="off"
          disabled={disabled}
          className="h-10 min-w-0 flex-1 rounded-md border border-border bg-card px-3 text-[0.9375rem] shadow-soft placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
        {inputAddon}
        <Button
          type="submit"
          size="icon"
          disabled={!draft.trim() || sending || disabled}
          aria-label="Send message"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </Button>
      </form>
    </Card>
  );
}
