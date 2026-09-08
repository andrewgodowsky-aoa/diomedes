import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Conversation,
  MailboxMessage,
  Mode,
  Need,
  Route,
  Session,
  Settings,
  Slot,
  Task,
  TeamMember,
  ThreadPermission,
  Turn,
} from '../../shared/types';
import { effortFor } from '../../shared/effort';
import { ApprovalStatus, Notice, time } from '../components';
import { Composer } from './Composer';

function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${+s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

function clockOf(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

interface ThreadViewProps {
  thread: Conversation;
  title: string;
  task: Task | null;
  sessions: Session[];
  mail: MailboxMessage[];
  members: TeamMember[];
  member: TeamMember | null;
  needs: Need[];
  receiptNeeds?: Need[];
  settings: Settings;
  mode: Mode;
  route: Route;
  toTeam: boolean;
  busy: boolean;
  online: boolean;
  onMode(mode: Mode): void;
  onTeam(on: boolean): void;
  onPermission(permission: ThreadPermission): void;
  onRename(): void;
  onSend(
    mode: Mode,
    text: string,
    route: Route,
    failing?: { document?: string; text?: string },
    sources?: string[],
  ): void;
  onMessage(member: TeamMember, text: string): void;
  onResolve(need: Need, resolution: 'go-ahead' | 'declined', allow?: boolean): void;
  onPreview(need: Need): void;
  onStopSession(id: string): void;
  onOpenBoard(): void;
}

/**
 * One thread: head with permission control, the mono instrument line, the
 * transcript as you/Diomedes exchanges with team mail and run records woven
 * in by time, and the composer.
 */
export function ThreadView({
  thread,
  title,
  task,
  sessions,
  mail,
  members,
  member,
  needs,
  receiptNeeds = [],
  settings,
  mode,
  route,
  toTeam,
  busy,
  online,
  onMode,
  onTeam,
  onPermission,
  onRename,
  onSend,
  onMessage,
  onResolve,
  onPreview,
  onStopSession,
  onOpenBoard,
}: ThreadViewProps) {
  const permission: ThreadPermission = thread.permission ?? 'show-first';
  const live = sessions.find((s) => ['queued', 'working', 'waiting'].includes(s.state)) ?? null;
  const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const last = ordered.at(-1) ?? null;
  const lastHelper = [...thread.turns].reverse().find((t) => t.role === 'diomedes');

  const savedModel = typeof settings.services?.codexModel === 'string' ? settings.services.codexModel : '';
  const savedEffort = typeof settings.services?.codexEffort === 'string' ? settings.services.codexEffort : '';
  const modelId = thread.requested?.model || savedModel || last?.engine.model || lastHelper?.helper?.model || 'default';
  const wantedEffort = thread.requested?.effort || savedEffort || 'medium';
  const runsAt = effortFor(mode, wantedEffort, wantedEffort);
  const capped = runsAt !== wantedEffort;
  const context = live?.engine.context ?? [...ordered].reverse().find((s) => s.engine.context != null)?.engine.context;
  const ended = ordered.filter((s) => s.endedAt);
  const lastRun = ended.at(-1) ?? null;

  const nameOf = (slot: Slot) =>
    slot === 'owner' ? 'You' : (members.find((m) => m.slotId === slot)?.name ?? slot);
  const worker = live?.engine.name ?? member?.name ?? (task ? (task.owner === 'you' ? 'You' : 'Diomedes') : '');
  const [stateWord, stateClass]: [string, string] = !task
    ? ['', '']
    : task.state === 'todo'
      ? ['ready', 'quiet']
      : task.state === 'working'
        ? ['working', '']
        : task.state === 'done'
          ? ['done', 'quiet']
          : [
              task.reason === 'changes-ready' ? 'review' : task.reason === 'went-wrong' ? 'blocked' : 'needs you',
              'attn',
            ];

  // Group turns into exchanges: a you-turn opens one, following Diomedes
  // turns join it, and a Diomedes turn with no preceding you-turn stands alone.
  const exchanges: Turn[][] = [];
  for (const turn of thread.turns) {
    const current = exchanges.at(-1);
    if (turn.role === 'you' || !current || current[0].role !== 'you') exchanges.push([turn]);
    else current.push(turn);
  }

  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [thread.turns.length, live?.id, thread.id]);

  const items: { at: string; seq: number; node: ReactNode }[] = [];
  exchanges.forEach((group, i) => {
    items.push({
      at: group[0].at,
      seq: i,
      node: (
        <div className="exchange" key={`ex-${i}`}>
          {group.map((t) => (
            <div
              className={`turn ${t.role === 'you' ? 'you' : 'dio'}`}
              key={t.id || `${thread.id}:${i}`}
              data-thread-point={t.role === 'diomedes' ? '' : undefined}
            >
              <div className="who">
                <b>{t.role === 'you' ? 'You' : 'Diomedes'}</b>
                <span className="mono">{time(t.at).toLowerCase()}</span>
                {t.role === 'diomedes' && (
                  <span className="tools">
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          void navigator.clipboard?.writeText(t.text);
                        } catch {
                          // Clipboard is unavailable; the text stays selectable.
                        }
                      }}
                    >
                      Copy
                    </button>
                  </span>
                )}
              </div>
              <div className="body">
                {paragraphs(t.text).map((p, j) => (
                  <p key={j}>{p}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      ),
    });
  });
  mail.forEach((m) => {
    const fromOwner = m.from === 'owner';
    items.push({
      at: m.createdAt,
      seq: 1000,
      node: (
        <div className="exchange" key={m.id}>
          <div className={`turn ${fromOwner ? 'you' : 'dio'}`}>
            <div className="who">
              <b>{fromOwner ? 'You' : 'Diomedes'}</b>
              <span className="mono">
                {nameOf(m.from)} to {nameOf(m.to)} · {time(m.createdAt).toLowerCase()}
              </span>
            </div>
            <div className="body">
              {paragraphs(m.content).map((p, j) => (
                <p key={j}>{p}</p>
              ))}
            </div>
            {m.files && m.files.length > 0 && <p className="caption">Files: {m.files.join(', ')}</p>}
          </div>
        </div>
      ),
    });
  });
  ordered.forEach((s) => {
    items.push({
      at: s.startedAt,
      seq: 2000,
      node: <RunRecord key={s.id} session={s} onStop={() => onStopSession(s.id)} />,
    });
  });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

  function submit(text: string, failingDocument: string, failingText: string) {
    if (toTeam && member) {
      onMessage(member, text);
      return;
    }
    if (mode === 'fix') {
      const doc = failingDocument.trim();
      const txt = failingText.trim();
      onSend(
        mode,
        text,
        route,
        { ...(doc ? { document: doc } : {}), ...(txt ? { text: txt } : {}) },
        doc ? [doc] : [],
      );
      return;
    }
    onSend(mode, text, route);
  }

  return (
    <main className="work" aria-label={title}>
      <div className="col head">
        <h1 onClick={onRename} title="Rename thread">
          {title}
        </h1>
        <div className="seg" role="radiogroup" aria-label="What Diomedes may do">
          <button
            type="button"
            role="radio"
            aria-checked={permission === 'show-first'}
            className={permission === 'show-first' ? 'on' : ''}
            disabled={busy}
            onClick={() => permission !== 'show-first' && onPermission('show-first')}
          >
            Show me first
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={permission === 'task'}
            className={permission === 'task' ? 'on' : ''}
            disabled={busy}
            onClick={() => permission !== 'task' && onPermission('task')}
          >
            Go ahead for this task
          </button>
        </div>
      </div>
      <div className="col instr" aria-label="Thread instruments">
        <span>
          <b>{mode}</b> <span className="lc">{modelId}</span>{' '}
          <span className="lc">
            {runsAt}
            {capped ? ', capped' : ''}
          </span>
        </span>
        {context != null && (
          <span>
            context <b>{Math.round(context)}%</b>
          </span>
        )}
        {lastRun?.endedAt && (
          <span>
            last run <span className="lc">{time(lastRun.endedAt).toLowerCase()}</span>{' '}
            <span className="lc">
              {fmtDur(new Date(lastRun.endedAt).getTime() - new Date(lastRun.startedAt).getTime())}
            </span>
          </span>
        )}
        <span>
          runs <b>{ordered.length}</b>
        </span>
        <span className="grow" />
        {task && (
          <span>
            task{' '}
            <button type="button" onClick={onOpenBoard} title="Open this task on the board">
              {task.name}
            </button>{' '}
            <span className={`st ${stateClass}`}>{stateWord}</span> <span className="lc">{worker}</span>
          </span>
        )}
      </div>
      <div className="transcript">
        <div className="col" ref={body}>
          {needs.map((n) => (
            <div id={`need-${n.id}`} key={n.id}>
              <Notice
                need={n}
                decide={(r, a) => onResolve(n, r, n.approval ? false : a ?? (r === 'go-ahead' && permission === 'task'))}
                show={() => onPreview(n)}
              />
            </div>
          ))}
          {!thread.turns.length && !live && (
            <div className="greeting" data-thread-point>
              <p>A new thread.</p>
              <p>Ask, or choose Plan, Build or Fix below. Nothing changes until you say so.</p>
            </div>
          )}
          {items.map((entry, i) => (
            <div key={i}>{entry.node}</div>
          ))}
          {receiptNeeds.map((n) => (
            <ApprovalStatus key={n.id} need={n} />
          ))}
        </div>
      </div>
      <Composer
        thread={thread}
        mode={mode}
        onMode={onMode}
        member={member}
        toTeam={toTeam}
        onTeam={onTeam}
        busy={busy}
        online={online}
        onSend={submit}
      />
    </main>
  );
}

function RunRecord({ session, onStop }: { session: Session; onStop(): void }) {
  const live = ['queued', 'working', 'waiting'].includes(session.state);
  const [open, setOpen] = useState(live);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  const lines = open || live ? session.log.filter((l) => l.level === 'plain' || details) : [];
  const dur = session.endedAt
    ? fmtDur(new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime())
    : null;
  if (!live && !open) {
    return (
      <div className="record">
        <b>{session.log.length} events</b> {dur}{' '}
        <button type="button" onClick={() => setOpen(true)}>
          show run
        </button>
      </div>
    );
  }
  return (
    <div className={`record open ${live ? 'live' : ''}`}>
      {lines.map((l, i) => (
        <div key={i}>
          <b>{clockOf(l.time)}</b> <span>{l.sentence}</span>
        </div>
      ))}
      {live && (
        <div>
          <button type="button" onClick={onStop}>
            Stop
          </button>{' '}
          <button type="button" onClick={() => setDetails(!details)}>
            {details ? 'Fewer details' : 'All details'}
          </button>
        </div>
      )}
      {!live && (
        <div>
          <button type="button" onClick={() => setOpen(false)}>
            hide run
          </button>{' '}
          <button type="button" onClick={() => setDetails(!details)}>
            {details ? 'Fewer details' : 'All details'}
          </button>
        </div>
      )}
    </div>
  );
}
