import { useState } from 'react';
import type { Project, Turn } from '../../shared/types';
import type { EverythingItem } from './Everything';
import { Rail } from './Rail';
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
  restriction: Restriction;
  onRestriction(next: Restriction): void;
  onSend(text: string): void;
  onStop(): void;
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
  results: DiomedesResult[];
  onOpenResult(id: string): void;
  destinations: EverythingItem[];
  pinned: string[];
  groups?: { heading: string; ids: string[] }[];
  onDestination(id: string): void;
  onTogglePin(id: string): void;
  onNewProject(): void;
}

/** What the chosen restriction promises, in the composer's own caption line
 *  (the pattern `client/console/Composer.tsx`'s CAPS already uses). Never
 *  exported: it is wording, not a decision the view-model owns. */
const CAPS: Record<Restriction, string> = {
  automatic: 'Diomedes decides whether to answer, plan or start work. It starts only what you have allowed.',
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
  restriction,
  onRestriction,
  onSend,
  onStop,
  unavailable,
  card,
  cardBusy,
  onCardAction,
  unconfirmed,
  onResend,
  onDiscard,
  notice,
  results,
  onOpenResult,
  destinations,
  pinned,
  groups,
  onDestination,
  onTogglePin,
  onNewProject,
}: DiomedesPageProps) {
  const [text, setText] = useState('');
  // One unconfirmed message at a time: it is resolved before anything new is sent.
  const blocked = unconfirmed !== null ? 'An earlier message is waiting.' : unavailable;
  const ready = canSend(text, pending, blocked);
  const submit = () => {
    if (!canSend(text, pending, blocked)) return;
    onSend(text);
    setText('');
  };

  const spine = spineItems(projects, Date.now());
  const visible = visibleResults(results);
  // The "In" select shows this name in a fixed-width box (decision 5): the
  // title carries the full name past whatever the ellipsis cuts.
  const scopeName = scopeId === null ? 'All projects' : (projects.find((p) => p.id === scopeId)?.name ?? 'All projects');

  return (
    <div className="console diomedes">
      <div className="stage">
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
          <main className="work" aria-label="Diomedes">
            <div className="col head">
              <h1>Diomedes</h1>
            </div>
            <div className="col instr" aria-label="This conversation">
              <span>{instrumentLine(scopeId, projects, restriction)}</span>
            </div>

            <div className="transcript">
              <div className="col">
                {turns.map((turn) => (
                  <div className={`turn ${turn.role === 'you' ? 'you' : 'dio'}`} key={turn.id}>
                    <div className="who">
                      <b>{turn.role === 'you' ? 'You' : 'Diomedes'}</b>
                    </div>
                    <div className="body">
                      {paragraphs(turn.text).map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
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
                {pending && (
                  <p className="mono dio-pending" role="status">
                    Working
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
              {unconfirmed !== null && !pending && (
                <div className="dio-unconfirmed" role="group" aria-label="A message that was not confirmed">
                  <p>
                    Diomedes could not confirm your last message. Sending it again checks what
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
                <div className={`composer${turns.length === 0 ? ' quiet' : ''}`}>
                  <textarea
                    rows={turns.length === 0 ? 3 : 1}
                    aria-label="Message Diomedes"
                    placeholder="Ask a question or give Diomedes something to do."
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
      </div>
    </div>
  );
}
