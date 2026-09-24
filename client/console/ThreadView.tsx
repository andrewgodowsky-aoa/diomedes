import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Change,
  Conversation,
  DocumentInfo,
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
import { AGENT_NAME } from '../../shared/agent-name';
import { effortFor } from '../../shared/effort';
import { isExternalEngine, isRoute } from '../../shared/engines';
import { isModelApiRoute } from '../../shared/model-api';
import type { InstructionFileRecord } from '../../shared/capability-packs';
import { formatOrigin, originForSession, originForTurn } from '../attribution-display';
import { ApprovalStatus, time } from '../components';
import { RunInspector } from '../workbench/RunInspector';
import { taskEvidence } from '../workbench/task-evidence';
import { stopWork } from '../api';
import { Composer } from './Composer';
import { ProjectInstructions } from './ProjectInstructions';
import { FollowUpQueue } from './FollowUpQueue';
import { StopMenu, StopReceiptLine } from './StopMenu';
import { NeedBlock } from './Need';
import { RememberOfferBlock } from './RememberedApprovals';
import { classifyIntent } from '../../shared/remembered-approvals';
import type { RememberOffer } from '../../shared/permissions';
import { ChangeReview } from './ChangeReview';
import { useWorkingWord, workingLine } from './working-words';
import { toolRunning, type ToolLine } from './engine-activity';
import { ToolActivityList } from './ToolActivity';
import { resolvedDetail, threadStyle, useWorkStyleView } from './WorkStylePicker';
import { WORK_STYLE_LABELS } from '../../shared/work-style';
import { TurnBody } from './TurnBody';
import { VerificationBadge, VerificationPanel, verificationFor } from './Verification';
import { sizeLabel } from './FilesPane';
import { turnKeyOf, type ArtifactIndex, type ArtifactRecord } from './artifacts';
import { identityLabel, turnReference } from '../../shared/file-identity';

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
  /** Opens a project file in the Files pane; the instruction inspector's "Open in Files". */
  onOpenInFiles?(path: string): void;
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
  prepareSources(mode: Mode, text: string, failingDocument: string): Promise<string[]>;
  onSend(
    mode: Mode,
    text: string,
    route: Route,
    failing?: { document?: string; text?: string },
    sources?: string[],
    readAccess?: import('../../shared/read-access').ReadAccess,
  ): void;
  onResolve(need: Need, resolution: 'go-ahead' | 'declined', allow?: boolean): void;
  onPreview(need: Need): void;
  onStopSession(id: string): void;
  onOpenBoard(): void;
  /** Live streamed text for a new external-engine Ask/Plan: ephemeral, never saved. */
  streaming?: { requestId: string; text: string; engine: string; activity?: ToolLine[] };
  /** Live tool calls for a work run, by the run's session id. Ephemeral, never saved. */
  runActivity?: Readonly<Record<string, ToolLine[]>>;
  onCancelText?(): void;
  /** Where a refused scoped Stop is reported; without it the refusal is silent. */
  onError?(error: Error): void;
  /** A playbook picked for the next message, passed through to the composer. */
  skill?: {
    name: string;
    starter: string;
    n: number;
    /** What approved read connectors cover for this playbook, and a way to add one. */
    connectors?: { text: string; onAdd?: () => void } | null;
  } | null;
  onClearSkill?(): void;
  /**
   * A conversation message this thread sent and never had confirmed. Sending it again reads
   * what the record says and never asks twice; Discard gives it up.
   */
  unconfirmed?: { text: string; onResend(): void; onDiscard(): void } | null;
  /**
   * The thread's artifacts, read from its durable turns. With them an artifact
   * block leaves a chip that opens it in the panel; without them every block
   * renders inline.
   */
  artifacts?: ArtifactIndex;
  onOpenArtifact?(record: ArtifactRecord): void;
  /** The artifact the panel is showing, so its chip can say so. */
  openArtifactKey?: string | null;
  /** The conversation's "···" menu (ThreadMenu.tsx), at the end of the head. */
  menu?: ReactNode;
  /** Files attached to the next message, passed through to the composer. */
  attachments?: readonly DocumentInfo[];
  onAttachments?(files: DocumentInfo[]): void;
  attachable?(): Promise<DocumentInfo[]>;
  onOpenFile?(path: string): void;
  /** Opens a sent message's file in Files at the exact version it named. */
  onOpenReference?(reference: { path: string; sha: string | null }): void;
  /** Open learned offers (D5) whose approval this thread owns, asked once each. */
  rememberOffers?: RememberOffer[];
  onAnswerOffer?(offer: RememberOffer, accept: boolean): void;
  /** Go ahead on this exact approval and remember it in this project (D5, route 1). */
  onRemember?(need: Need): void;
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
  onOpenInFiles,
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
  prepareSources,
  onSend,
  onResolve,
  onPreview,
  onStopSession,
  onOpenBoard,
  streaming,
  runActivity,
  onCancelText,
  onError,
  skill = null,
  onClearSkill,
  unconfirmed = null,
  artifacts,
  onOpenArtifact,
  openArtifactKey = null,
  menu = null,
  attachments,
  onAttachments,
  attachable,
  onOpenFile,
  onOpenReference,
  rememberOffers = [],
  onAnswerOffer,
  onRemember,
}: ThreadViewProps) {
  const technical = settings.detail === 'technical';
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
  // A thread on a WorkStyle names the style for everyone; the model and level it resolves to
  // are details, shown at technical detail or on request. A pinned model is named as before.
  const style = thread.requested?.model ? null : threadStyle(thread, settings);
  const styleView = useWorkStyleView(projectId, thread, [route, mode, settings.services?.workStyle]);
  // The route the host says the next request runs on (the owner's tier map, else the thread's
  // own route). The confirmation names it and decides by it; the recorded route stands only
  // until the host has answered.
  const sendRoute: Route = styleView && isRoute(styleView.route) ? styleView.route : route;
  const [styleDetails, setStyleDetails] = useState(false);
  const showStyleDetails = settings.detail === 'technical' || styleDetails;
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
  // A turn's place in the thread, which names it when an old record has no id.
  const turnIndex = new Map(thread.turns.map((turn, index) => [turn, index]));

  // While an answer is on its way and nothing has streamed yet, the agent
  // says what it is up to. Display only; nothing here is recorded. A tool
  // call in progress already says it, so the line waits behind it.
  const streamWaiting = Boolean(
    streaming && !streaming.text && !toolRunning(streaming.activity),
  );
  const streamWord = useWorkingWord(
    mode === 'plan' ? 'drafting the plan' : 'replying',
    streamWaiting,
  );
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [
    thread.turns.length,
    live?.id,
    thread.id,
    streaming?.requestId,
    streaming?.text.length,
    streaming?.activity?.length,
  ]);

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
                {t.role === 'you' && t.skill && (
                  <span className="mono lc" title={`${t.skill.packId} ${t.skill.packVersion}`}>
                    playbook {t.skill.name}
                  </span>
                )}
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
                {t.role === 'you' ? (
                  <>
                    {paragraphs(t.text).map((p, j) => <p key={j}>{p}</p>)}
                    {/* What this message carried, each at the exact version it named. */}
                    {onOpenReference && t.sources.length > 0 && (
                      <div className="turn-refs" aria-label="Files sent with this message">
                        {t.sources.map((path) => {
                          const identity = turnReference(t, path, history ?? []);
                          return (
                            <button
                              type="button"
                              className="ref-chip"
                              key={path}
                              title={identity ? `${path} · ${identity.sha}` : path}
                              onClick={() => onOpenReference({ path, sha: identity?.sha ?? null })}
                            >
                              <span className="ref-name">{path.slice(path.lastIndexOf('/') + 1)}</span>
                              <span className="mono">
                                {identity ? identityLabel(identity) : 'version not recorded'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <TurnBody
                    text={t.text}
                    session={live}
                    artifactAt={
                      artifacts &&
                      ((block) => artifacts.forBlock(turnKeyOf(t, turnIndex.get(t) ?? 0), block))
                    }
                    onOpenArtifact={onOpenArtifact}
                    openKey={openArtifactKey}
                  />
                )}
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
    // H17: every finished run shows its four-state result, "Not verified" included.
    const verification = task ? verificationFor(s, task, history) : null;
    items.push({
      at: s.startedAt,
      seq: 2000,
      node: (
        <RunRecord
          key={s.id}
          session={s}
          activity={runActivity?.[s.id]}
          technical={technical}
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
          verification={
            verification ? (
              <VerificationPanel view={verification} task={task} projectId={projectId} onError={onError} />
            ) : undefined
          }
          verificationBadge={verification ? <VerificationBadge view={verification} /> : undefined}
        />
      ),
    });
  });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);

  function submit(
    text: string,
    failingDocument: string,
    failingText: string,
    sources: string[],
    readAccess: import('../../shared/read-access').ReadAccess,
  ) {
    if (mode === 'fix') {
      const doc = failingDocument.trim();
      const txt = failingText.trim();
      onSend(
        mode,
        text,
        sendRoute,
        { ...(doc ? { document: doc } : {}), ...(txt ? { text: txt } : {}) },
        sources,
      );
      return;
    }
    onSend(mode, text, sendRoute, undefined, sources, readAccess);
  }

  return (
    <main className="work" aria-label={title}>
      <div className="col head">
        <h1 onClick={onRename} title="Rename thread">
          {title}
        </h1>
        {permissionControl ?? (
          <div className="seg" role="radiogroup" aria-label={`What ${AGENT_NAME} may do`}>
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
          <ProjectInstructions
            projectId={projectId}
            files={instructionFiles}
            delivery={
              [...ordered].reverse().find((session) => session.instructions)?.instructions ?? null
            }
            onOpenInFiles={onOpenInFiles}
          />
        )}
        {menu}
      </div>
      <div className="col instr" aria-label="Thread instruments">
        {style ? (
          <span>
            next request <b>{mode}</b> <span className="lc">{WORK_STYLE_LABELS[style]}</span>{' '}
            {showStyleDetails ? (
              <span className="lc">{resolvedDetail(styleView)}</span>
            ) : (
              <button
                type="button"
                title="The model and reasoning level this style resolves to"
                onClick={() => setStyleDetails(true)}
              >
                details
              </button>
            )}
          </span>
        ) : (
          <span>
            next request <b>{mode}</b> <span className="lc">{modelId}</span>{' '}
            <span className="lc">
              {runsAt}
              {capped ? ', capped' : ''}
            </span>
          </span>
        )}
        {context != null && (
          <span title="The size of the project documents sent with the latest request">
            context <b>{sizeLabel(context)}</b>
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
          {projectId && task && (
            <ChangeReview
              projectId={projectId}
              taskId={task.id}
              refreshKey={`${last?.id ?? ''}:${last?.state ?? ''}:${changes.length}:${history.length}`}
            />
          )}
          {projectId && !task && (
            <ChangeReview projectId={projectId} taskId={null} refreshKey="" />
          )}
          {needs.map((n) => (
            <div id={`need-${n.id}`} key={n.id}>
              <NeedBlock
                need={n}
                session={sessions.find((session) => session.id === n.sessionId)}
                onScope={onScope}
                onRemember={
                  onRemember &&
                  n.harness &&
                  n.approval &&
                  classifyIntent('', n.harness.intent).rememberable
                    ? () => onRemember(n)
                    : undefined
                }
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
          {onAnswerOffer &&
            rememberOffers.map((offer) => (
              <RememberOfferBlock
                key={offer.id}
                offer={offer}
                answer={(accept) => onAnswerOffer(offer, accept)}
              />
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
                <ToolActivityList lines={streaming.activity} technical={technical} />
                <div className="body">
                  {streaming.text ? (
                    <TurnBody text={streaming.text} preview session={live} />
                  ) : (
                    streamWaiting && <p className="caption">{workingLine(streamWord)}</p>
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
          {unconfirmed && !streaming && !busy && (
            <div role="group" aria-label="A message that was not confirmed">
              <p className="caption">
                Nectovia could not confirm your last message. Sending it again checks what
                happened and never asks twice.
              </p>
              <p className="caption" title={unconfirmed.text}>
                {unconfirmed.text}
              </p>
              <div>
                <button type="button" onClick={unconfirmed.onResend}>
                  Send again
                </button>{' '}
                <button type="button" onClick={unconfirmed.onDiscard}>
                  Discard
                </button>
              </div>
            </div>
          )}
          {receiptNeeds.map((n) => (
            <ApprovalStatus key={n.id} need={n} />
          ))}
        </div>
      </div>
      <Composer
        thread={thread}
        projectId={projectId}
        mode={mode}
        onMode={onMode}
        busy={busy}
        online={online}
        route={sendRoute}
        confirmSend={
          isExternalEngine(sendRoute) ||
          (sendRoute === 'codex' && (mode === 'build' || mode === 'fix' || settings.permissions.sending)) ||
          // Build and Fix send the selected documents to the company's provider account.
          (isModelApiRoute(sendRoute) && (mode === 'build' || mode === 'fix'))
        }
        prepareSources={(text, doc) => prepareSources(mode, text, doc)}
        onSend={submit}
        skill={skill}
        onClearSkill={onClearSkill}
        attachments={attachments}
        onAttachments={onAttachments}
        attachable={attachable}
        onOpenFile={onOpenFile}
      />
      {/* A follow-up waits behind a run. With nothing running and nothing queued,
          the composer above sends at once, so a second box would only ask the
          person which of two boxes to type in. */}
      {projectId &&
        task &&
        (live || followUps.some((f) => f.taskId === task.id && f.state === 'queued')) && (
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
  activity,
  technical,
  onStop,
  stop,
  receipt,
  verification,
  verificationBadge,
}: {
  session: Session;
  /** Tool calls streamed for this run while it is live. Never saved; the log is the record. */
  activity?: ToolLine[];
  technical: boolean;
  onStop(): void;
  /** The scoped Stop cluster. Falls back to today's single button when absent. */
  stop?: ReactNode;
  receipt?: ReactNode;
  /** H17: the finished run's four-state result, with its evidence. */
  verification?: ReactNode;
  /** The same result's state word, for the folded record. */
  verificationBadge?: ReactNode;
}) {
  const live = ['queued', 'working', 'waiting'].includes(session.state);
  const waiting = live && session.state !== 'waiting' && !toolRunning(activity);
  const word = useWorkingWord('on it', waiting);
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
        </button>{' '}
        {verificationBadge}
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
      {live && <ToolActivityList lines={activity} technical={technical} />}
      {waiting && (
        <div className="caption" aria-hidden="true">
          {workingLine(word)}
        </div>
      )}
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
      {!live && verification}
      {receipt}
    </div>
  );
}
