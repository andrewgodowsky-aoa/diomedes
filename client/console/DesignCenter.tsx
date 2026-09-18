/**
 * The Design Center.
 *
 * One workspace: a target selector, a navigator, a preview and an inspector.
 * This file is the composition and the session tools; the navigator, the
 * preview harness with its fixtures, the inspector, the Studio session store
 * and the website panel each live in `design-center/`.
 *
 * What it does not do is as much of the design as what it does:
 *
 * - **It needs no AI and no internet.** Nothing here calls a provider, the
 *   managed gateway, or any host. The single outward request in the feature is
 *   the service's one-second loopback probe for the local Website Studio.
 * - **It changes nothing until Apply.** Undo, redo, reset and the before/after
 *   toggle move a pack in this screen. The running app's appearance changes
 *   when someone presses Apply, and at no other moment.
 * - **Autosave is not application.** The debounce writes a draft the service
 *   files separately and will not activate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import { resolveAppearance } from '../../shared/theme-pack/resolve';
import { importThemePackage, THEME_PACKAGE_EXTENSION } from '../../shared/theme-pack/package';
import type { BaseThemeId, ThemePackV1 } from '../../shared/theme-pack/types';
import { Button, Mark, Modal } from '../components';
import { schemeId } from './schemes';
import { Inspector } from './design-center/Inspector';
import { Navigator } from './design-center/Navigator';
import { Preview, PREVIEW_PIECES, type PreviewMode } from './design-center/Preview';
import { SIDEBAR_WIDTHS, packFromBaseTheme, themeIdFrom } from './design-center/pack';
import { packProblem, useStudioSession } from './design-center/session';
import {
  NO_CUSTOMIZATION,
  readCustomizationStatus,
  type CustomizationStatus,
} from './design-center/entitlement-api';
import {
  activateTheme,
  buildPackage,
  copyAssets,
  discardDraft,
  listThemes,
  readTheme,
  restoreAssets,
  restoreRevision,
  saveTheme,
  type ThemeSummary,
} from './design-center/themes-api';
import { WebsiteTarget } from './design-center/WebsiteTarget';
import './design-center.css';

type Target = 'app' | 'website';

const NEW_THEME_NAME = 'My theme';

/** Shown only if the service answered nothing at all; normally it says why. */
const CUSTOMIZATION_LOCKED =
  'Customization requires an active plan. You can look through this screen, and built-in themes, text size, contrast, reduced motion and reset keep working without one.';

