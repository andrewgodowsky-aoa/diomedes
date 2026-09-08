import { Children, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  Change,
  Detail,
  IntegrationStatus,
  Mode,
  Need,
  Session,
  Settings,
  Surface,
  TaskState,
  UsageMeter,
  UsageSnapshot,
  UsageWindow,
} from '../shared/types';

export const pages = [
  'home',
  'ask',
  'plan',
  'work',
  'review',
  'tasks',
  'documents',
  'history',
] as const;
export const stateNames: Record<TaskState, string> = {
  todo: 'To do',
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
};
export const detailDescriptions = {
  guided: 'Plain words, fewer numbers, an explanation on everything that needs a decision.',
  standard: 'Plain words, plus counts, times and which kind of service did the work.',
  technical: 'Engines, models, logs, version ids, and developer tools where they apply.',
};
export const surfaceDescriptions = {
  workbook: 'One page at a time. Ask, plan, work and review, and Diomedes asks before anything that matters.',
  console: 'Every thread, every helper and every change on one screen. For people who work with these tools every day.',
};
export function surfaceOf(settings: Settings): Surface {
  return settings.surface === 'console' ||
    (settings.surface === undefined && settings.detail === 'technical')
    ? 'console'
    : 'workbook';
}
export function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function ModeChip({ mode, attempt }: { mode: Mode; attempt?: { n: number; of: number } }) {
  const label =
    attempt && mode === 'fix' ? `Fix, try ${attempt.n} of ${attempt.of}` : titleCase(mode);
  return (
    <span className="mode-chip" data-mode={mode}>
      {label}
    </span>
  );
}
export function time(s: string) {
  return new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function date(s: string) {
  return new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function Brand() {
  return (
    <span className="brand">
      <span>DIOMEDES</span>
    </span>
  );
}
export function Mark({ state = 'todo' }: { state?: string }) {
  return <span aria-hidden="true" className={`mark ${state}`} />;
}
export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    home: (
      <>
        <path d="M3 8l5-5 5 5v5H9v-3H7v3H3z" />
      </>
    ),
    ask: <path d="M2 3h12v8H6l-4 3zM5 6h6M5 8h4" />,
    plan: <path d="M4 2h6l3 3v9H4zM10 2v3h3M6 8h5M6 11h4" />,
    work: <path d="M3 3l10 5-10 5z" />,
    review: <path d="M2 8l4 4L14 3" />,
    tasks: <path d="M2 3h3v3H2zM8 4h6M2 10h3v3H2zM8 11h6" />,
    documents: <path d="M2 4h5l2 2h5v7H2zM2 4V2h5l2 2" />,
    history: <path d="M3 4a6 6 0 1 1-1 6M2 1v4h4M8 4v4l3 2" />,
    settings: (
      <>
        <path d="M2 4h12M2 12h12" />
        <path d="M5 2v4M11 10v4" />
      </>
    ),
    plus: <path d="M8 2v12M2 8h12" />,
    search: (
      <>
        <circle cx="7" cy="7" r="4" />
        <path d="M10 10l4 4" />
      </>
    ),
    close: <path d="M3 3l10 10M13 3L3 13" />,
    stop: <path d="M4 4h8v8H4z" fill="currentColor" />,
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {paths[name] ?? paths.documents}
    </svg>
  );
}
export function Button({
  children,
  tone = '',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: string }) {
  return (
    <button type="button" {...props} className={`button ${tone} ${className}`}>
      {children}
    </button>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-rule" />
      <h2>{title}</h2>
      {children && <div className="prose muted">{children}</div>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const el = ref.current;
    const focused = document.activeElement;
    el?.showModal();
    return () => {
      el?.close();
      if (focused instanceof HTMLElement) focused.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      className={`dialog ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={id}>{title}</h2>
        <Button tone="quiet icon-button" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function ApprovalStatus({ need }: { need: Need }) {
  if (!need.approval) return null;
  const receipt = need.approvalReceipt;
  if (!receipt)
    return <p className="caption">This OK covers only this proposal. Expires {new Date(need.approval.expiresAt).toLocaleString()}.</p>;
  const outcomes = {
    pending: 'Decision saved. Execution has not been confirmed.',
    applied: 'Approved changes applied. Their versions are in History.',
    conflicted: 'Outside edits preserved. Some approved changes may have applied; check History.',
    'not-applied': 'Decision saved, but the write was not prepared. Start new work for a new proposal.',
    declined: 'Proposal declined. No changes were applied.',
  };
  return (
    <div className="approval-status" aria-label="Approval record">
      <p className="caption">{need.execution ? outcomes[need.execution.state] : 'Decision saved. Execution has not been confirmed.'}</p>
      <details>
        <summary className="caption">Decision record</summary>
        <p className="caption">Recorded by the local service at {new Date(receipt.decidedAt).toLocaleString()}.</p>
        <dl className="facts code caption" style={{ overflowWrap: 'anywhere' }}>
          <dt>Request</dt><dd>{receipt.commandId}</dd>
          <dt>Proposal</dt><dd>{receipt.proposalDigest}</dd>
          <dt>Action</dt><dd>{receipt.actionDigest}</dd>
          <dt>Source versions</dt><dd>{receipt.baseDigest}</dd>
        </dl>
      </details>
    </div>
  );
}
export function Notice({
  need,
  decide,
  show,
}: {
  need: Need;
  decide: (resolution: 'go-ahead' | 'declined', allow?: boolean) => void;
  show: () => void;
}) {
  return (
    <section className="notice needs" aria-label="Needs your OK">
      <h3>
        <Mark state="waiting" />
        Needs your OK
      </h3>
      <p className="prose">
        Diomedes wants to {need.what}. {need.why} {need.consequence}
      </p>
      <div className="actions">
        <Button tone="signal" onClick={() => decide('go-ahead')}>
          Go ahead
        </Button>
        {!need.approval && <Button onClick={() => decide('go-ahead', true)}>Go ahead for this whole task</Button>}
        <Button onClick={() => decide('declined')}>Don't do this</Button>
        <Button tone="quiet" onClick={show}>
          Show me first
        </Button>
      </div>
      <p className="caption">Diomedes is paused until you decide.</p>
      <ApprovalStatus need={need} />
    </section>
  );
}
export function SessionStatus({
  session,
  detail,
  name,
  stop,
}: {
  session: Session;
  detail: Detail;
  name?: string;
  stop?: () => void;
}) {
  const label = {
    queued: 'Getting ready',
    working: 'Working',
    waiting: 'Waiting for your OK',
    done: 'Finished',
    stopped: 'Stopped',
    failed: 'Something went wrong',
  }[session.state];
  return (
    <div className="session-status">
      <Mark
        state={
          session.state === 'waiting'
            ? 'waiting'
            : session.state === 'failed'
              ? 'fault'
              : session.state === 'done'
                ? 'done'
                : 'working'
        }
      />
      <div>
        <strong>
          {label}
          {name ? ` on ${name}` : ''}.
        </strong>
        <span className="muted">
          {' '}
          {session.sample ? 'Sample work. ' : ''}Started at {time(session.startedAt)}.
        </span>
        {detail === 'technical' && (
          <div className="code caption">
            {session.engine.name}, {session.engine.model ?? 'no model'}, session {session.id},{' '}
            {session.engine.events} events
          </div>
        )}
      </div>
      {stop && ['queued', 'working', 'waiting'].includes(session.state) && (
        <Button className="push-right" onClick={stop}>
          <Icon name="stop" />
          Stop
        </Button>
      )}
    </div>
  );
}
export function askDraftKey(projectId: string) {
  return `diomedes.ask-draft.${projectId}`;
}

/** The window closest to empty: the highest percent used. */
export function tightestWindow(snapshot: UsageSnapshot): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const window of snapshot.windows)
    if (!best || window.usedPercent > best.usedPercent) best = window;
  return best;
}

/** Compact counts: 12400 becomes 12.4k. */
export function countK(value: number): string {
  if (value >= 1000) {
    const rounded = Math.round(value / 100) / 10;
    return `${rounded}k`;
  }
  return String(Math.round(value));
}

/** One line for a reported thread meter in the Workbook. */
export function meterLine(meter: UsageMeter): string {
  const written = `${countK(meter.output)} written`;
  const cost = meter.costUsd !== null ? `, $${meter.costUsd.toFixed(2)}` : '';
  if (meter.contextWindow !== null)
    return `Last thread: ${countK(meter.input)} of ${countK(meter.contextWindow)} context, ${written}${cost}`;
  return `Last thread: ${countK(meter.input)} words used, ${written}${cost}`;
}

/**
 * How much of the allowance is still there. The service reports what has been
 * spent; every bar in the app fills with what is left, so a full bar always
 * reads as good and an empty one as spent, and an engine with nothing left
 * looks the same as an engine that cannot run.
 */
export function leftPercent(window: UsageWindow) {
  return Math.round(Math.min(100, Math.max(0, 100 - window.usedPercent)));
}

export function UsageBar({ window }: { window: UsageWindow }) {
  const left = leftPercent(window);
  const tone = left <= 0 ? 'fault' : left < 20 ? 'signal' : '';
  const text = `${window.label}, ${left}% left`;
  return (
    <span className="usage-bar" role="img" aria-label={text} title={text}>
      <span className={`usage-fill ${tone}`.trim()} style={{ width: `${left}%` }} />
    </span>
  );
}

export function UsageChip({
  snapshot,
  name,
  onOpen,
}: {
  snapshot: UsageSnapshot;
  name: string;
  onOpen?: () => void;
}) {
  const tight = tightestWindow(snapshot);
  if (!tight) return null;
  const label = `${name}, ${tight.label}, ${leftPercent(tight)}% left`;
  const body = (
    <>
      <span>{label}</span>
      <UsageBar window={tight} />
    </>
  );
  if (!onOpen)
    return (
      <span className="usage-chip static" title={label}>
        {body}
      </span>
    );
  return (
    <button type="button" className="usage-chip" onClick={onOpen} title="Open Helpers settings">
      {body}
    </button>
  );
}

export function HelperLine({
  integrations,
  settings,
  saveSettings,
}: {
  integrations: IntegrationStatus[];
  settings: Settings;
  saveSettings: (s: Settings) => void | Promise<void>;
}) {
  const runnable = integrations.filter((i) => i.adapter === 'ready' && i.kind !== 'sample');
  const switchedOn = runnable.find((i) => i.available && settings.services?.[i.id]);
  const signedIn = runnable.find((i) => i.available);
  return (
    <p className="caption helper-line">
      {switchedOn ? (
        <span>
          {switchedOn.name} is on. {switchedOn.disclosure[0]}
        </span>
      ) : signedIn ? (
        <>
          <span>{signedIn.name} is signed in but turned off, so Diomedes uses sample work.</span>
          <button
            className="text-button"
            onClick={() =>
              void saveSettings({
                ...settings,
                services: { ...settings.services, [signedIn.id]: true },
              })
            }
          >
            Turn {signedIn.name} on
          </button>
          <span>{signedIn.disclosure[0]}</span>
        </>
      ) : (
        <span>Sample work, on this computer. No online service is connected.</span>
      )}
    </p>
  );
}

export function ChangeCard({
  change,
  detail,
  children,
}: {
  change: Change;
  detail: Detail;
  children: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hunks = change.hunks?.length ? change.hunks : [{ value: change.after ?? '', added: true }];
  const actions = Children.toArray(children);
  const added = hunks
    .filter((h) => h.added)
    .reduce((n, h) => n + (h.count ?? h.value.trimEnd().split('\n').length), 0);
  const removed = hunks
    .filter((h) => h.removed)
    .reduce((n, h) => n + (h.count ?? h.value.trimEnd().split('\n').length), 0);
  return (
    <article
      id={`change-${change.id}`}
      className={`change-card ${change.changedSince ? 'conflicted' : ''}`}
    >
      <div className="change-heading">
        <h3>{change.path}</h3>
        <span className="caption">{change.summary ?? 'Changes to this file'}</span>
        <div className="actions push-right">{actions.slice(0, 2)}</div>
      </div>
      {detail === 'guided' && (
        <p className="prose small change-explanation">
          <strong>What changed, in plain words:</strong>{' '}
          {change.op === 'created'
            ? 'A new document was added.'
            : change.op === 'deleted'
              ? 'The document was removed from the folder. Its previous contents are in History.'
              : `${added} ${added === 1 ? 'line was' : 'lines were'} added${removed ? ` and ${removed} removed` : ''}. The unchanged text stays in place.`}
        </p>
      )}
      {change.changedSince && (
        <p className="fault-text change-explanation">
          Newer changes are in the way. Your current file is preserved until you decide.
        </p>
      )}
      <div className={`change-lines ${full ? 'code' : ''}`}>
        {hunks.map((h, i) => {
          const lines = h.value.trimEnd().split('\n');
          const value =
            !expanded && !h.added && !h.removed && lines.length > 6
              ? [...lines.slice(0, 2), '... unchanged lines ...', ...lines.slice(-3)].join('\n')
              : h.value;
          return (
            <div
              key={i}
              className={`change-hunk ${h.added ? 'added' : h.removed ? 'removed' : 'context'}`}
            >
              <span aria-hidden="true">{h.added ? '+' : h.removed ? '-' : ' '}</span>
              <pre>{value || '(empty file)'}</pre>
            </div>
          );
        })}
      </div>
      <div className="actions change-footer">
        {actions.slice(2)}
        {hunks.some((h) => !h.added && !h.removed && h.value.split('\n').length > 6) && (
          <Button tone="quiet" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show fewer lines' : 'Show all lines'}
          </Button>
        )}
        {detail === 'technical' && (
          <Button tone="quiet" onClick={() => setFull(!full)}>
            {full ? 'Close diff' : 'Open diff'}
          </Button>
        )}
      </div>
    </article>
  );
}
