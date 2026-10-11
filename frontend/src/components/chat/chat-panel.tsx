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
  return (
    <li className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[88%] whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-sm leading-relaxed',
          mine
            ? 'rounded-br-sm bg-accent text-accent-foreground'
            : 'rounded-bl-sm border border-border bg-elevated',
        )}
      >
        <span className="sr-only">{mine ? 'You: ' : `${agentName}: `}</span>
        {mine ? message.content : <CitationText text={message.content} citations={citations} />}
      </div>
    </li>
  );
}

export function TypingIndicator({ name }: { name: string }) {
  return (
    <li className="flex justify-start" aria-label={`${name} is thinking`}>
      <div className="flex items-center gap-1.5 rounded-lg rounded-bl-sm border border-border bg-elevated px-4 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-bounce"
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
    <Card className={cn('flex min-h-[26rem] flex-col', className)}>
      <ol
        aria-label="Conversation"
        aria-live="polite"
        className="flex-1 space-y-3 overflow-y-auto p-4"
      >
        {messages.length === 0 && (
          <li className="py-6 text-center">
            <p className="font-medium">Hi, I'm {agentName}. How can I help?</p>
            <p className="mt-1 text-sm text-muted-foreground">Try one of these to get started:</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
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
      {handedOff && (
        <p
          role="status"
          className="mx-3 mb-2 rounded-md border border-accent-2/40 bg-accent-2/10 px-3 py-2 text-sm"
        >
          This conversation is with a human colleague now. See the Human Handoffs page.
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
      <form onSubmit={submit} className="flex gap-2 border-t border-border p-3">
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
          className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm placeholder:text-muted-foreground/70"
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