export function DesignCenter({
  settings,
  onClose,
}: {
  settings: Settings;
  onClose(): void;
}) {
  const [target, setTarget] = useState<Target>('app');
  const [mode, setMode] = useState<PreviewMode>('design');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [revisions, setRevisions] = useState<number[]>([]);
  /** The stored revision this edit started from; 0 when nothing is stored yet. */
  const [savedRevision, setSavedRevision] = useState(0);
  const [starting, setStarting] = useState<ThemePackV1 | null>(null);
  const [problem, setProblem] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState('standard');
  const [reducedMotionPreview, setReducedMotionPreview] = useState(false);
  const [replay, setReplay] = useState(0);
  const importInput = useRef<HTMLInputElement>(null);
  /**
   * What the service says this person may do. Asked once on opening, never
   * computed here, and `NO_CUSTOMIZATION` until it answers so the first paint
   * is the conservative one rather than a control that vanishes a moment later.
   */
  const [rights, setRights] = useState<CustomizationStatus>(NO_CUSTOMIZATION);
  const canAuthor = rights.granted;

  useEffect(() => {
    let live = true;
    void readCustomizationStatus()
      .then((status) => {
        if (live) setRights(status);
      })
      .catch(() => {
        // The conservative answer is already in state. A Design Center that
        // could not ask is a Design Center that shows the free half.
      });
    return () => {
      live = false;
    };
  }, []);

  // Autosave writes a draft through the same gated route an explicit save uses.
  // Without the capability it would be a refusal every nine hundred
  // milliseconds, so the session is told not to schedule one at all.
  const session = useStudioSession(starting, canAuthor);

  /**
   * Open on the applied theme when there is one, and otherwise on a new pack
   * that is exactly the built-in scheme this person is already looking at. The
   * first thing the preview shows is the app they know.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await listThemes();
        if (!live) return;
        setThemes(list);
        const applied = settings.appearance.activeTheme?.id ?? null;
        const open = applied ?? list.find((theme) => theme.active)?.id ?? null;
        if (open) {
          const read = await readTheme(open);
          if (!live) return;
          // A draft is what someone was in the middle of. Reopening on the
          // saved pack instead would silently throw that away.
          const pack = read.draft?.pack ?? read.pack;
          if (pack) {
            setStarting(pack);
            setRevisions(read.revisions);
            setSavedRevision(read.pack?.revision ?? 0);
            return;
          }
        }
        const base = schemeId(settings.appearance.package) as BaseThemeId;
        setStarting(
          packFromBaseTheme(
            base,
            NEW_THEME_NAME,
            themeIdFrom(NEW_THEME_NAME),
            'This computer',
            new Date().toISOString(),
          ),
        );
        setRevisions([]);
        setSavedRevision(0);
      } catch (error) {
        if (!live) return;
        setProblem(error instanceof Error ? error.message : 'The themes could not be read.');
      }
    })();
    return () => {
      live = false;
    };
    // Opening is a one-shot: a settings change while the editor is open must
    // not throw away what someone is in the middle of editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pack = session?.pack ?? null;
  const previewPack = session?.previewPack ?? null;

  const resolved = useMemo(
    () =>
      previewPack
        ? resolveAppearance({
            surface: 'app-console',
            theme: previewPack,
            accessibility: { reducedMotion: reducedMotionPreview },
          })
        : null,
    [previewPack, reducedMotionPreview],
  );

  const refreshList = useCallback(async () => {
    try {
      setThemes(await listThemes());
    } catch {
      // The list is a convenience. Failing to refresh it is not worth an alarm
      // on a screen that has just successfully saved something.
    }
  }, []);

  const openTheme = useCallback(
    async (id: string) => {
      setProblem('');
      setSaid('');
      try {
        const read = await readTheme(id);
        const opened = read.draft?.pack ?? read.pack;
        if (!opened) {
          setProblem('That theme has nothing in it to open.');
          return;
        }
        session?.adopt(opened);
        setRevisions(read.revisions);
        setSavedRevision(read.pack?.revision ?? 0);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'That theme could not be opened.');
      }
    },
    [session],
  );

  /** Save explicitly, then apply. The only path that changes the running app. */
  const apply = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setProblem('');
    setSaid('');
    try {
      // Before the real save, so a draft write already on the wire cannot land
      // after it and put the freshly applied theme back into "unsaved changes".
      await session.cancelAutosave();
      const found = packProblem(session.pack);
      if (found) {
        setProblem(found);
        return;
      }
      const saved = await saveTheme(session.pack, savedRevision || null);
      await activateTheme(saved.pack.id);
      session.adopt(saved.pack);
      setSavedRevision(saved.revision);
      setRevisions((current) =>
        current.includes(saved.revision) ? current : [...current, saved.revision],
      );
      setSaid(`“${saved.pack.name}” is applied.`);
      await refreshList();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The theme could not be applied.');
    } finally {
      setBusy(false);
    }
  }, [session, savedRevision, refreshList]);

  const saveAs = useCallback(async () => {
    if (!session) return;
    const name = saveAsName.trim() || NEW_THEME_NAME;
    const id = themeIdFrom(name);
    setBusy(true);
    setProblem('');
    try {
      await session.cancelAutosave();
      const copy: ThemePackV1 = { ...session.pack, id, name, revision: 1 };
      const found = packProblem(copy);
      if (found) {
        setProblem(found);
        return;
      }
      // The new theme needs its own copy of the pictures before it is saved:
      // assets are stored per theme, and a save naming bytes this theme does
      // not hold is refused.
      await copyAssets(session.pack.id, id, copy);
      const saved = await saveTheme(copy, null);
      session.adopt(saved.pack);
      setSavedRevision(saved.revision);
      setRevisions([saved.revision]);
      setSaveAsOpen(false);
      setSaid(`Saved as “${saved.pack.name}”. It is not applied yet.`);
      await refreshList();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The theme could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [session, saveAsName, refreshList]);

  const restore = useCallback(
    async (revision: number) => {
      if (!session) return;
      setBusy(true);
      setProblem('');
      try {
        await session.cancelAutosave();
        const result = await restoreRevision(session.pack.id, revision);
        session.adopt(result.pack);
        setSavedRevision(result.revision);
        setRevisions((current) => [...current, result.revision]);
        setHistoryOpen(false);
        setSaid(`Version ${revision} is back, recorded as version ${result.revision}.`);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'That version could not be restored.');
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  /**
   * Read a `.diomedes-theme` file, pictures and all.
   *
   * `importThemePackage` has already checked every asset's base64, its hash
   * against its own bytes, its declared type and size against what the bytes
   * say, and the manifest's checksum against the pack. What is left is to put
   * those bytes on disk under this account before the pack that names them is
   * adopted: an explicit save refuses a pack naming a picture nobody holds, and
   * finding that out three clicks later would be a puzzle rather than a fact.
   */
  const importFile = useCallback(
    async (file: File) => {
      setProblem('');
      let result: ReturnType<typeof importThemePackage>;
      try {
        result = importThemePackage(JSON.parse(await file.text()));
      } catch {
        // A file that is not JSON at all. The parser's own words here would be
        // about tokens and offsets, which is not what went wrong for a person.
        setProblem('That file is not a Diomedes theme this app can read.');
        return;
      }
      if (!result.ok) {
        setProblem(result.errors[0]);
        return;
      }
      const pictures = Object.keys(result.assets).length;
      try {
        if (pictures > 0) await restoreAssets(result.pack.id, result.pack, result.assets);
      } catch (error) {
        setProblem(
          error instanceof Error
            ? error.message
            : 'The pictures in that file could not be stored here.',
        );
        return;
      }
      session?.adopt(result.pack, false);
      setSavedRevision(0);
      setRevisions([]);
      setSaid(
        pictures === 0
          ? `“${result.pack.name}” was read. Apply or Save it to keep it.`
          : `“${result.pack.name}” was read, with ${pictures === 1 ? 'its picture' : `${pictures} pictures`}. Apply or Save it to keep it.`,
      );
    },
    [session],
  );

  /**
   * Write the file Import reads back.
   *
   * This used to write a bare `ThemePackV1` while `importFile` requires the A1
   * package container, so a person who pressed Export and then Import on the
   * same file was told their own theme was not a Diomedes theme. One function
   * builds the file — the same one the Website target uses — so the two halves
   * of the round trip cannot drift apart again.
   */
  const exportFile = useCallback(async () => {
    if (!session) return;
    setProblem('');
    try {
      // `buildPackage` fetches the bytes of every picture the pack declares and
      // carries them in the container. A theme with a picture and no bytes is
      // a file the importer refuses — including this app's own Import.
      const built = await buildPackage(session.pack);
      const blob = new Blob([JSON.stringify(built, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${session.pack.id}${THEME_PACKAGE_EXTENSION}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'This theme could not be written to a file.',
      );
    }
  }, [session]);

  const selectedPiece = PREVIEW_PIECES.find((piece) => piece.id === selectedId) ?? null;
  const widthPx = SIDEBAR_WIDTHS.find((width) => width.id === sidebarWidth)?.px ?? 260;

  return (
    <div className="design-center" aria-label="Design Center">
      <header className="dc-head">
        <div className="row">
          <h1>Design Center</h1>
          <div className="segmented dc-target" role="group" aria-label="What you are designing">
            {(
              [
                ['app', 'This app'],
                ['website', 'Website'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={target === id ? 'on' : ''}
                aria-pressed={target === id}
                onClick={() => setTarget(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="actions push-right">
            <Button tone="quiet" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <p className="caption">
          Everything here works with no internet connection and no AI engine. Nothing in this screen
          asks a model anything.
        </p>
        {/*
          The authoring badge is deliberately visible. Design authoring is an
          explicit launch-time authorization, not a hidden bypass, so a build
          running with it on says so on the screen it affects.
        */}
        {rights.authoring && (
          <p className="caption dc-badge" data-dc-authoring="on">
            <Mark state="working" /> Design authoring is on for this computer. It was set when the
            app was launched, it covers your own themes only, and it gives no agent any authority.
          </p>
        )}
        {!canAuthor && (
          <p className="prose dc-locked" role="note" data-dc-customization="locked">
            {rights.reason || CUSTOMIZATION_LOCKED}
          </p>
        )}
      </header>

      {!session || !previewPack || !resolved ? (
        <p className="prose dc-loading">{problem || 'Opening the Design Center…'}</p>
      ) : target === 'website' ? (
        <div className="dc-body dc-body-website">
          <WebsiteTarget pack={session.pack} />
        </div>
      ) : (
        <>
          <div className="dc-toolbar row" role="group" aria-label="Design Center tools">
            <div className="segmented" role="group" aria-label="Preview mode">
              {(
                [
                  ['design', 'Design'],
                  ['interact', 'Interact'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={mode === id ? 'on' : ''}
                  aria-pressed={mode === id}
                  onClick={() => setMode(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button tone="quiet" disabled={!session.canUndo} onClick={session.undo}>
              Undo
            </Button>
            <Button tone="quiet" disabled={!session.canRedo} onClick={session.redo}>
              Redo
            </Button>
            <Button
              tone="quiet"
              aria-pressed={session.showing === 'before'}
              onClick={() => session.setShowing(session.showing === 'before' ? 'after' : 'before')}
            >
              {session.showing === 'before' ? 'Showing before' : 'Show before'}
            </Button>
            <Button tone="quiet" disabled={!session.dirty} onClick={session.resetTheme}>
              Reset theme
            </Button>
            <Button tone="quiet" onClick={() => setHistoryOpen(true)}>
              Versions
            </Button>
            {canAuthor && (
              <Button tone="quiet" onClick={() => importInput.current?.click()}>
                Import
              </Button>
            )}
            <Button tone="quiet" onClick={() => void exportFile()}>
              Export
            </Button>
            {canAuthor && (
              <Button
                tone="quiet"
                onClick={() => {
                  setSaveAsName(`${session.pack.name} copy`);
                  setSaveAsOpen(true);
                }}
              >
                Save as new theme
              </Button>
            )}
            {canAuthor && (
              <Button tone="primary" disabled={busy} onClick={() => void apply()}>
                Apply
              </Button>
            )}
            <input
              ref={importInput}
              type="file"
              accept=".diomedes-theme,application/json"
              className="dc-file"
              data-dc-import="theme"
              aria-label="Read a theme file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </div>

          <div className="dc-state row" aria-live="polite">
            <span className="caption">
              {session.saveState === 'saving'
                ? 'Saving a draft…'
                : session.saveState === 'saved'
                  ? 'Draft saved. It is not applied.'
                  : session.saveState === 'editing'
                    ? 'Editing. Nothing has changed in the app yet.'
                    : session.saveState === 'failed'
                      ? 'The draft was not saved.'
                      : 'No changes yet.'}
            </span>
            {said && <span className="caption push-right">{said}</span>}
          </div>
          {(problem || session.problem) && (
            // Named, because the stage below carries fixture alerts of its own
            // and a test asking "did this screen refuse anything?" must be able
            // to tell the screen's own sentence from a picture of one.
            <p role="alert" className="fault-text" data-dc-problem="">
              {problem || session.problem}
            </p>
          )}

          <div className="dc-body" style={{ ['--dc-sidebar' as string]: `${widthPx}px` }}>
            <Navigator
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                document
                  .querySelector(`[data-dc-piece="${id}"]`)
                  ?.scrollIntoView({ block: 'nearest' });
              }}
            />
            <div className="dc-centre">
              <Preview
                key={replay}
                pack={previewPack}
                mode={mode}
                reducedMotion={reducedMotionPreview}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onFixtureAction={(what) => setActionLog((log) => [...log, what].slice(-20))}
              />
              <section className="dc-log" aria-label="What the preview did">
                <h3>What the preview did</h3>
                {actionLog.length === 0 ? (
                  <p className="caption" data-dc-log="empty">
                    Nothing. In Design mode a click selects a component and never runs its action.
                  </p>
                ) : (
                  <ul data-dc-log="entries">
                    {actionLog.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
            {/* `previewPack`, not `session.pack`: while "Showing before" is on,
                the stage paints the baseline, and an inspector showing the
                edited values beside it — with origin labels resolved from the
                baseline — would describe two different themes at once. The
                controls read the theme on screen. Editing turns the toggle
                back to "after" before any change lands. */}
            <Inspector
              pack={previewPack}
              resolved={resolved}
              selectedPiece={selectedPiece}
              sidebarWidth={sidebarWidth}
              onSidebarWidth={setSidebarWidth}
              reducedMotionPreview={reducedMotionPreview}
              onReducedMotionPreview={setReducedMotionPreview}
              onReplay={() => setReplay((n) => n + 1)}
              onChange={session.edit}
            />
          </div>

          {themes.length > 0 && (
            <section className="dc-themes" aria-label="Your themes">
              <h3>Your themes</h3>
              <ul className="dc-list">
                {themes.map((theme) => (
                  <li key={theme.id}>
                    <Button tone="quiet" onClick={() => void openTheme(theme.id)}>
                      {theme.name}
                    </Button>
                    <span className="caption">
                      {theme.active ? 'Applied. ' : ''}
                      {theme.isDraft
                        ? 'Draft only — save it before it can be applied.'
                        : `Version ${theme.revision}${theme.hasDraft ? ', with unsaved changes' : ''}`}
                    </span>
                    {theme.hasDraft && (
                      <Button
                        tone="quiet"
                        onClick={() => {
                          void discardDraft(theme.id).then(refreshList);
                        }}
                      >
                        Discard draft
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {saveAsOpen && (
            <Modal title="Save as a new theme" onClose={() => setSaveAsOpen(false)}>
              <label className="setting-row">
                <span>Name</span>
                <input
                  aria-label="New theme name"
                  value={saveAsName}
                  maxLength={64}
                  onChange={(e) => setSaveAsName(e.target.value)}
                />
              </label>
              <p className="caption">
                It will be stored as <span className="mono">{themeIdFrom(saveAsName.trim() || NEW_THEME_NAME)}</span>.
              </p>
              <div className="actions">
                <Button tone="primary" disabled={busy} onClick={() => void saveAs()}>
                  Save
                </Button>
                <Button tone="quiet" onClick={() => setSaveAsOpen(false)}>
                  Cancel
                </Button>
              </div>
            </Modal>
          )}

          {historyOpen && (
            <Modal title="Versions of this theme" onClose={() => setHistoryOpen(false)}>
              {revisions.length === 0 ? (
                <p className="prose">This theme has not been saved yet, so it has no versions.</p>
              ) : (
                <ul className="dc-list">
                  {[...revisions].reverse().map((revision) => (
                    <li key={revision}>
                      <span>
                        Version {revision}
                        {revision === savedRevision ? ' — the saved one' : ''} of “
                        {session.pack.name}”
                      </span>
                      {canAuthor && (
                        <Button
                          tone="quiet"
                          disabled={busy || revision === savedRevision}
                          onClick={() => void restore(revision)}
                        >
                          Restore
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="caption">
                Restoring brings an earlier version back as a new one. Nothing in the history is
                ever overwritten.
              </p>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}
