import { useState } from 'react';
import type { StopReceipt, StopScope } from '../../shared/work-control';

interface StopMenuProps {
  /** True while this session still has a provider request that can be reached. */
  live: boolean;
  queuedCount: number;
  busy?: boolean;
  /** Today's Stop, unchanged: it ends the task's session and clears its queue. */
  onStopTask(): void;
  onStopScope(scope: Exclude<StopScope, 'task'>): void;
}

const SUBJECT: Record<StopScope, string> = {
  generation: 'the request',
  task: 'the task',
  queued: 'the queued follow-ups',
};

/**
 * Three Stops that mean different things, with the one everybody already knows
 * kept where it was and under its own word. The other two sit behind a small
 * menu and are offered only when they would do something.
 */
export function StopMenu({ live, queuedCount, busy, onStopTask, onStopScope }: StopMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <span className="stop-menu">
      <button type="button" disabled={busy} onClick={onStopTask}>
        Stop
      </button>{' '}
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        Stop options
      </button>
      {open && (
        <span className="stop-options" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={busy || !live}
            onClick={() => {
              setOpen(false);
              onStopScope('generation');
            }}
          >
            Stop this request
          </button>{' '}
          <button
            type="button"
            role="menuitem"
            disabled={busy || queuedCount === 0}
            onClick={() => {
              setOpen(false);
              onStopScope('queued');
            }}
          >
            Cancel queued follow-ups
          </button>
        </span>
      )}
    </span>
  );
}

/** What the last Stop on this task actually did. One line, in plain words. */
export function StopReceiptLine({ receipt }: { receipt: StopReceipt }) {
  const cancelled = receipt.cancelledFollowUpIds.length;
  return (
    <p className="caption stop-receipt">
      Stopped {SUBJECT[receipt.scope]}.{' '}
      {receipt.acknowledged ? 'It reached what was running.' : 'Nothing was running to reach.'}
      {cancelled
        ? ` ${cancelled} queued ${cancelled === 1 ? 'follow-up was' : 'follow-ups were'} cancelled.`
        : ''}
      {receipt.uncertainEffects.map((sentence) => ` ${sentence}`).join('')}
    </p>
  );
}
