import { Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { UiMessage } from '@/hooks/use-chat';

function Bubble({ message, agentName }: { message: UiMessage; agentName: string }) {
  const mine = message.role === 'user';
  return (
    <li className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          mine ? 'rounded-br-md bg-accent text-accent-foreground' : 'rounded-bl-md bg-muted',
        )}
      >
        <span className="sr-only">{mine ? 'You: ' : `${agentName}: `}</span>
        {message.content}
      </div>
    </li>
  );
}

export function TypingIndicator({ name }: { name: string }) {
  return (
    <li className="flex justify-start" aria-label={`${name} is typing`}>
      <div className="flex gap-1 rounded-2xl rounded-bl-md bg-muted px-4 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-2 w-2 rounded-full bg-muted-foreground motion-safe:animate-bounce"
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
  disabled?: boolean;
  onSend: (text: string) => void;
}

export function ChatPanel({ agentName, messages, sending, error, starterPrompts, disabled, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLLIElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [messages.length, sending]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || sending || disabled) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <Card className="flex h-[32rem] flex-col lg:h-[calc(100vh-11rem)]">
      <ol aria-label="Conversation" aria-live="polite" className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <li className="py-6 text-center">
            <p className="font-medium">Hi, I'm {agentName}. How can I help?</p>
            <p className="mt-1 text-sm text-muted-foreground">Try one of these to get started:</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {starterPrompts.map((p) => (
                <Button key={p} variant="outline" size="sm" onClick={() => onSend(p)} disabled={sending || disabled}>
                  {p}
                </Button>
              ))}
            </div>
          </li>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} agentName={agentName} />
        ))}
        {sending && <TypingIndicator name={agentName} />}
        <li ref={bottom} aria-hidden="true" />
      </ol>
      {error && (
        <p role="alert" className="mx-4 mb-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
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
          className="h-10 flex-1 rounded-xl border border-border bg-background px-3 text-sm"
        />
        <Button type="submit" size="icon" disabled={!draft.trim() || sending || disabled} aria-label="Send message">
          <Send className="h-4 w-4" aria-hidden="true" />
        </Button>
      </form>
    </Card>
  );
}
