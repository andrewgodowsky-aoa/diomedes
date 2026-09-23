import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExternalEngine,
  IntegrationStatus,
  Mode,
  Project,
  Settings,
  UsageSnapshot,
} from '../shared/types';
import { api, patchSettings, readSettings, SettingsConflict, writeSettings } from './api';
import { nextInterfaceScale, scaleShortcut, type ScaleCommand } from '../shared/interface-scale';
import {
  Brand,
  Button,
  Icon,
  Mark,
  Modal,
  UsageChip,
  askDraftKey,
  askModeKey,
  tightestWindow,
} from './components';
import { Shell } from './console/Shell';
import { Home, type HomeDestination } from './console/Home';
import { DiomedesHome } from './console/DiomedesHome';
import type { EverythingItem } from './console/Everything';
import { TopStrip } from './console/TopStrip';
import { DesignCenter } from './console/DesignCenter';
import { Setup } from './Setup';
import { SettingsPage } from './Settings';
import { ErrorBoundary } from './ErrorBoundary';
import { Wake } from './console/Wake';
import {
  applyResolvedAppearance,
  clearResolvedAppearance,
} from './console/theme-runtime';
import { TextureLayer } from './console/theme-artwork';
import { resolveAppearance } from '../shared/theme-pack/resolve';
import type { ThemePackV1 } from '../shared/theme-pack/types';
import { useWake } from './console/useWake';

