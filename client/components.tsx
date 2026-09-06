import { Children, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Change, Detail, Need, Session, Settings, Surface, TaskState } from '../shared/types';

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
  book: 'One page at a time. Ask, plan, work and review, and Diomedes asks before anything that matters.',
  desk: 'Every thread, every helper and every change on one screen. For people who work with these tools every day.',
};
export function surfaceOf(settings: Settings): Surface {
  return settings.surface === 'desk' ||
    (settings.surface === undefined && settings.detail === 'technical')
    ? 'desk'
    : 'book';
}
export function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
      <i aria-hidden="true" />
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
        <Button onClick={() => decide('go-ahead', true)}>Go ahead for this whole task</Button>
        <Button onClick={() => decide('declined')}>Don't do this</Button>
        <Button tone="quiet" onClick={show}>
          Show me first
        </Button>
      </div>
      <p className="caption">Diomedes is paused until you decide.</p>
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
