import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Project, Route, Turn } from '../../shared/types';
import { AGENT_NAME } from '../../shared/agent-name';
import { routeDisplayName } from '../../shared/engines';
import { WORK_STYLES, WORK_STYLE_DESCRIPTIONS, WORK_STYLE_LABELS, isWorkStyle, type WorkStyle } from '../../shared/work-style';
import { speakerName } from '../attribution-display';
import type { EverythingItem } from './Everything';
import { Rail, type RailSection } from './Rail';
import { showsScope } from './home-rail';
import { useWorkingWord, workingLine } from './working-words';
import { toolRunning, type ToolLine } from './engine-activity';
import type { LiveThinking } from './engine-reasoning';
import { Thinking } from './Thinking';
import { ToolActivityList } from './ToolActivity';
import { TurnBody } from './TurnBody';
import { ArtifactPane } from './ArtifactPane';
import { RecordedArtifacts, type RecordedSource } from './RecordedArtifacts';
import { useArtifactSelection, useArtifactWidth } from './artifact-panel';
import type { SaveOutcome } from './artifact-save';
import { turnKeyOf, type ArtifactRecord } from './artifacts';
import {
  ALL_PROJECTS,
  canSend,
  conversationAgents,
  instrumentLine,
  keyIntent,
  paragraphs,
  scopeFromSpineId,
  newestExchange,
  selectedSpineId,
  visibleResults,
  type DiomedesResult,
  type OutcomeCard,
} from './diomedes-view';
import './console.css';
import './artifacts.css';
import './nectovia.css';
import './everything.css';
import './diomedes.css';

export type { DiomedesResult };

export interface DiomedesPageProps {
  /** Never contains the reserved home Project. The caller filters it. */
  projects: Project[];
  /** null is "All projects": the home conversation. A project id is that project's own conversation. */
  scopeId: string | null;
  onScope(id: string | null): void;
  turns: Turn[];
  pending: boolean;
  /**
   * The answer to the message in flight as it streams, with its tool calls. Display only; the
   * recorded answer replaces it. Null while nothing has started.
   */
  live?: { text: string; activity: readonly ToolLine[]; thinking?: LiveThinking | null } | null;
  /** The Technical detail level: tool calls also name their tool and open to their detail. */
  technical?: boolean;
  /** The conversation's Agent (DIO-292): Auto, or one that answers here. */
  agent: string;
  onAgent(next: string): void;
  /** Resolves false when the message was refused and never sent, so the text is given back. */
  onSend(text: string): Promise<boolean>;
  onStop(): void;
  /**
   * The route this conversation's messages take without a tier: the thread's recorded engine,
   * or the default a first send takes. There is no Route control: a customer chooses a tier,
   * never a route (owner decision 2026-09-23).
   */
  route: Route;
  /** The model the route answers on, as its owner names it, for the caption (Nectovia's published label). */
  routeModel?: string | null;
  /**
   * The thread's WorkStyle, null to follow the Settings default, or undefined while there is no
   * thread to write a choice to (the Style control is then not shown).
   */
  workStyle?: WorkStyle | null;
  onWorkStyle?(next: WorkStyle | null): void;
  /** Optional local profile controls, using the same conversation and model selection as Work. */
  modelControls?: ReactNode;
  /** Why the conversation cannot run here, in plain words, or null when it can. */
  unavailable: string | null;
  /** What the last message led to, beyond its answer. Null when the answer is all there is. */
  card: OutcomeCard | null;
  cardBusy: boolean;
  onCardAction(): void;
  /** A message this conversation sent and never had confirmed, offered back, or null. */
  unconfirmed: string | null;
  onResend(): void;
  onDiscard(): void;
  /** One plain sentence about the last thing that went wrong, or null. */
  notice: string | null;
  /** True when the notice is a refusal that sharing earlier messages answers: it carries the button. */
  noticeSharesHistory?: boolean;
  /** Signing in answers the notice: it carries a Sign in button that opens the sign-in. */
  onNoticeSignIn?: (() => void) | null;
  /**
   * One plain line near the composer while this conversation's earlier messages are not shared
   * with the route its next message takes, or null. Information, not a failure.
   */
  history?: string | null;
  /** Opens the control that shares earlier messages, from the line or the refusal. */
  onShareHistory?(): void;
  /** Reads the conversation again after a read of it failed. Null when no read is owed. */
  onReadAgain: (() => void) | null;
  results: DiomedesResult[];
  onOpenResult(id: string): void;
  destinations: EverythingItem[];
  pinned: string[];
  groups?: { heading: string; ids: string[] }[];
  onDestination(id: string): void;
  onTogglePin(id: string): void;
  onNewProject(): void;
  /** The conversation's thread, which names its artifacts. Null until the thread exists. */
  artifactScope?: string | null;
  /** Saves an artifact into the scoped project's Files. Absent on All projects, which has no folder. */
  onSaveArtifact?(record: ArtifactRecord): Promise<SaveOutcome>;
  /** The free-version notice, above the conversation, while the host says to show it. */
  plan?: ReactNode;
  /** The progress report that opens the conversation, when the scheme draws one. */
  brief?: ReactNode;
  /** The page's art, beside the conversation, when the scheme draws it. */
  art?: ReactNode;
  /** The conversation's "···" menu (ThreadMenu.tsx), at the end of the head, once there is a thread. */
  menu?: ReactNode;
  /** Where the conversation's recorded artifacts are read from, for the artifact panel. */
  recorded?: RecordedSource | null;
  /** H03: what the thread's open native session offers (NativeSessionControls.tsx), above the composer. */
  session?: ReactNode;
  /** Who is working in the scoped project now (WorkerRows.tsx, compact), above the composer. */
  workers?: ReactNode;
  /** The rail's job groups for the scope (home-rail.ts), drawn in place of a project list. */
  sections?: RailSection[];
  /** Opens one job row from the rail. */
  onOpenRow?(id: string): void;
  /** The conversation's pinned chart (PinnedChartView), above the ask box, when there is one. */
  chart?: ReactNode;
  /** "Nectovia suggests" (Suggestions.tsx), beside the conversation, when a run proposed something. */
  suggestions?: ReactNode;
  /**
   * The ask box's row (AskRow.tsx) under the message line: engine, then model or tier. It takes
   * the Style box's place, so the tier is chosen once.
   */
  askRow?: ReactNode;
}