const PLACE_KEY = 'diomedes.window.place';
/** The project this window was showing before a reload, or null. */
function keptPlace(): string | null {
  try {
    return sessionStorage.getItem(PLACE_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  // Newest first, once per projects change; the landing ask and its picker all read this.
  const byRecency = useMemo(
    () =>
      [...projects].sort((a, b) =>
        (b.lastOpenedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.createdAt),
      ),
    [projects],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [designCenter, setDesignCenter] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot[]>([]);
  const [helpersRequest, setHelpersRequest] = useState(0);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(true);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectDialog, setProjectDialog] = useState<'new' | 'open' | null>(null);
  const [projectName, setProjectName] = useState('');
  const [folder, setFolder] = useState('');
  const [browse, setBrowse] = useState<{
    path: string;
    parent: string | null;
    folders: { name: string; path: string }[];
  } | null>(null);
  const [search, setSearch] = useState(false);
  const [sectionRequest, setSectionRequest] = useState<{ section: string; n: number } | null>(null);
  /**
   * The route and model a connection test just verified, on its way to the
   * Console. It is a choice for one thread and never a send, and it waits here
   * until a Console with a project to carry it into is showing.
   *
   * It carries the moment it was made, because the facts behind it are the
   * host's and they go out of date. Waiting here is only ever for as long as
   * the person is still doing the thing they pressed it for: dismissing the
   * project search, or going back into Settings, abandons it, and the Console
   * lets go of one that has been waiting too long.
   */
  const [startTask, setStartTask] = useState<{
    route: ExternalEngine;
    model: string;
    effort: string | null;
    madeAtMs: number;
    n: number;
  } | null>(null);
  const [query, setQuery] = useState('');
  // With no project open the app shows Diomedes. The Projects page is one click away and is
  // where the Projects crumb leads; a launch never lands on it.
  const [landing, setLanding] = useState<'diomedes' | 'projects'>('diomedes');
  const [diomedesPins, setDiomedesPins] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('diomedes.rail.pins') ?? 'null');
      if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === 'string');
    } catch {
      // Unreadable pins fall back to the defaults.
    }
    return ['projects', 'new-project', 'automations'];
  });
  const [landingText, setLandingText] = useState('');
  const [landingProjectId, setLandingProjectId] = useState<string | null>(null);
  // The custom theme on the document, and the one sentence that explains a
  // fallback. Both are absent for every built-in appearance package.
  const [activeTheme, setActiveTheme] = useState<ThemePackV1 | null>(null);
  /**
   * Whether the applied-theme pointer is this workspace's own, which is a
   * different question from whether a pack could be read through it. A pointer
   * at a theme whose files are gone paints nothing and still has to be
   * clearable from Settings — it is the only way back to the built-in package.
   */
  const [themeApplies, setThemeApplies] = useState(false);
  const [appearanceNotice, setAppearanceNotice] = useState('');
  // The scheme the document is actually painted in, read back after painting: a
  // custom theme paints its base scheme, and a theme that fails to apply falls
  // back to the saved one. Screens with scheme-only art follow this, not the setting.
  const [paintedScheme, setPaintedScheme] = useState('');
  const themeKey = useRef<string | null>(null);
  const settingsRef = useRef(settings);
  const scaleWrites = useRef<Promise<void>>(Promise.resolve());
  settingsRef.current = settings;
  // Opener registered by the console Shell; Ctrl+K inside a project opens the
  // console palette instead of the project search.
  const paletteOpen = useRef<(() => void) | null>(null);
  const report = useCallback(
    (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The request could not be completed.'),
    [],
  );
  const refreshProjects = useCallback(async () => {
    const data = await api<{ projects: Project[] }>('/projects');
    setProjects(data.projects);
  }, []);
  const refreshIntegrations = useCallback(
    async (refresh = false) => {
      try {
        const data = await api<{ integrations: IntegrationStatus[] }>(
          `/integrations${refresh ? '?refresh=1' : ''}`,
        );
        setIntegrations(data.integrations);
      } catch (e) {
        report(e);
      }
    },
    [report],
  );
  const refreshUsage = useCallback(async () => {
    try {
      const data = await api<{ usage: UsageSnapshot[] }>('/usage');
      setUsage(data.usage);
    } catch (e) {
      report(e);
    }
  }, [report]);
  /**
   * Every settings write carries the hash of the settings this screen last saw.
   * When another route has written since — AI setup's On switch and its
   * "Use as default" are two such routes — the server refuses rather than
   * overwriting, and hands back what it stored. The screen adopts the saved
   * state, and says so: the change the person just made did not land, so
   * staying silent would leave them reading a screen that quietly disagrees
   * with what they pressed.
   */
  async function saveSettings(value: Settings) {
    setBusy(true);
    try {
      setSettings(await writeSettings(value));
    } catch (e) {
      if (e instanceof SettingsConflict) setSettings(e.settings);
      report(e);
    } finally {
      setBusy(false);
    }
  }
  /**
   * One appearance field, named. The whole-settings PUT on the Appearance
   * screen echoed `appearance.activeTheme` back from whatever snapshot that
   * screen was holding, so a theme applied from the Design Center could be
   * un-applied by an unrelated control. Nothing outside the theme routes sends
   * `activeTheme` any more.
   */
  async function patchAppearance(patch: Record<string, unknown>) {
    setBusy(true);
    try {
      setSettings(await patchSettings({ appearance: patch }));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  // This window's place, remembered for a reload only. Session storage ends with the window,
  // so the next launch opens to Diomedes again. It holds an id and nothing about the project.
  useEffect(() => {
    if (!initialLoaded) return;
    try {
      if (selected) sessionStorage.setItem(PLACE_KEY, selected);
      else sessionStorage.removeItem(PLACE_KEY);
    } catch {
      // Storage can be refused. The window then opens to Diomedes after a reload too.
    }
  }, [initialLoaded, selected]);
  const loadInitial = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        readSettings(),
        api<{ projects: Project[] }>('/projects'),
      ]);
      setSettings(s);
      setProjects(p.projects);
      setInitialLoaded(true);
      setOnline(true);
      // The project last open is navigation context, not the launch destination: it stays in
      // `openProjects`, first on the spine and one click away. A launch lands on Diomedes,
      // for a returning person too (core agent contract, decision 3). A reload is not a
      // launch: the window keeps the place it was showing, so refreshing mid-work, or the
      // app restarting its page, never throws a person out of their project.
      const kept = keptPlace();
      if (kept && p.projects.some((project) => project.id === kept)) setSelected(kept);
      void refreshIntegrations();
      void refreshUsage();
    } catch (e) {
      setOnline(false);
      report(e);
    }
  }, [refreshIntegrations, refreshUsage, report]);
  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);
  useEffect(() => {
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refreshProjects().catch(report), 120);
    };
    ['projects', 'project', 'state', 'tasks', 'needs', 'session', 'history', 'review'].forEach(
      (n) => es.addEventListener(n, refresh),
    );
    es.addEventListener('settings', () => {
      void readSettings().then(setSettings).catch(report);
    });
    es.addEventListener('usage', () => {
      void refreshUsage().catch(report);
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [refreshProjects, refreshUsage, report]);
  /**
   * The applied custom theme, fetched once per `<id>@<revision>`.
   *
   * Kept out of the appearance effect below on purpose: that effect runs on
   * every settings change, and a fetch inside it would go back to the service
   * each time someone pressed Ctrl+Plus.
   */
  // Which workspace this is, as one string. Theme storage is per scope while
  // the pointer is global, so a switch changes what `/themes/active` answers
  // without changing the pointer at all. It belongs in the fetch key, not only
  // in the dependency list: the key is what the early return below compares.
  const workspaceKey =
    settings?.activeWorkspace?.kind === 'business'
      ? `business:${settings.activeWorkspace.organizationId}`
      : 'personal';
  useEffect(() => {
    const pointer = settings?.appearance.activeTheme ?? null;
    if (!pointer) {
      themeKey.current = null;
      setActiveTheme(null);
      setThemeApplies(false);
      setAppearanceNotice('');
      return;
    }
    const key = `${workspaceKey}/${pointer.id}@${pointer.revision}`;
    if (key === themeKey.current) return;
    themeKey.current = key;
    let live = true;
    void api<{
      pack: ThemePackV1 | null;
      source: string;
      notice: string | null;
      applies: boolean;
    }>('/themes/active')
      .then((answer) => {
        if (!live) return;
        setActiveTheme(answer.pack);
        setThemeApplies(answer.applies === true);
        setAppearanceNotice(answer.notice ?? '');
      })
      .catch(() => {
        // A theme that cannot be fetched is not a reason to stop painting. The
        // built-in package is already on the document; say so and leave it.
        //
        // `applies` stays unknown here, so it is left false: a server hiccup
        // must not offer a control that clears a pointer, and the next
        // successful read decides. The notice is the client's own and is never
        // the discriminator for either.
        if (!live) return;
        setActiveTheme(null);
        setThemeApplies(false);
        setAppearanceNotice(
          'Your saved theme could not be read. The built-in appearance package is showing.',
        );
      });
    return () => {
      live = false;
    };
  }, [
    workspaceKey,
    settings?.appearance.activeTheme?.id,
    settings?.appearance.activeTheme?.revision,
  ]);
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    // The Console is the one surface. The attribute stays because stylesheets
    // and the packaged smoke drivers key on it.
    root.dataset.surface = 'console';
    // Detail is the person's own setting and nothing else decides it. It used to
    // be pinned to 'technical' whenever the Console was showing, which made the
    // setting unreachable for anybody working there; with one surface left that
    // would have retired Detail altogether.
    root.dataset.detail = settings.detail;
    root.dataset.view = settings.view ?? 'architect';
    // One owner for the appearance. With no custom theme this is the code that
    // has always run, unchanged, so the ten built-in schemes behave exactly as
    // before; with one, the resolver decides and the runtime writes, and the
    // built-in branch is skipped rather than fighting it.
    const scales = {
      'ui-scale': settings.appearance.interfaceScale ?? 1,
      'read-scale': settings.appearance.readingScale ?? 1,
      'code-scale': settings.appearance.codeScale ?? 1,
    };
    try {
      if (activeTheme) {
        applyResolvedAppearance(
          resolveAppearance({
            surface: 'app-console',
            theme: activeTheme,
            personal: { motion: settings.appearance.motion },
            accessibility: {
              reducedMotion: settings.appearance.motion === 'reduced',
              textureOff: settings.appearance.textureOff === true,
            },
          }),
        );
        // The resolver's personal layer only carries the four approved scales,
        // and Ctrl+Plus writes any size between 0.75 and 2. A person's own size
        // is theirs whatever a theme asked for, so it is re-asserted here.
        for (const [name, value] of Object.entries(scales))
          root.style.setProperty(`--dm-${name}`, String(value));
        setPaintedScheme(root.dataset.package ?? '');
        return;
      }
      clearResolvedAppearance();
    } catch {
      // Painting must never be what fails. An exception thrown from an effect
      // unmounts the tree and leaves a blank window, which is the one outcome
      // worse than the built-in scheme.
      clearResolvedAppearance();
      setAppearanceNotice(
        'Your saved theme could not be applied. The built-in appearance package is showing.',
      );
    }
    root.dataset.package = settings.appearance.package;
    root.dataset.motion = settings.appearance.motion;
    setPaintedScheme(settings.appearance.package);
    // Surface changes never resize the interface. Explicit size preferences win.
    for (const [name, value] of Object.entries(scales))
      root.style.setProperty(`--dm-${name}`, String(value));
  }, [settings, activeTheme]);
  useEffect(() => {
    const change = (command: ScaleCommand) => {
      // Serialize held/repeated shortcuts and read the current preference each time.
      // A scale change owns only one appearance field, never provider or account settings.
      scaleWrites.current = scaleWrites.current
        .then(async () => {
          const current = await readSettings();
          const value = nextInterfaceScale(current.appearance.interfaceScale ?? 1, command);
          if (value === current.appearance.interfaceScale) return;
          setSettings(
            await patchSettings({ appearance: { interfaceScale: value } }),
          );
        })
        .catch(report);
    };
    const keyboard = (event: KeyboardEvent) => {
      const command = scaleShortcut(event);
      if (!command) return;
      event.preventDefault();
      change(command);
    };
    const desktop = (event: Event) => {
      const command: unknown = (event as CustomEvent<unknown>).detail;
      if (command === 'increase' || command === 'decrease' || command === 'reset') change(command);
    };
    window.addEventListener('keydown', keyboard);
    window.addEventListener('diomedes-interface-scale', desktop);
    return () => {
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('diomedes-interface-scale', desktop);
    };
  }, [report]);
  const openProject = useCallback(
    (project: Project) => {
      setSelected(project.id);
      setShowSettings(false);
      const s = settingsRef.current;
      if (s) {
        // Update the local copy first so a navigation that follows at once builds on this order, not the old one.
        const next = {
          ...s,
          openProjects: [...s.openProjects.filter((id) => id !== project.id), project.id].slice(-6),
        };
        settingsRef.current = next;
        setSettings(next);
        // Navigation owns only this field; a stale client must not overwrite engine consent.
        void patchSettings({ openProjects: next.openProjects }).catch(report);
      }
    },
    [report],
  );
  // Going back into Settings abandons the handover too: the person is back at
  // the screen that made the offer, where they can make it again.
  useEffect(() => {
    if (showSettings) setStartTask(null);
  }, [showSettings]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const onConsole = !!selected && !showSettings;
        if (onConsole && paletteOpen.current) paletteOpen.current();
        else setSearch(true);
      }
      if (e.ctrlKey && e.key === '.') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-stop]')?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected, showSettings]);
  async function createProject() {
    setBusy(true);
    try {
      const p = await api<Project>(
        projectDialog === 'open' ? '/projects/open' : '/projects',
        'POST',
        projectDialog === 'open'
          ? { folder }
          : { name: projectName.trim(), ...(folder.trim() ? { folder: folder.trim() } : {}) },
      );
      await refreshProjects();
      setProjectDialog(null);
      setProjectName('');
      setFolder('');
      openProject(p);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function sampleProject() {
    setBusy(true);
    try {
      const p = await api<Project>('/projects/sample', 'POST', {});
      await refreshProjects();
      openProject(p);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function browseFolder(path = '') {
    try {
      setBrowse(await api(`/fs/list?path=${encodeURIComponent(path)}`));
    } catch (e) {
      report(e);
    }
  }
  // Landing ask box handler for the projects-page block below (kept out of the scale effect above).
  const sendLandingAsk = (text: string, project: Project, mode: Mode) => {
    const value = text.trim();
    if (!value) return;
    try {
      localStorage.setItem(askDraftKey(project.id), value);
      localStorage.setItem(askModeKey(project.id), mode);
    } catch {
      // Storage is unavailable; continue without a carried draft.
    }
    setLandingText('');
    // The Console's composer picks the carried draft and mode up when it opens.
    openProject(project);
  };
  const current = projects.find((p) => p.id === selected);
  // The Field shell draws its own top strip, so the app's strip hides inside a project.
  const consoleActive = !!selected && !showSettings;
  // The chip follows the helper that is on: the first ready engine whose
  // switch is on. It shows the last reported windows even when that engine
  // is momentarily unreachable; the helpers list carries the live status.
  const activeIntegration = integrations.find(
    (i) => i.adapter === 'ready' && i.kind !== 'sample' && settings?.services?.[i.id],
  );
  const activeUsage = activeIntegration
    ? (usage.find((u) => u.engine === activeIntegration.id) ?? null)
    : null;
  const chipVisible = !!activeUsage && !!tightestWindow(activeUsage);
  const needs = projects.reduce((n, p) => n + (p.status?.needsYou ?? 0), 0);
  const running = projects.reduce((n, p) => n + (p.status?.working ?? 0), 0);
  const shownProjects = projects.filter((p) => settings?.openProjects.includes(p.id));
  const status = !online
    ? 'Connection lost. Reconnecting.'
    : needs
      ? `Something needs your OK${current ? ` in ${current.name}` : ''}.`
      : running
        ? `Nectovia is working on ${running} ${running === 1 ? 'task' : 'tasks'}.`
        : settings?.detail === 'guided'
          ? ''
          : 'Ready when you are.';

  // Shell draws its own strip inside a project, and TopStrip draws the same one
  // over the Projects page and Settings.
  const stripShown = !consoleActive;
  // The strip speaks only when there is news. "Ready when you are." narrated a
  // state the empty strip already shows (standing decision 4).
  const stripStatus = !online
    ? { state: 'fault' as const, text: status }
    : needs
      ? { state: 'waiting' as const, text: status }
      : running
        ? { state: 'working' as const, text: status }
        : null;

  // Everything the Projects page's rail and flyout can open. Settings sections
  // are asked for by name, the way the usage chip asks for the engines section.
  const goFromHome = (destination: HomeDestination) => {
    const section: Partial<Record<HomeDestination, string>> = {
      engines: 'Engines',
      appearance: 'Appearance',
      'design-center': 'Design Center',
      permissions: 'Permissions',
      detail: 'Interface detail',
      updates: 'App updates',
      about: 'About',
    };
    if (destination === 'diomedes') setLanding('diomedes');
    else if (destination === 'new-project') setProjectDialog('new');
    else if (destination === 'open-folder') setProjectDialog('open');
    else if (destination === 'sample') void sampleProject();
    else if (destination === 'find') setSearch(true);
    else if (section[destination]) {
      setSectionRequest((last) => ({ section: section[destination]!, n: (last?.n ?? 0) + 1 }));
      setShowSettings(true);
    }
  };

  // What the Diomedes page's rail and flyout can open. Every place the Projects page reaches is
  // still reachable from here, and the Projects page itself is the first of them.
  const diomedesDestinations: EverythingItem[] = [
    { id: 'projects', label: 'Projects', hint: 'Every project, what each is doing, and what needs you.' },
    { id: 'new-project', label: 'New project', hint: 'Start from an empty folder.' },
    { id: 'open-folder', label: 'Open a folder', hint: 'Make a project of documents you already have.' },
    { id: 'find', label: 'Find a project', hint: 'Search every project by name.', badge: 'Ctrl K' },
    {
      id: 'automations',
      label: 'Automations',
      hint: 'Work that runs on its own, on a schedule or when something happens.',
      unavailableReason:
        'Nothing is built behind this yet. It opens once there is real work for it to run.',
      reserved: true,
    },
    { id: 'engines', label: 'AI engines', hint: 'Which engines are installed, signed in, and switched on.' },
    { id: 'appearance', label: 'Appearance', hint: 'Colour scheme, text size and motion.' },
    { id: 'design-center', label: 'Design Center', hint: 'Make and apply a theme of your own.' },
    {
      id: 'permissions',
      label: 'Permissions',
      hint: 'What Nectovia may do on its own, and what always asks first.',
    },
    { id: 'detail', label: 'Interface detail', hint: 'How much each change spells out.' },
    { id: 'updates', label: 'App updates', hint: 'The version you run, and what is newer.' },
    { id: 'about', label: 'About', hint: 'Version, licences and where your data lives.' },
  ];
  const diomedesGroups = [
    { heading: 'Projects', ids: ['projects', 'new-project', 'open-folder', 'find'] },
    {
      heading: 'Nectovia',
      ids: ['engines', 'appearance', 'design-center', 'permissions', 'detail', 'updates', 'about'],
    },
    { heading: 'Not ready yet', ids: ['automations'] },
  ];

  const loaded = settings !== null && initialLoaded;
  const reduced =
    settings?.appearance.motion === 'reduced' ||
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const wake = useWake({ loaded, online, reduced, firstOpen: true });
  const retryInitial = useCallback(() => {
    setError('');
    void loadInitial();
  }, [loadInitial]);
  // The wake sits above everything; the team count arrives in a later pass.
  const wakeLayer = wake.show ? (
    <Wake
      short={wake.short}
      failed={wake.failed}
      projects={projects.length}
      reduced={reduced}
      onDone={wake.done}
      onRetry={retryInitial}
    />
  ) : null;

  if (!settings)
    return (
      <>
        {wakeLayer}
        <div className="initial-state">
          <Brand />
          <p className="prose">{error || 'Opening Nectovia...'}</p>
          {error && <Button onClick={() => location.reload()}>Try again</Button>}
        </div>
      </>
    );
  return (
    <>
      {wakeLayer}
      <div className="app">
        {/* The applied theme's texture: decorative, beneath everything, and
            switched off by `--dm-texture-opacity` whenever the person or the
            accessibility layer says so. `.app` is a stacking context, so this
            paints above its background and below every label and focus ring in
            it without any other rule having to know it is there. */}
        {/* The pack's own id, not the pointer's: the pointer is global over
            per-workspace storage, and the asset URLs this builds must name the
            theme that is actually painting. */}
        <TextureLayer themeId={activeTheme?.id ?? null} pack={activeTheme} />
        {settings.onboarding.resumeAt !== 'done' ? (
          <Setup settings={settings} save={saveSettings} busy={busy} />
        ) : (
          <>
            <div
              className={`page-frame ${stripShown ? 'with-strip' : ''} ${needs && current?.status?.needsYou ? 'needs-attention' : ''} ${!online ? 'disconnected' : ''}`}
            >
              {stripShown && (
                <TopStrip
                  projects={shownProjects}
                  onProjects={!selected && !showSettings}
                  settingsOpen={showSettings}
                  settings={settings}
                  saveSettings={saveSettings}
                  onShowProjects={() => {
                    setSelected(null);
                    setShowSettings(false);
                    setLanding('projects');
                  }}
                  onOpenProject={openProject}
                  onToggleSettings={() => setShowSettings(!showSettings)}
                  onFind={() => setSearch(true)}
                  status={stripStatus}
                  chip={
                    chipVisible && activeIntegration && activeUsage ? (
                      <UsageChip
                        snapshot={activeUsage}
                        name={activeIntegration.name}
                        onOpen={() => {
                          setShowSettings(true);
                          setHelpersRequest((n) => n + 1);
                        }}
                      />
                    ) : null
                  }
                />
              )}
              {showSettings ? (
                // A narrower one around Settings: AI setup renders host-shaped
                // records from five adapters, and a failure drawing one of them
                // should cost the person this screen, not the Console they were
                // working in. Closing Settings leaves the crash behind.
                <ErrorBoundary
                  scope="screen"
                  onLeave={{ label: 'Close settings', act: () => setShowSettings(false) }}
                >
                <SettingsPage
                  settings={settings}
                  save={saveSettings}
                  patchAppearance={patchAppearance}
                  integrations={integrations}
                  usage={usage}
                  openHelpersSignal={helpersRequest}
                  sectionRequest={sectionRequest}
                  refresh={() => void refreshIntegrations(true)}
                  // What is actually painted, not what the pointer names: the
                  // pointer is global and theme storage is per workspace.
                  appliedTheme={activeTheme}
                  // Separate from the pack: a pointer whose theme cannot be
                  // read paints nothing and is still this workspace's to clear.
                  themeApplies={themeApplies}
                  onOpenDesignCenter={() => {
                    // Settings closes behind it, so closing the Design Center
                    // leaves the person back in the Console they were working
                    // in rather than three screens deep.
                    setShowSettings(false);
                    setDesignCenter(true);
                  }}
                  // A verified route, carried into the Console. Settings closes
                  // behind it the same way the Design Center's does. With no
                  // project open there is nothing to carry it into, so the
                  // existing "Open a project" search is what opens — Diomedes
                  // does not make a project on somebody's behalf — and the
                  // choice waits here until one is open.
                  onStartFirstTask={(route, model, effort) => {
                    setShowSettings(false);
                    setStartTask((last) => ({
                      route,
                      model,
                      effort,
                      madeAtMs: Date.now(),
                      n: (last?.n ?? 0) + 1,
                    }));
                    if (!selected) setSearch(true);
                  }}
                />
                </ErrorBoundary>
              ) : selected ? (
                <Shell
                  key={`console:${selected}`}
                  projectId={selected}
                  projects={shownProjects}
                  settings={settings}
                  integrations={integrations}
                  usage={usage}
                  saveSettings={saveSettings}
                  openEngineSettings={() => {
                    setShowSettings(true);
                    setHelpersRequest((n) => n + 1);
                  }}
                  onOpenProject={openProject}
                  onShowProjects={() => {
                    setSelected(null);
                    setShowSettings(false);
                    setLanding('projects');
                  }}
                  onOpenSettings={() => setShowSettings(true)}
                  report={report}
                  online={online}
                  onPaletteKey={(open) => {
                    paletteOpen.current = open;
                  }}
                  firstTask={startTask}
                  onFirstTaskTaken={() => setStartTask(null)}
                />
              ) : landing === 'diomedes' ? (
                <DiomedesHome
                  projects={byRecency}
                  detail={settings?.detail}
                  results={[]}
                  onOpenResult={() => undefined}
                  destinations={diomedesDestinations}
                  groups={diomedesGroups}
                  pinned={diomedesPins}
                  onTogglePin={(id) => {
                    const next = diomedesPins.includes(id)
                      ? diomedesPins.filter((item) => item !== id)
                      : [...diomedesPins, id];
                    setDiomedesPins(next);
                    try {
                      localStorage.setItem('diomedes.rail.pins', JSON.stringify(next));
                    } catch {
                      // Storage is unavailable; the pins hold for this visit.
                    }
                  }}
                  onDestination={(id) => {
                    if (id === 'projects') setLanding('projects');
                    else if (id !== 'automations') goFromHome(id as HomeDestination);
                  }}
                  onNewProject={() => goFromHome('new-project')}
                  onOpenWork={(projectId) => {
                    const target = projects.find((p) => p.id === projectId);
                    if (target) openProject(target);
                  }}
                  scheme={paintedScheme}
                />
              ) : (
                <Home
                  projects={projects}
                  byRecency={byRecency}
                  settings={settings}
                  integrations={integrations}
                  usage={usage}
                  saveSettings={saveSettings}
                  text={landingText}
                  onText={setLandingText}
                  targetId={landingProjectId}
                  onTarget={setLandingProjectId}
                  onSend={sendLandingAsk}
                  onOpenProject={openProject}
                  onGo={goFromHome}
                />
              )}
            </div>
          </>
        )}
      </div>
      {/* The Design Center is a full-surface workspace over whatever is showing
          rather than a page of its own. Opening it must not unmount the work
          underneath: applying a theme changes presentation, and presentation
          changing is not a reason to lose an unsent message. */}
      {designCenter && settings && (
        <DesignCenter settings={settings} onClose={() => setDesignCenter(false)} />
      )}
      {error && (
        <div className="error-bar" role="alert">
          <Mark state="fault" />
          <span>{error}</span>
          <Button tone="quiet" onClick={() => setError('')}>
            Dismiss
          </Button>
        </div>
      )}
      {/* A theme that could not be applied is a fact about the appearance, not a
          failed request: the app is running and readable, and this says which
          appearance it is running in and why. */}
      {appearanceNotice && (
        <div className="error-bar appearance-notice" role="status">
          <Mark state="waiting" />
          <span>{appearanceNotice}</span>
          <Button tone="quiet" onClick={() => setAppearanceNotice('')}>
            Dismiss
          </Button>
        </div>
      )}
      {projectDialog && (
        <Modal
          title={projectDialog === 'new' ? 'New project' : 'Open a folder as a project'}
          onClose={() => {
            setProjectDialog(null);
            setBrowse(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createProject();
            }}
          >
            {projectDialog === 'new' && (
              <label className="field">
                Name
                <input
                  autoFocus
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Name your project"
                  required
                />
              </label>
            )}
            <label className="field">
              Folder
              <div className="row">
                <input
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="A new folder in the Diomedes projects folder"
                  required={projectDialog === 'open'}
                />
                <Button onClick={() => void browseFolder(folder)}>Choose...</Button>
              </div>
            </label>
            <p className="prose small">
              Nectovia keeps a history of every change it makes inside this folder.
            </p>
            {browse && (
              <div className="folder-browser">
                <div className="row">
                  <span className="code caption">{browse.path || 'Folders'}</span>
                  {browse.parent !== null && (
                    <Button tone="quiet" onClick={() => void browseFolder(browse.parent ?? '')}>
                      Up
                    </Button>
                  )}
                </div>
                {browse.folders.map((f) => (
                  <button key={f.path} onClick={() => void browseFolder(f.path)} type="button">
                    <Icon name="documents" />
                    {f.name}
                  </button>
                ))}
                <Button
                  onClick={() => {
                    setFolder(browse.path);
                    setBrowse(null);
                  }}
                >
                  Use this folder
                </Button>
              </div>
            )}
            <div className="dialog-actions">
              <Button onClick={() => setProjectDialog(null)}>Cancel</Button>
              <Button type="submit" tone="primary" disabled={busy}>
                {projectDialog === 'new' ? 'Create project' : 'Open project'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {search && (
        <Modal
          title="Open a project"
          onClose={() => {
            setSearch(false);
            // Closing this is leaving the flow the offer belongs to. The choice
            // a connection test made was for the task the person was about to
            // write, not for whatever project they open next.
            setStartTask(null);
          }}
        >
          <label className="field">
            Find by name
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
            />
          </label>
          <div className="search-results">
            {projects
              .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    openProject(p);
                    setSearch(false);
                    setQuery('');
                  }}
                >
                  {p.name}
                </button>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
}
