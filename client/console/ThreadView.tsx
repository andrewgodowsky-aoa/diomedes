import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Change,
  Conversation,
  HistoryEntry,
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
import type { FollowUpCommand } from '../../shared/work-control';
import { effortFor } from '../../shared/effort';
import type { InstructionFileRecord } from '../../shared/capability-packs';
import { formatOrigin, originForSession, originForTurn } from '../../shared/attribution';
import { ApprovalStatus, time } from '../components';
import { RunInspector } from '../workbench/RunInspector';
import { taskEvidence } from '../workbench/task-evidence';
import { stopWork } from '../api';
import { Composer } from './Composer';
import { ProjectInstructions } from './ProjectInstructions';
import { FollowUpQueue } from './FollowUpQueue';
import { StopMenu, StopReceiptLine } from './StopMenu';
import { NeedBlock } from './Need';

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
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
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
  projectId?: string;
  history?: HistoryEntry[];
  allNeeds?: Need[];
  changes?: Change[];
  /**
   * What the Software Engineering pack found in this project's folder, and
   * only while it is active. Empty for every project that did not turn a pack
   * on, which is what keeps the indication from appearing where nothing loaded.
   */
  instructionFiles?: readonly InstructionFileRecord[];
  /** The project's follow-up queue. The rows for this task are shown and driven here. */
  followUps?: FollowUpCommand[];
  permissionControl?: ReactNode;
  onScope?(): void;
  grantActive?: boolean;
  settings: Settings;
  mode: Mode;
  route: Route;
  busy: boolean;
  online: boolean;
  onMode(mode: Mode): void;
  onPermission(permission: ThreadPermission): void;
  onRename(): void;
  onSend(
    mode: Mode,
    text: string,
    route: Route,
    failing?: { document?: string; text?: string },
    sources?: string[],
  ): void;
  onResolve(need: Need, resolution: 'go-ahead' | 'declined', allow?: boolean): void;
  onPreview(need: Need): void;
  onStopSession(id: string): void;
  onOpenBoard(): void;
  /** Live streamed text for a new external-engine Ask/Plan: ephemeral, never saved. */
  streaming?: { requestId: string; text: string; engine: string };
  onCancelText?(): void;
  /** Where a refused scoped Stop is reported; without it the refusal is silent. */
  onError?(error: Error): void;
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
  projectId,
  history = [],
  allNeeds,
  changes = [],
  instructionFiles = [],
  followUps = [],
  permissionControl,
  onScope,
  grantActive = false,
  settings,
  mode,
  route,
  busy,
  online,
  onMode,
  onPermission,
  onRename,
  onSend,
  onResolve,
  onPreview,
  onStopSession,
  onOpenBoard,
  streaming,
  onCancelText,
  onError,
}: ThreadViewProps) {
  const permission: ThreadPermission = thread.permission ?? 'show-first';
  const live = sessions.find((s) => ['queued', 'working', 'waiting'].includes(s.state)) ?? null;
  const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const last = ordered.at(-1) ?? null;

  const savedModel =
    typeof settings.services?.[`${route}Model`] === 'string'
      ? String(settings.services[`${route}Model`])
      : '';
  const savedEffort =
    route === 'codex' && typeof settings.services?.codexEffort === 'string'
      ? settings.services.codexEffort
      : '';
  const modelId = thread.requested?.model || savedModel || 'engine default';
  const wantedEffort = route === 'codex' ? thread.requested?.effort || savedEffort || 'medium' : '';
  const runsAt = effortFor(mode, wantedEffort, wantedEffort);
  const capped = runsAt !== wantedEffort;
  const context =
    live?.engine.context ??
    [...ordered].reverse().find((s) => s.engine.context != null)?.engine.context;
  const ended = ordered.filter((s) => s.endedAt);
  const lastRun = ended.at(-1) ?? null;

  const nameOf = (slot: Slot) =>
    slot === 'owner' ? 'You' : (members.find((m) => m.slotId === slot)?.name ?? slot);
  const worker =
    (live ? formatOrigin(originForSession(live)).label : member?.name) ??
    (last ? formatOrigin(originForSession(last)).label : task?.owner === 'you' ? 'You' : '');
  const evidence = task ? taskEvidence(task, sessions, allNeeds ?? needs, changes) : null;
  const stateWord = evidence?.column.toLowerCase() ?? '';
  const stateClass = stateWord === 'review' || stateWord === 'blocked' ? 'attn' : '';

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
  }, [thread.turns.length, live?.id, thread.id, streaming?.requestId, streaming?.text.length]);

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
              data-thread-point={t.role !== 'you' ? '' : undefined}
            >
              <div className="who">
                <b>{t.role === 'you' ? 'You' : formatOrigin(originForTurn(t)).primary}</b>
                {t.role !== 'you' && (
                  <span title={formatOrigin(originForTurn(t)).detail}>
                    {formatOrigin(originForTurn(t)).secondary}
                  </span>
                )}
                <span className="mono">{time(t.at).toLowerCase()}</span>
                {t.role !== 'you' && (
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
              <b>{fromOwner ? 'You' : nameOf(m.from)}</b>
              <span className="mono">
                {nameOf(m.from)} to {nameOf(m.to)} · {time(m.createdAt).toLowerCase()}
              </span>
            </div>
            <div className="body">
              {paragraphs(m.content).map((p, j) => (
                <p key={j}>{p}</p>
              ))}
            </div>
            {m.files && m.files.length > 0 && (
              <p className="caption">Files: {m.files.join(', ')}</p>
            )}
          </div>
        </div>
      ),
    });
  });
  // Three Stops, and what the last one actually did. The plain Stop keeps its
  // word and today's meaning; the other two are offered only where they would
  // do something. The receipt sits under the run it was pressed on.
  const queuedForTask = task
    ? followUps.filter((item) => item.taskId === task.id && item.state === 'queued')
    : [];
  const lastReceipt = task?.stopReceipts?.at(-1) ?? null;
  const receiptOn =
    lastReceipt?.sessionId ?? (lastReceipt ? (ordered.at(-1)?.id ?? null) : null);
  ordered.forEach((s) => {
    items.push({
      at: s.startedAt,
      seq: 2000,
      node: (
        <RunRecord
          key={s.id}
          session={s}
          onStop={() => onStopSession(s.id)}
          stop={
            projectId && task ? (
              <StopMenu
                live={['queued', 'working'].includes(s.state)}
                queuedCount={queuedForTask.length}
                busy={busy}
                onStopTask={() => onStopSession(s.id)}
                onStopScope={(scope) =>
                  void stopWork(projectId, { scope, taskId: task.id, sessionId: s.id }).catch(
                    (error: unknown) =>
                      onError?.(error instanceof Error ? error : new Error(String(error))),
                  )
                }
              />
            ) : undefined
          }
          receipt={
            lastReceipt && receiptOn === s.id ? <StopReceiptLine receipt={lastReceipt} /> : undefined
          }
        />
      ),
    });
  });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

  function submit(text: string, failingDocument: string, failingText: string) {
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
        {permissionControl ?? (
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
        )}
        {projectId && instructionFiles.length > 0 && (
          <ProjectInstructions projectId={projectId} files={instructionFiles} />
        )}
      </div>
      <div className="col instr" aria-label="Thread instruments">
        <span>
          next request <b>{mode}</b> <span className="lc">{modelId}</span>{' '}
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
            <span className={`st ${stateClass}`}>{stateWord}</span>{' '}
            <span className="lc">{worker}</span>
          </span>
        )}
      </div>
      <div className="transcript" ref={body}>
        <div className="col">
          <p className="permission-note">
            {grantActive
              ? 'Supported writes for this task use its confirmed scope. Sending remains a separate decision.'
              : route !== 'sample' || needs.some((n) => n.approval)
                ? 'Each proposed file change needs its own exact OK.'
                : permission === 'task'
                  ? 'The first OK in a task covers the rest of it. Nothing runs without that first OK.'
                  : 'Every change waits for your OK.'}
          </p>
          {projectId && (
            <RunInspector
              projectId={projectId}
              session={live ?? last}
              needs={allNeeds ?? needs}
              history={history}
            />
          )}
          {needs.map((n) => (
            <div id={`need-${n.id}`} key={n.id}>
              <NeedBlock
                need={n}
                session={sessions.find((session) => session.id === n.sessionId)}
                onScope={onScope}
                decide={(r, a) =>
                  onResolve(
                    n,
                    r,
                    n.approval ? false : (a ?? (r === 'go-ahead' && permission === 'task')),
                  )
                }
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
          {streaming && (
            <div className="exchange" key={`stream-${streaming.requestId}`}>
              <div className="turn dio">
                <div className="who">
                  <b>{formatOrigin(undefined, { engine: streaming.engine }).primary}</b>
                  <span className="mono">live</span>
                </div>
                <div className="body">
                  {streaming.text ? (
                    paragraphs(streaming.text).map((p, j) => <p key={j}>{p}</p>)
                  ) : (
                    <p className="caption">Preparing…</p>
                  )}
                </div>
                {onCancelText && (
                  <div>
                    <button type="button" onClick={onCancelText}>
                      Stop
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          {receiptNeeds.map((n) => (
            <ApprovalStatus key={n.id} need={n} />
          ))}
        </div>
      </div>
      {route !== 'sample' && (
        <p className="caption">
          Sending shares this instruction and selected documents with {route}. The selected account
          is billed under its own plan. Engine tools are disabled; file proposals follow the task's
          authority.
        </p>
      )}
      <Composer
        thread={thread}
        mode={mode}
        onMode={onMode}
        busy={busy}
        online={online}
        onSend={submit}
      />
      {projectId && task && (
        <FollowUpQueue
          projectId={projectId}
          task={task}
          route={route}
          followUps={followUps}
          busy={busy}
        />
      )}
    </main>
  );
}

function RunRecord({
  session,
  onStop,
  stop,
  receipt,
}: {
  session: Session;
  onStop(): void;
  /** The scoped Stop cluster. Falls back to today's single button when absent. */
  stop?: ReactNode;
  receipt?: ReactNode;
}) {
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
        {receipt}
      </div>
    );
  }
  return (
    <div className={`record open ${live ? 'live' : ''}`}>
      <div className="run-origin">{formatOrigin(originForSession(session)).label}</div>
      {lines.map((l, i) => (
        <div key={i}>
          <b>{clockOf(l.time)}</b> <span>{l.sentence}</span>
        </div>
      ))}
      {live && (
        <div>
          {stop ?? (
            <button type="button" onClick={onStop}>
              Stop
            </button>
          )}{' '}
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
      {receipt}
    </div>
  );
}