/** The one control the history line and a refusal for want of history both carry. */
const SHARE_HISTORY = 'Share earlier messages';

/** Why Save is not offered on the All projects conversation. */
export const SAVE_NEEDS_PROJECT =
  'This conversation is about all projects, so it has no folder to save into. Copy the source, or save from a project conversation.';


/** The ledger's point colour per result state, the same vocabulary
 *  console.css's `.pt` already speaks everywhere else in the Console. */
const POINT_FOR: Record<DiomedesResult['state'], string> = {
  done: 'done',
  running: 'live',
  'needs-you': 'attn',
  failed: 'fail',
};

/**
 * A conversation route as a person reads it. The name is the route's own: the caption never
 * substitutes another engine for the one the thread is actually on.
 */
export function routeName(route: Route, model?: string | null): string {
  if (route === 'aws-bedrock') return `${routeDisplayName(route)} (Luna)`;
  // Nectovia's model is the one the account service publishes, named as it names it.
  if (route === 'nectovia' && model) return `${routeDisplayName(route)} (${model})`;
  return routeDisplayName(route);
}

/**
 * The primary Diomedes page: the app opens here, to a conversation rather
 * than a project chooser. It is the Console's three regions (docs/
 * implementation/2026-09-20-console-design-language.md): the rail lists
 * projects on the same spine a thread rail lists threads on, with "All
 * projects" as its own reserved first row; the work column is one
 * conversation with Diomedes, scoped by the rail's point and the composer's
 * own "In" field; the ledger reads across whatever is scoped, one section,
 * Recent results.
 *
 * Props only: this page never fetches and never mints identity. Every
 * decision about what the screen shows comes from `diomedes-view.ts`; this
 * component only turns those answers into markup.
 */
