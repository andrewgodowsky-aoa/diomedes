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
import { importThemePackage } from '../../shared/theme-pack/package';
import type { ArtworkSlot, BaseThemeId, ThemePackV1 } from '../../shared/theme-pack/types';
import { Button, Modal } from '../components';
import { schemeId } from './schemes';
import { Inspector } from './design-center/Inspector';
import { Navigator } from './design-center/Navigator';
import { Preview, PREVIEW_PIECES, type PreviewMode } from './design-center/Preview';
import {
  SIDEBAR_WIDTHS,
  packFromBaseTheme,
  themeIdFrom,
  type ArtworkPlacementDraft,
} from './design-center/pack';
import { packProblem, useStudioSession } from './design-center/session';
import {
  activateTheme,
  discardDraft,
  listThemes,
  readTheme,
  restoreRevision,
  saveTheme,
  type ThemeSummary,
} from './design-center/themes-api';
import { WebsiteTarget } from './design-center/WebsiteTarget';
import './design-center.css';

type Target = 'app' | 'website';

const NEW_THEME_NAME = 'My theme';

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
  const [placements, setPlacements] = useState<Partial<Record<ArtworkSlot, ArtworkPlacementDraft>>>(
    {},
  );
  const [sidebarWidth, setSidebarWidth] = useState('standard');
  const [reducedMotionPreview, setReducedMotionPreview] = useState(false);
  const [replay, setReplay] = useState(0);
  const importInput = useRef<HTMLInputElement>(null);

  const session = useStudioSession(starting);

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
      const copy: ThemePackV1 = { ...session.pack, id, name, revision: 1 };
      const found = packProblem(copy);
      if (found) {
        setProblem(found);
        return;
      }
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

  const importFile = useCallback(
    async (file: File) => {
      setProblem('');
      try {
        const result = importThemePackage(JSON.parse(await file.text()));
        if (!result.ok) {
          setProblem(result.errors[0]);
          return;
        }
        session?.adopt(result.pack, false);
        setSavedRevision(0);
        setRevisions([]);
        setSaid(`“${result.pack.name}” was read. Apply or Save it to keep it.`);
      } catch {
        setProblem('That file is not a Diomedes theme this app can read.');
      }
    },
    [session],
  );

  const exportFile = useCallback(() => {
    if (!session) return;
    const blob = new Blob([JSON.stringify(session.pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${session.pack.id}.diomedes-theme`;
    anchor.click();
    URL.revokeObjectURL(url);
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
            <Button tone="quiet" onClick={() => importInput.current?.click()}>
              Import
            </Button>
            <Button tone="quiet" onClick={exportFile}>
              Export
            </Button>
            <Button
              tone="quiet"
              onClick={() => {
                setSaveAsName(`${session.pack.name} copy`);
                setSaveAsOpen(true);
              }}
            >
              Save as new theme
            </Button>
            <Button tone="primary" disabled={busy} onClick={() => void apply()}>
              Apply
            </Button>
            <input
              ref={importInput}
              type="file"
              accept=".diomedes-theme,application/json"
              className="dc-file"
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
            <p role="alert" className="fault-text">
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
            <Inspector
              pack={session.pack}
              resolved={resolved}
              selectedPiece={selectedPiece}
              placements={placements}
              onPlacements={setPlacements}
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
                      <Button
                        tone="quiet"
                        disabled={busy || revision === savedRevision}
                        onClick={() => void restore(revision)}
                      >
                        Restore
                      </Button>
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
