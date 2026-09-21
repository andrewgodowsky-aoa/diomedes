/**
 * The preview: the real interface, over invented data, behind glass.
 *
 * Every piece below is the component the app actually ships — `Button`,
 * `Modal`, `Mark`, `Notice`, `UsageBar`, `Empty`, `ChangeCard` from
 * `client/components.tsx`, and the Console's own `.service`, `.rail`, `.row`
 * and `.change-card` markup. A miniature drawn to look like the app would
 * agree with the theme and disagree with the product, and the first person to
 * find out would be someone who had already shipped a theme.
 *
 * Two things make that safe:
 *
 * - **The data is fiction.** Everything comes from `fixtures.ts`.
 * - **Design mode swallows the action.** The stage takes clicks and keys in the
 *   capture phase, selects the piece under the pointer and stops the event
 *   before React delivers it to the component's own handler. Every fixture
 *   callback appends to a visible log, so "the action did not fire" is a thing
 *   the screen states and a test can read, rather than an absence someone hopes
 *   is meaningful.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import {
  Button,
  ChangeCard,
  Empty,
  Mark,
  Modal,
  Notice,
  UsageBar,
  time,
} from '../../components';
import { resolveAppearance } from '../../../shared/theme-pack/resolve';
import type { ThemePackV1 } from '../../../shared/theme-pack/types';
import { ArtworkImage, TextureLayer } from '../theme-artwork';
import { ARTWORK_SLOT_LABELS } from './pack';
import { clearPreview, paintPreview } from './preview-paint';
import {
  fixtureChange,
  fixtureDocument,
  fixtureEngine,
  fixtureLowWindow,
  fixtureModels,
  fixtureNeed,
  fixtureTasks,
  fixtureThreads,
  fixtureTurns,
  fixtureUsage,
  fixtureWindow,
} from './fixtures';

export type PreviewMode = 'design' | 'interact';

export interface PreviewPiece {
  id: string;
  group: string;
  name: string;
  /** One sentence the inspector shows when this piece is selected. */
  about: string;
}

/** The navigator's contents, and the order the stage lays them out in. */
export const PREVIEW_PIECES: readonly PreviewPiece[] = [
  {
    id: 'buttons',
    group: 'Controls',
    name: 'Buttons',
    about: 'Every tone and state a button takes, in the app’s own Button component.',
  },
  {
    id: 'model-picker',
    group: 'Controls',
    name: 'Model picker row',
    about: 'The row that chooses an engine’s default model and reasoning level.',
  },
  {
    id: 'marks',
    group: 'Controls',
    name: 'State marks',
    about: 'The four small marks that carry a task’s state everywhere it appears.',
  },
  {
    id: 'rail',
    group: 'Navigation',
    name: 'Navigation rail',
    about: 'The Console’s thread rail, its view switch and its foot.',
  },
  {
    id: 'engines-card',
    group: 'Cards',
    name: 'Engines card',
    about: 'The Settings > Engines card body, with its usage bars and actions.',
  },
  {
    id: 'notice',
    group: 'Cards',
    name: 'Needs your OK',
    about: 'The approval notice, exactly as a real proposal renders it.',
  },
  {
    id: 'review-card',
    group: 'Cards',
    name: 'Review card',
    about: 'The change card a review shows, with its added and removed lines.',
  },
  {
    id: 'modal',
    group: 'Cards',
    name: 'Dialog',
    about: 'A dialog, rendered in place so it does not cover the editor.',
  },
  {
    id: 'conversation',
    group: 'Content',
    name: 'Conversation',
    about: 'Two turns of a thread: the interface face and the reading face together.',
  },
  {
    id: 'document',
    group: 'Content',
    name: 'Document',
    about: 'A document excerpt, set in the reading face at the reading size.',
  },
  {
    id: 'tasks',
    group: 'Content',
    name: 'Task states',
    about: 'One row per task state, so every mark colour is visible at once.',
  },
  {
    id: 'usage',
    group: 'Content',
    name: 'Usage bars',
    about: 'A comfortable allowance and one that is nearly spent.',
  },
  {
    id: 'error-state',
    group: 'States',
    name: 'Something failed',
    about: 'The failure colour, in the shape a person actually meets it.',
  },
  {
    id: 'empty-state',
    group: 'States',
    name: 'Nothing here yet',
    about: 'The empty state, which carries more of a theme than most screens.',
  },
  {
    id: 'artwork',
    group: 'States',
    name: 'Pictures',
    about: 'The pictures this theme places, each in its own slot, at its own opacity.',
  },
];