export function Diomedes({
  projects,
  scopeId,
  onScope,
  turns,
  pending,
  live = null,
  technical = false,
  agent,
  onAgent,
  onSend,
  onStop,
  route,
  routeModel = null,
  workStyle,
  onWorkStyle,
  modelControls,
  unavailable,
  card,
  cardBusy,
  onCardAction,
  unconfirmed,
  onResend,
  onDiscard,
  notice,
  noticeSharesHistory = false,
  onNoticeSignIn = null,
  history = null,
  onShareHistory,
  onReadAgain,
  results,
  onOpenResult,
  destinations,
  pinned,
  groups,
  onDestination,
  onTogglePin,
  onNewProject,
  artifactScope = null,
  onSaveArtifact,
  plan,
  brief,
  art,
  menu = null,
  recorded = null,
  session = null,
  workers = null,
  sections = [],
  onOpenRow,
  chart = null,
  suggestions = null,
  askRow = null,
}: DiomedesPageProps) {
  const [text, setText] = useState('');
  // The home shows the newest exchange under the ask box; Earlier opens the whole conversation.
  // A new scope starts folded again.
  const [showEarlier, setShowEarlier] = useState(false);
  const [foldedFor, setFoldedFor] = useState(scopeId);
  if (foldedFor !== scopeId) {
    setFoldedFor(scopeId);
    setShowEarlier(false);
  }
  const earlier = newestExchange(turns);
  const shownFrom = showEarlier ? 0 : earlier;
  // Only a message in flight streams, and what streamed is shown under it. The waiting line
  // stays until text arrives, stepping aside while a tool call is already saying what it does.
  const streamed = pending ? live : null;
  const waiting = pending && !streamed?.text && !toolRunning(streamed?.activity) && !streamed?.thinking?.text;
  // The engine's thinking on the answer on its way; a lost stream shows none.
  const liveThinking =
    streamed?.thinking && streamed.thinking.position !== 'lost' && streamed.thinking.text ? streamed.thinking : null;
  const pendingWord = useWorkingWord('thinking it over', waiting);
  // The artifact panel: this page has no third column, so it opens over the page.
  const artifacts = useArtifactSelection(scopeId, artifactScope, turns);
  const [artifactWidth, setArtifactWidth] = useArtifactWidth();
  // One unconfirmed message at a time: it is resolved before anything new is sent.
  const blocked = unconfirmed !== null ? 'An earlier message is waiting.' : unavailable;
  const ready = canSend(text, pending, blocked);
  // The Agent the select shows, with its one line under the box.
  const chosen = conversationAgents().find((item) => item.id === agent) ?? conversationAgents()[0];
  const submit = () => {
    if (!canSend(text, pending, blocked)) return;
    const sending = text;
    setText('');
    // A refused message was never sent. It goes back in the box, unless the person has
    // already started typing something else.
    void onSend(sending).then((sent) => {
      if (!sent) setText((now) => now || sending);
    });
  };

  const visible = visibleResults(results);
  // The scope control shows this name in a fixed-width box: the title carries the full name
  // past whatever the ellipsis cuts.
  const scopeName = scopeId === null ? 'All projects' : (projects.find((p) => p.id === scopeId)?.name ?? 'All projects');

  return (
    <div className="console diomedes">
      <div
        className={`stage${artifacts.record ? ' art-open' : ''}`}
        style={artifacts.record ? ({ '--art-w': `${artifactWidth}px` } as CSSProperties) : undefined}
      >
        <Rail
          title="Conversations"
          navLabel="Conversations and destinations"
          newLabel="New project"
          top={
            showsScope(projects) ? (
              // One line at the top of the rail, drawn only for a business with more than one
              // project. The standing conversation and the groups below follow it.
              <label className="rail-scope">
                <select
                  aria-label="Project"
                  title={scopeName}
                  value={selectedSpineId(scopeId)}
                  onChange={(e) => onScope(scopeFromSpineId(e.target.value))}
                >
                  <option value={ALL_PROJECTS}>All projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id} title={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : undefined
          }
          items={[]}
          sections={sections}
          onOpenRow={onOpenRow}
          selectedId={null}
          onSelect={() => undefined}
          onNew={onNewProject}
          destinations={destinations}
          pinned={pinned}
          groups={groups}
          onDestination={onDestination}
          onTogglePin={onTogglePin}
        />

        {/* One named landmark, not two: a labelled section is a region, and a
            region and the main inside it answering to the same name reads as
            two places to a screen reader. */}
        <section className="screen on dio-screen">
          {art}
          <main className="work" aria-label={AGENT_NAME}>
            <div className="col head">
              <h1>{AGENT_NAME}</h1>
              {menu}
            </div>
            <div className="col instr" aria-label="This conversation">
              <span>{instrumentLine(scopeId, projects, chosen.name)}</span>
              {/* A tier decides the route and the model (owner decision 2026-09-23), so a
                  thread on a tier is named by its tier; the route shows only without one. */}
              <span className="dio-route">{workStyle ? WORK_STYLE_LABELS[workStyle] : routeName(route, routeModel)}</span>
            </div>

            <div className="transcript">
              <div className="col">
                {plan}
                {brief}
                {chart}
                <div className="dio-ask">
                  {notice !== null && (
                    <p className="dio-notice" role="alert">
                      {notice}
                      {noticeSharesHistory && onShareHistory && (
                        <button type="button" className="send" onClick={onShareHistory}>
                          {SHARE_HISTORY}
                        </button>
                      )}
                      {onNoticeSignIn && (
                        <button type="button" className="send" onClick={onNoticeSignIn}>
                          Sign in
                        </button>
                      )}
                    </p>
                  )}
                  {/* A status, not an alert: nothing went wrong, and the person may never ask a
                      follow-up. Not a `.turn` either: the transcript stays what the record holds. */}
                  {history !== null && (
                    <div className="dio-history" role="status">
                      <p>{history}</p>
                      {onShareHistory && (
                        <button type="button" className="send" onClick={onShareHistory}>
                          {SHARE_HISTORY}
                        </button>
                      )}
                    </div>
                  )}
                  {onReadAgain !== null && (
                    <div className="dio-reread">
                      <button type="button" className="send" onClick={onReadAgain}>
                        Read again
                      </button>
                    </div>
                  )}
                  {unconfirmed !== null && !pending && (
                    <div className="dio-unconfirmed" role="group" aria-label="A message that was not confirmed">
                      <p>
                        Nectovia could not confirm your last message. Sending it again checks what
                        happened and never asks twice.
                      </p>
                      <p className="dio-quote" title={unconfirmed}>
                        {unconfirmed}
                      </p>
                      <div className="dio-row">
                        <button type="button" className="send ready" onClick={onResend}>
                          Send again
                        </button>
                        <button type="button" className="send" onClick={onDiscard}>
                          Discard
                        </button>
                      </div>
                    </div>
                  )}
                  {workers}
                  {session}
                  {modelControls}
                  {unavailable !== null ? (
                    <p className="composer dio-unavailable">{unavailable}</p>
                  ) : (
                    <div className={`composer${turns.length === 0 ? ' quiet' : ''}${pending ? ' busy' : ''}`}>
                      <textarea
                        rows={turns.length === 0 ? 3 : 1}
                        aria-label={`Message ${AGENT_NAME}`}
                        placeholder={`Ask a question or give ${AGENT_NAME} something to do.`}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                          const intent = keyIntent({
                            key: e.key,
                            shiftKey: e.shiftKey,
                            isComposing: e.nativeEvent.isComposing,
                          });
                          if (intent === 'send') {
                            e.preventDefault();
                            submit();
                          }
                        }}
                      />
                      {askRow}
                      <div className="bar">
                        <label className="dio-field">
                          <span>Agent</span>
                          <select
                            aria-label="Agent"
                            value={chosen.id}
                            disabled={pending}
                            onChange={(e) => onAgent(e.target.value)}
                          >
                            {conversationAgents().map((item) => (
                              <option key={item.id} value={item.id} title={item.line}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {!askRow && workStyle !== undefined && onWorkStyle && (
                          <label className="dio-field">
                            <span>Style</span>
                            <select
                              aria-label="Style"
                              value={workStyle ?? ''}
                              title={workStyle ? WORK_STYLE_DESCRIPTIONS[workStyle] : 'Follows the default in Settings'}
                              disabled={pending}
                              onChange={(e) =>
                                onWorkStyle(isWorkStyle(e.target.value) ? e.target.value : null)
                              }
                            >
                              <option value="">Default</option>
                              {WORK_STYLES.map((style) => (
                                <option key={style} value={style} title={WORK_STYLE_DESCRIPTIONS[style]}>
                                  {WORK_STYLE_LABELS[style]}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <span className="cap">{chosen.line}</span>
                        {pending ? (
                          <button type="button" className="send ready" onClick={onStop}>
                            Stop
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={`send${ready ? ' ready' : ''}`}
                            aria-disabled={!ready || undefined}
                            onClick={() => {
                              if (ready) submit();
                            }}
                          >
                            Send
                          </button>
                        )}
                        <span className="hint" aria-hidden="true">
                          Enter
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                {earlier > 0 && !showEarlier && (
                  <button type="button" className="dio-earlier" onClick={() => setShowEarlier(true)}>
                    Earlier
                  </button>
                )}
                {turns.map((turn, index) => index < shownFrom ? null : (
                  <div className={`turn ${turn.role === 'you' ? 'you' : 'dio'}`} key={turn.id}>
                    <div className="who">
                      <b>{speakerName(turn.role)}</b>
                    </div>
                    <div className="body">
                      {turn.role === 'you' ? (
                        paragraphs(turn.text).map((p, i) => <p key={i}>{p}</p>)
                      ) : (
                        <>
                          {turn.thinking && (
                            <Thinking text={turn.thinking.text} ms={turn.thinking.ms} shortened={turn.thinking.shortened} />
                          )}
                          <TurnBody
                            text={turn.text}
                            artifactAt={(block) => artifacts.index.forBlock(turnKeyOf(turn, index), block)}
                            onOpenArtifact={artifacts.open}
                            openKey={artifacts.openKey}
                          />
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {card && !pending && (
                  <div className={`dio-card ${card.tone}`} role="group" aria-label={card.title}>
                    <b>{card.title}</b>
                    <p>{card.body}</p>
                    {card.action && (
                      <button
                        type="button"
                        className="send ready"
                        aria-disabled={cardBusy || undefined}
                        onClick={() => {
                          if (!cardBusy) onCardAction();
                        }}
                      >
                        {cardBusy ? 'Starting' : card.action.label}
                      </button>
                    )}
                  </div>
                )}
                {/* Not a `.turn`: it is a preview of an answer, not a recorded one, and the
                    transcript's turns stay exactly what the record holds. */}
                {streamed && (streamed.text || streamed.activity.length > 0 || liveThinking) && (
                  <div className="dio-live">
                    <div className="who">
                      <b>{speakerName('diomedes')}</b>
                    </div>
                    {liveThinking && (
                      <Thinking
                        text={liveThinking.text}
                        ms={liveThinking.endedAt === null ? null : liveThinking.endedAt - liveThinking.since}
                        live
                      />
                    )}
                    <ToolActivityList lines={streamed.activity} technical={technical} />
                    {streamed.text && (
                      <div className="body">
                        <TurnBody text={streamed.text} preview />
                      </div>
                    )}
                  </div>
                )}
                {pending && (
                  <p className="mono dio-pending" role="status" aria-label="Working" hidden={!waiting}>
                    <span aria-hidden="true">{workingLine(pendingWord)}</span>
                  </p>
                )}
              </div>
            </div>
          </main>

          <aside className="ledger" aria-label="Suggestions and results">
            {suggestions}
            {visible.length > 0 && (
              <>
                <h2>Recent results</h2>
                <ul>
                  {visible.map((r) => (
                    <li key={r.id}>
                      <span className={`pt ${POINT_FOR[r.state]}`} aria-hidden="true" />
                      <button
                        type="button"
                        className="dio-result"
                        title={r.title}
                        onClick={() => onOpenResult(r.id)}
                      >
                        {r.title}
                      </button>
                      <span className="mono">{r.when}</span>
                      <span className="sub" title={r.projectName}>
                        {r.projectName}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </section>
        {artifacts.record && (
          <ArtifactPane
            overlay
            record={artifacts.record}
            index={artifacts.source}
            arrived={artifacts.arrived}
            focusToken={artifacts.focusToken}
            width={artifactWidth}
            onWidth={setArtifactWidth}
            onSelect={artifacts.select}
            onClose={artifacts.close}
            onSave={onSaveArtifact}
            saveUnavailable={SAVE_NEEDS_PROJECT}
            recorded={
              recorded ? (
                <RecordedArtifacts
                  source={recorded}
                  index={artifacts.index}
                  turns={turns}
                  current={artifacts.record.key}
                  onOpen={(next) => artifacts.open(next)}
                />
              ) : null
            }
          />
        )}
      </div>
    </div>
  );
}
