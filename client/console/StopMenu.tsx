import { useRef, useState, type KeyboardEvent } from 'react';
import {
  CONTROL_LABELS,
  type ControlCommand,
  type ControlReceipt,
  type RouteControlProfile,
  type StopReceipt,
  type StopScope,
} from '../../shared/work-control';
import type { Session, Task } from '../../shared/types';
import { controlNotApplicable } from '../../shared/session-controls';
import { routeDisplayName } from '../../shared/engines';
import { AGENT_NAME } from '../../shared/agent-name';
import { performControl, type ControlRequestBody } from '../api';
import { mintCommandId } from '../work-start';

interface StopMenuProps {
  /** True while this session still has a provider request that can be reached. */
  live: boolean;
  queuedCount: number;
  busy?: boolean;
  /** Today's Stop, unchanged: it ends the task's session and clears its queue. */
  onStopTask(): void;
  onStopScope(scope: Exclude<StopScope, 'task'>): void;
  /**
   * The scoped Stops this route can honour (H08). Absent keeps both, as before;
   * a scope the route cannot honour is not offered.
   */
  scopes?: readonly Exclude<StopScope, 'task'>[];
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
export function StopMenu({
  live,
  queuedCount,
  busy,
  onStopTask,
  onStopScope,
  scopes = ['generation', 'queued'],
}: StopMenuProps) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  // A menu is keyboard operable: arrows move between its items, Escape closes it
  // and puts focus back on the button that opened it.
  const onMenuKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };
  const offerRequest = scopes.includes('generation');
  const offerQueued = scopes.includes('queued');
  return (
    <span className="stop-menu">
      <button type="button" disabled={busy} onClick={onStopTask}>
        Stop
      </button>
      {(offerRequest || offerQueued) && (
        <>
          {' '}
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-haspopup="menu"
            disabled={busy}
            onClick={() => setOpen(!open)}
          >
            Stop options
          </button>
        </>
      )}
      {open && ' '}
      {open && (
        <span className="stop-options" role="menu" ref={menu} onKeyDown={onMenuKey}>
          {offerRequest && (
            <>
              <button
                type="button"
                role="menuitem"
                autoFocus
                disabled={busy || !live}
                onClick={() => {
                  setOpen(false);
                  onStopScope('generation');
                }}
              >
                Stop this request
              </button>{' '}
            </>
          )}
          {offerQueued && (
            <button
              type="button"
              role="menuitem"
              autoFocus={!offerRequest}
              disabled={busy || queuedCount === 0}
              onClick={() => {
                setOpen(false);
                onStopScope('queued');
              }}
            >
              Cancel queued follow-ups
            </button>
          )}
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

// --- H08: the run's controls in one place ------------------------------------------

type RunControl = Exclude<ControlCommand, 'steer' | 'queue'>;

interface RunControlsProps {
  projectId: string;
  task: Task;
  session: Session;
  /** What this run's route offers, read from the server. Null while it loads. */
  profile: RouteControlProfile | null;
  queuedCount: number;
  /** Resume and Retry belong to the task's latest run; older runs offer Fork alone. */
  latest: boolean;
  busy?: boolean;
  /** Today's Stop, kept for a run whose route answer has not arrived. */
  onStopTask(): void;
  onError?(error: Error): void;
}

const CONFIRM: Record<'resume' | 'retry', (route: string) => string> = {
  resume: (route) => `Continues this run on ${route} from where it stopped.`,
  retry: (route) => `Sends the same request to ${route} again, as a new attempt.`,
};

/**
 * Stop, Resume, Retry and Fork for one run, in the run's own record: the Stop
 * cluster while it runs, the rest once it has settled. Only what the route
 * offers appears (`workControlProfile`), and only where the run's state lets it
 * apply. Resume and Retry send work, so each asks once before it does; Stop and
 * Fork act on the press. Steer and Queue live with the follow-up box, because
 * both carry a message.
 */
export function RunControls({
  projectId,
  task,
  session,
  profile,
  queuedCount,
  latest,
  busy,
  onStopTask,
  onError,
}: RunControlsProps) {
  const [confirming, setConfirming] = useState<'resume' | 'retry' | null>(null);
  const [working, setWorking] = useState(false);
  const live = ['queued', 'working', 'waiting'].includes(session.state);
  const disabled = busy || working;
  async function send(body: ControlRequestBody) {
    setWorking(true);
    try {
      await performControl(projectId, body);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setWorking(false);
    }
  }
  const act = (control: RunControl, extra: Record<string, unknown> = {}) =>
    send({
      protocolVersion: 1,
      commandId: mintCommandId(),
      taskId: task.id,
      control,
      sessionId: session.id,
      ...extra,
    } as ControlRequestBody);
  if (live) {
    if (!profile)
      return (
        <StopMenu
          live
          queuedCount={queuedCount}
          busy={busy}
          onStopTask={onStopTask}
          onStopScope={() => undefined}
          scopes={[]}
        />
      );
    return (
      <StopMenu
        live={['queued', 'working'].includes(session.state)}
        queuedCount={queuedCount}
        busy={disabled}
        scopes={profile.stopScopes.filter(
          (scope): scope is 'generation' | 'queued' => scope !== 'task',
        )}
        onStopTask={() => void act('stop', { scope: 'task' })}
        onStopScope={(scope) => void act('stop', { scope })}
      />
    );
  }
  if (!profile) return null;
  const offered = (control: RunControl) =>
    profile.controls[control].support !== null &&
    controlNotApplicable(control, session.state) === null &&
    (control === 'fork' || latest);
  const shown = (['resume', 'retry', 'fork'] as const).filter(offered);
  if (!shown.length) return null;
  const routeName = routeDisplayName(profile.workRoute);
  return (
    <span className="run-controls">
      <span role="toolbar" aria-label="Run controls" className="run-control-bar">
        {shown.map((control) => (
          <button
            key={control}
            type="button"
            disabled={disabled}
            aria-expanded={control === 'fork' ? undefined : confirming === control}
            title={profile.controls[control].note}
            onClick={() =>
              control === 'fork'
                ? void act('fork')
                : setConfirming(confirming === control ? null : control)
            }
          >
            {CONTROL_LABELS[control]}
          </button>
        ))}
      </span>
      {confirming && (
        <span className="run-control-confirm" role="group" aria-label={`Confirm ${confirming}`}>
          <span className="caption">{CONFIRM[confirming](routeName)}</span>{' '}
          <button
            type="button"
            disabled={disabled}
            autoFocus
            onClick={() => {
              const control = confirming;
              setConfirming(null);
              void act(control);
            }}
          >
            {CONTROL_LABELS[confirming]} now
          </button>{' '}
          <button type="button" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </span>
      )}
    </span>
  );
}

const OUTCOME_WORDS: Record<ControlReceipt['outcome'], string> = {
  applied: 'done',
  queued: 'queued',
  refused: 'not done',
  uncertain: 'not confirmed',
};

/**
 * One control's receipt, in the thread's timeline: which control, what became of
 * it, what the route actually did, and who did it — Diomedes for what it
 * composed, the engine for what the route did itself.
 */
export function ControlReceiptLine({
  receipt,
  taskId,
  onOpenTask,
}: {
  receipt: ControlReceipt;
  /** The thread's own task, so a fork line links to the other side of the lineage. */
  taskId: string;
  onOpenTask?(taskId: string): void;
}) {
  const by =
    receipt.performedBy?.kind === 'engine'
      ? routeDisplayName(receipt.performedBy.engine)
      : receipt.performedBy
        ? AGENT_NAME
        : null;
  const other =
    receipt.control === 'fork' && receipt.outcome === 'applied'
      ? receipt.result.taskId === taskId
        ? receipt.lineage?.originTaskId
        : receipt.result.taskId
      : undefined;
  return (
    <div
      className={`control-receipt ${receipt.outcome}`}
      data-control={receipt.control}
      data-outcome={receipt.outcome}
    >
      <span className="control-receipt-head">
        <b>{CONTROL_LABELS[receipt.control]}</b>{' '}
        <span className="lc">{OUTCOME_WORDS[receipt.outcome]}</span>
        {receipt.requestedBy.actor === 'diomedes' && (
          <span className="lc"> · asked by {AGENT_NAME} supervision</span>
        )}
        {by && <span className="lc"> · by {by}</span>}
        <span className="mono"> · {new Date(receipt.requestedAt).toTimeString().slice(0, 5)}</span>
      </span>
      <span className="control-receipt-detail">{receipt.detail}</span>
      {receipt.uncertainEffects.map((effect) => (
        <span className="control-receipt-detail" key={effect}>
          {effect}
        </span>
      ))}
      {other && onOpenTask && (
        <button type="button" onClick={() => onOpenTask(other)}>
          {receipt.result.taskId === taskId ? 'Open the original' : 'Open the fork'}
        </button>
      )}
    </div>
  );
}