/** By id, so the stage cannot drift out of step with the list's order. */
const PIECE: Record<string, PreviewPiece> = Object.fromEntries(
  PREVIEW_PIECES.map((piece) => [piece.id, piece]),
);

export const PREVIEW_GROUPS = [...new Set(PREVIEW_PIECES.map((piece) => piece.group))];

function Piece({
  piece,
  selectedId,
  children,
}: {
  piece: PreviewPiece;
  selectedId: string | null;
  children: ReactNode;
}) {
  return (
    <section
      className={`dc-piece ${selectedId === piece.id ? 'selected' : ''}`}
      data-dc-piece={piece.id}
      aria-label={piece.name}
    >
      <h3 className="dc-piece-name">{piece.name}</h3>
      <div className="dc-piece-body">{children}</div>
    </section>
  );
}

export function Preview({
  pack,
  mode,
  reducedMotion,
  selectedId,
  onSelect,
  onFixtureAction,
}: {
  pack: ThemePackV1;
  mode: PreviewMode;
  /** The reduced-motion preview toggle, applied to the stage only. */
  reducedMotion: boolean;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onFixtureAction(what: string): void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    paintPreview(
      element,
      resolveAppearance({
        surface: 'app-console',
        theme: pack,
        accessibility: { reducedMotion },
      }),
    );
  }, [pack, reducedMotion]);
  useEffect(() => {
    const element = stage.current;
    return () => {
      if (element) clearPreview(element);
    };
  }, []);

  /**
   * Design mode: select, and stop the event where it is.
   *
   * React delivers capture-phase handlers before the target's own `onClick`,
   * and `stopPropagation` on the synthetic event prevents the rest of that
   * dispatch — including the child's handler. Keys are caught the same way, so
   * a button reached with the keyboard is selected rather than pressed.
   */
  const intercept = (event: React.SyntheticEvent) => {
    if (mode !== 'design') return;
    const target = event.target as HTMLElement | null;
    const piece = target?.closest?.('[data-dc-piece]');
    onSelect(piece instanceof HTMLElement ? (piece.dataset.dcPiece ?? null) : null);
    event.stopPropagation();
    event.preventDefault();
  };

  const act = (what: string) => () => onFixtureAction(what);

  return (
    <div
      ref={stage}
      className="dc-stage"
      data-mode={mode}
      onClickCapture={intercept}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' || event.key === ' ') intercept(event);
      }}
      onSubmitCapture={intercept}
      onChangeCapture={intercept}
    >
      {/* Decorative, and underneath. The stage is a stacking context
          (design-center.css), so this paints above the stage's own surface
          colour and below every piece in it — the same arrangement the running
          app uses, which is the point of previewing it at all. */}
      <TextureLayer themeId={pack.id} pack={pack} />

      <Piece piece={PIECE['artwork']} selectedId={selectedId}>
        {Object.keys(pack.artwork).length === 0 ? (
          <p className="caption" data-dc-artwork-preview="empty">
            This theme places no pictures. Choose one in Pictures, on the right.
          </p>
        ) : (
          <div className="dc-row dc-art-slots">
            {(['logo', 'bust', 'emptyState'] as const).map((slot) =>
              pack.artwork[slot] ? (
                <figure key={slot} className="dc-art-slot" data-dc-artwork-slot={slot}>
                  <ArtworkImage themeId={pack.id} pack={pack} slot={slot} />
                  <figcaption className="caption">{ARTWORK_SLOT_LABELS[slot]}</figcaption>
                </figure>
              ) : null,
            )}
            {pack.artwork.texture && (
              <p className="caption" data-dc-artwork-slot="texture">
                The background texture is behind this whole stage, not in a box of its own.
              </p>
            )}
          </div>
        )}
      </Piece>

      <Piece piece={PIECE['buttons']} selectedId={selectedId}>
        <div className="dc-row">
          <Button onClick={act('Primary button')}>Primary</Button>
          <Button tone="primary" onClick={act('Emphasised button')}>
            Start work
          </Button>
          <Button tone="signal" onClick={act('Signal button')}>
            Needs you
          </Button>
          <Button tone="quiet" onClick={act('Quiet button')}>
            Quiet
          </Button>
          <Button tone="selected" onClick={act('Selected button')}>
            Selected
          </Button>
        </div>
        <div className="dc-row">
          <Button disabled onClick={act('Disabled button')}>
            Disabled
          </Button>
          <Button aria-busy="true" onClick={act('Working button')}>
            Working…
          </Button>
          {/* The focus ring is a live browser state, so this one holds focus
              rather than pretending to: it is the ring the theme will draw. */}
          <FocusedButton onAct={act('Focused button')} />
          {/* Hover cannot be forced from React without faking the style, and a
              faked hover is not the hover. This one is labelled for the pointer. */}
          <Button onClick={act('Hover button')}>Hover me</Button>
        </div>
      </Piece>

      <Piece piece={PIECE['model-picker']} selectedId={selectedId}>
        <div className="row choice-row">
          <span className="caption">Default</span>
          <select aria-label="Default choice" defaultValue={fixtureModels[0].slug}>
            {fixtureModels.map((model) => (
              <option key={model.slug} value={model.slug}>
                {model.name}
              </option>
            ))}
          </select>
          <select aria-label="Default reasoning level" defaultValue="Medium">
            {fixtureModels[0].efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </div>
      </Piece>

      <Piece piece={PIECE['marks']} selectedId={selectedId}>
        <div className="dc-row">
          {(['todo', 'working', 'waiting', 'done'] as const).map((state) => (
            <span className="dc-mark" key={state}>
              <Mark state={state} />
              {state}
            </span>
          ))}
        </div>
      </Piece>

      <Piece piece={PIECE['rail']} selectedId={selectedId}>
        <nav className="rail dc-rail" aria-label="Threads and views (example)">
          <div className="rail-head">
            <h2>Threads</h2>
            <button type="button" onClick={act('New thread')}>
              New
            </button>
          </div>
          <ul className="spine console-threads">
            {fixtureThreads.map((thread, index) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className={`console-thread ${index === 0 ? 'on' : ''}`}
                  onClick={act(`Open ${thread.name}`)}
                >
                  <span className="tick" />
                  <span className="row">
                    <span className="nm">{thread.name}</span>
                    <span className="mono lc when">{thread.time}</span>
                  </span>
                  <small>{thread.sub}</small>
                </button>
              </li>
            ))}
          </ul>
          <div className="views">
            {['Thread', 'Board', 'Team'].map((view, index) => (
              <button
                key={view}
                type="button"
                className={index === 0 ? 'on' : ''}
                onClick={act(`Switch to ${view}`)}
              >
                {view}
              </button>
            ))}
          </div>
        </nav>
      </Piece>

      <Piece piece={PIECE['engines-card']} selectedId={selectedId}>
        <div className="service-list">
          <section className="service">
            <div className="row">
              <h3>
                <Mark state="done" />
                {fixtureEngine.name}
              </h3>
              <span className="caption push-right">{fixtureEngine.status}</span>
            </div>
            <p>{fixtureEngine.detail}</p>
            <div className="usage-block">
              <div className="usage-row">
                <span>{fixtureWindow.label}</span>
                <UsageBar window={fixtureWindow} />
                <span>{100 - fixtureWindow.usedPercent}% left</span>
              </div>
              <p className="caption">{fixtureUsage.detail}</p>
            </div>
            <p className="code caption">
              {fixtureEngine.installedVersion}
              <br />
              {fixtureEngine.location}
              <br />
              {fixtureEngine.capabilities.join(', ')}
            </p>
            <div className="actions">
              <label className="switch">
                <input type="checkbox" defaultChecked onChange={act('Engine switch')} />
                On
              </label>
              <Button tone="quiet" onClick={act('What is sent')}>
                What is sent
              </Button>
            </div>
          </section>
        </div>
      </Piece>

      <Piece piece={PIECE['notice']} selectedId={selectedId}>
        <Notice
          need={fixtureNeed}
          decide={(resolution) => onFixtureAction(`Approval ${resolution}`)}
          show={act('Show the proposal')}
        />
      </Piece>

      <Piece piece={PIECE['review-card']} selectedId={selectedId}>
        <ChangeCard change={fixtureChange} detail="technical">
          <Button tone="primary" onClick={act('Keep the change')}>
            Keep
          </Button>
          {/* "Undo this change", not "Undo": the toolbar above the stage has an
              Undo of its own, and two buttons with one name in one screen is a
              thing a person reading aloud cannot tell apart. */}
          <Button tone="quiet" onClick={act('Undo the change')}>
            Undo this change
          </Button>
        </ChangeCard>
      </Piece>

      <Piece piece={PIECE['modal']} selectedId={selectedId}>
        <Modal inline title="An example dialog" onClose={act('Close the dialog')}>
          <p className="prose">
            A dialog carries the raised surface, the separator and the control radius all at once,
            which is why it is worth looking at while choosing them.
          </p>
          <div className="actions">
            <Button tone="primary" onClick={act('Dialog confirm')}>
              Do it
            </Button>
            <Button tone="quiet" onClick={act('Dialog cancel')}>
              Not now
            </Button>
          </div>
        </Modal>
      </Piece>

      <Piece piece={PIECE['conversation']} selectedId={selectedId}>
        <div className="dc-conversation">
          {fixtureTurns.map((turn) => (
            <article key={turn.id} className={`turn ${turn.role}`}>
              <header className="row">
                <strong>{turn.role === 'you' ? 'You' : 'Diomedes'}</strong>
                <span className="caption push-right">{time(turn.at)}</span>
              </header>
              <p className="prose">{turn.text}</p>
            </article>
          ))}
        </div>
      </Piece>

      <Piece piece={PIECE['document']} selectedId={selectedId}>
        <div className="dc-document">
          <p className="caption">{fixtureDocument.path}</p>
          <pre className="code">{fixtureDocument.excerpt}</pre>
        </div>
      </Piece>

      <Piece piece={PIECE['tasks']} selectedId={selectedId}>
        <ul className="dc-tasks">
          {fixtureTasks.map((task) => (
            <li key={task.id} className="row">
              <Mark state={task.state} />
              <span>{task.name}</span>
              <span className="caption push-right">{task.state}</span>
            </li>
          ))}
        </ul>
      </Piece>

      <Piece piece={PIECE['usage']} selectedId={selectedId}>
        <div className="usage-block">
          <div className="usage-row">
            <span>{fixtureWindow.label}</span>
            <UsageBar window={fixtureWindow} />
            <span>{100 - fixtureWindow.usedPercent}% left</span>
          </div>
          <div className="usage-row">
            <span>{fixtureLowWindow.label}</span>
            <UsageBar window={fixtureLowWindow} />
            <span>{100 - fixtureLowWindow.usedPercent}% left</span>
          </div>
        </div>
      </Piece>

      <Piece piece={PIECE['error-state']} selectedId={selectedId}>
        <p role="alert" className="fault-text">
          That did not work: the example service did not answer. Nothing was changed.
        </p>
        <div className="actions">
          <Button onClick={act('Try again')}>Try again</Button>
        </div>
      </Piece>

      <Piece piece={PIECE['empty-state']} selectedId={selectedId}>
        <Empty
          title="Nothing here yet"
          action={
            <Button tone="primary" onClick={act('Start something')}>
              Start something
            </Button>
          }
        >
          When there is work in this project, it shows up here.
        </Empty>
      </Piece>
    </div>
  );
}

/**
 * A button that holds focus, so the theme's focus ring is a thing on screen
 * rather than a swatch. `Button` takes no ref, so the wrapper finds it.
 */
function FocusedButton({ onAct }: { onAct: () => void }) {
  const holder = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // `preventScroll` so putting the ring on screen does not move the stage.
    holder.current?.querySelector('button')?.focus({ preventScroll: true });
  }, []);
  return (
    <span ref={holder} className="dc-focus-holder">
      <Button onClick={onAct}>Focused</Button>
    </span>
  );
}
