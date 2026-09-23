import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Project, Route, Turn } from '../../shared/types';
import { AGENT_NAME } from '../../shared/agent-name';
import { routeDisplayName } from '../../shared/engines';
import { WORK_STYLES, WORK_STYLE_DESCRIPTIONS, WORK_STYLE_LABELS, isWorkStyle, type WorkStyle } from '../../shared/work-style';
import { speakerName } from '../attribution-display';
import type { EverythingItem } from './Everything';
import { Rail } from './Rail';
import { useWorkingWord, workingLine } from './working-words';
import { toolRunning, type ToolLine } from './engine-activity';
import { ToolActivityList } from './ToolActivity';
import { TurnBody } from './TurnBody';
import { ArtifactPane } from './ArtifactPane';
import { useArtifactSelection, useArtifactWidth } from './artifact-panel';
import type { SaveOutcome } from './artifact-save';
import { turnKeyOf, type ArtifactRecord } from './artifacts';
import {
  ALL_PROJECTS,
  RESTRICTIONS,
  canSend,
  instrumentLine,
  keyIntent,
  paragraphs,
  scopeFromSpineId,
  selectedSpineId,
  spineItems,
  visibleResults,
  type DiomedesResult,
  type OutcomeCard,
  type Restriction,
} from './diomedes-view';
import './console.css';
import './artifacts.css';
import './nectovia.css';
import './everything.css';
import './diomedes.css';

export type { DiomedesResult, Restriction };

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
  live?: { text: string; activity: readonly ToolLine[] } | null;
  /** The Technical detail level: tool calls also name their tool and open to their detail. */
  technical?: boolean;
  restriction: Restriction;
  onRestriction(next: Restriction): void;
  /** Resolves false when the message was refused and never sent, so the text is given back. */
  onSend(text: string): Promise<boolean>;
  onStop(): void;
  /**
   * The route this conversation's messages take without a tier: the thread's recorded engine,
   * or the default a first send takes. There is no Route control: a customer chooses a tier,
   * never a route (owner decision 2026-09-23).
   */
  route: Route;
  /**
   * The thread's WorkStyle, null to follow the Settings default, or undefined while there is no
   * thread to write a choice to (the Style control is then not shown).
   */
  workStyle?: WorkStyle | null;
  onWorkStyle?(next: WorkStyle | null): void;
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
  /** The progress report that opens the conversation, when the scheme draws one. */
  brief?: ReactNode;
  /** The page's art, beside the conversation, when the scheme draws it. */
  art?: ReactNode;
}

/** Why Save is not offered on the All projects conversation. */
export const SAVE_NEEDS_PROJECT =
  'This conversation is about all projects, so it has no folder to save into. Copy the source, or save from a project conversation.';

/** What the chosen restriction promises, in the composer's own caption line
 *  (the pattern `client/console/Composer.tsx`'s CAPS already uses). Never
 *  exported: it is wording, not a decision the view-model owns. */
const CAPS: Record<Restriction, string> = {
  automatic: 'Nectovia decides whether to answer, plan or start work. It starts only what you have allowed.',
  'answer-only': 'Answers only. Nothing is planned or started.',
  'plan-only': 'Answers and writes a plan for you to read. Nothing is started.',
};

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
export function routeName(route: Route): string {
  if (route === 'aws-bedrock') return `${routeDisplayName(route)} (Luna)`;
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
  restriction,
  onRestriction,
  onSend,
  onStop,
  route,
  workStyle,
  onWorkStyle,
  unavailable,
  card,
  cardBusy,
  onCardAction,
  unconfirmed,
  onResend,
  onDiscard,
  notice,
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
  brief,
  art,
}: DiomedesPageProps) {
  const [text, setText] = useState('');
  // Only a message in flight streams, and what streamed is shown under it. The waiting line
  // stays until text arrives, stepping aside while a tool call is already saying what it does.
  const streamed = pending ? live : null;
  const waiting = pending && !streamed?.text && !toolRunning(streamed?.activity);
  const pendingWord = useWorkingWord('thinking it over', waiting);
  // The artifact panel: this page has no third column, so it opens over the page.
  const artifacts = useArtifactSelection(scopeId, artifactScope, turns);
  const [artifactWidth, setArtifactWidth] = useArtifactWidth();
  // One unconfirmed message at a time: it is resolved before anything new is sent.
  const blocked = unconfirmed !== null ? 'An earlier message is waiting.' : unavailable;
  const ready = canSend(text, pending, blocked);
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

  const spine = spineItems(projects, Date.now());
  const visible = visibleResults(results);
  // The "In" select shows this name in a fixed-width box (decision 5): the
  // title carries the full name past whatever the ellipsis cuts.
  const scopeName = scopeId === null ? 'All projects' : (projects.find((p) => p.id === scopeId)?.name ?? 'All projects');

  return (
    <div className="console diomedes">
      <div
        className={`stage${artifacts.record ? ' art-open' : ''}`}
        style={artifacts.record ? ({ '--art-w': `${artifactWidth}px` } as CSSProperties) : undefined}
      >
        <Rail
          title="Talking about"
          navLabel="Projects and destinations"
          items={spine}
          selectedId={selectedSpineId(scopeId)}
          onSelect={(id) => onScope(scopeFromSpineId(id))}
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
            </div>
            <div className="col instr" aria-label="This conversation">
              <span>{instrumentLine(scopeId, projects, restriction)}</span>
              {/* A tier decides the route and the model (owner decision 2026-09-23), so a
                  thread on a tier is named by its tier; the route shows only without one. */}
              <span className="dio-route">{workStyle ? WORK_STYLE_LABELS[workStyle] : routeName(route)}</span>
            </div>

            <div className="transcript">
              <div className="col">
                {brief}
                {turns.map((turn, index) => (
                  <div className={`turn ${turn.role === 'you' ? 'you' : 'dio'}`} key={turn.id}>
                    <div className="who">
                      <b>{speakerName(turn.role)}</b>
                    </div>
                    <div className="body">
                      {turn.role === 'you' ? (
                        paragraphs(turn.text).map((p, i) => <p key={i}>{p}</p>)
                      ) : (
                        <TurnBody
                          text={turn.text}
                          artifactAt={(block) => artifacts.index.forBlock(turnKeyOf(turn, index), block)}
                          onOpenArtifact={artifacts.open}
                          openKey={artifacts.openKey}
                        />
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
                {streamed && (streamed.text || streamed.activity.length > 0) && (
                  <div className="dio-live">
                    <div className="who">
                      <b>{speakerName('diomedes')}</b>
                    </div>
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

            <div className="col compose">
              {notice !== null && (
                <p className="dio-notice" role="alert">
                  {notice}
                </p>
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
                  <div className="bar">
                    <label className="dio-field">
                      <span>In</span>
                      <select
                        aria-label="In"
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
                    <label className="dio-field">
                      <span>Mode</span>
                      <select
                        aria-label="Mode"
                        value={restriction}
                        onChange={(e) => onRestriction(e.target.value as Restriction)}
                      >
                        {RESTRICTIONS.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {workStyle !== undefined && onWorkStyle && (
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
                    <span className="cap">{CAPS[restriction]}</span>
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
          </main>

          <aside className="ledger" aria-label="Recent results">
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
          />
        )}
      </div>
    </div>
  );
}
