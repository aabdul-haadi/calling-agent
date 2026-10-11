import { Check, ShieldQuestion, X } from 'lucide-react';
import type { PendingApprovalView } from '@adk/shared';
import { Button } from '@/components/ui/button';
import { formatTime } from '@/lib/utils';

/**
 * Shown while the server is waiting for the customer's yes. The buttons just send the customer's
 * reply as a normal chat message: approval is decided by the server from that message, so this
 * card can ask for a decision but cannot grant one.
 */
export function ApprovalCard({
  approval,
  disabled,
  onApprove,
  onDecline,
}: {
  approval: PendingApprovalView;
  disabled?: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return (
    <section
      aria-label="Approval needed"
      className="mx-3 mb-2 rounded-md border border-warn/40 bg-warn/10 p-3"
    >
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Approve this change?</p>
          <p className="mt-0.5 text-sm text-foreground/90">{approval.summary}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing is changed until you approve. Offer expires at{' '}
            <time dateTime={approval.expiresAt}>{formatTime(approval.expiresAt)}</time>.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" onClick={onApprove} disabled={disabled}>
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> Yes, go ahead
            </Button>
            <Button size="sm" variant="outline" onClick={onDecline} disabled={disabled}>
              <X className="h-3.5 w-3.5" aria-hidden="true" /> No, leave it
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
