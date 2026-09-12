import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  IntegrationStatus,
  Page,
  Project,
  Settings,
  Surface,
  UsageSnapshot,
} from '../shared/types';
import { api } from './api';
import { nextInterfaceScale, scaleShortcut, type ScaleCommand } from '../shared/interface-scale';
import {
  Brand,
  Button,
  Empty,
  HelperLine,
  Icon,
  Mark,
  Modal,
  UsageChip,
  askDraftKey,
  date,
  pages,
  surfaceOf,
  tightestWindow,
  titleCase,
} from './components';
import { Shell } from './console/Shell';
import { MarkGlyph } from './console/Mark';
import { Setup } from './Setup';
import { SettingsPage } from './Settings';
import { Workspace } from './Workspace';
import { Wake } from './console/Wake';
import { useWake } from './console/useWake';

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
  const [page, setPage] = useState<Page>('home');
  const [showSettings, setShowSettings] = useState(false);
  const [account, setAccount] = useState(false);
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
  const [query, setQuery] = useState('');
  const [landingText, setLandingText] = useState('');
  const [landingProjectId, setLandingProjectId] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  const scaleWrites = useRef<Promise<void>>(Promise.resolve());
  settingsRef.current = settings;
  // Opener registered by the console Shell; Ctrl+K on the console surface
  // opens the console palette instead of the Workbook's project search.
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
  async function saveSettings(value: Settings) {
    setBusy(true);
    try {
      const saved = await api<Settings>('/settings', 'PUT', value);
      setSettings(saved);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const loadInitial = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        api<Settings>('/settings'),
        api<{ projects: Project[] }>('/projects'),
      ]);
      setSettings(s);
      setProjects(p.projects);
      setInitialLoaded(true);
      setOnline(true);
      const id = s.openProjects.at(-1);
      if (id && p.projects.some((x) => x.id === id)) {
        setSelected(id);
        const restored = s.lastPage[id];
        // A page the Workbook rail no longer offers — Connections is Console-only — would
        // otherwise restore as an empty reading pane.
        setPage(restored && (pages as readonly Page[]).includes(restored) ? restored : 'home');
      }
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
      void api<Settings>('/settings').then(setSettings).catch(report);
    });
    es.addEventListener('usage', () => {
      void refreshUsage().catch(report);
    });
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [refreshProjects, refreshUsage, report]);
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const surface = surfaceOf(settings);
    root.dataset.surface = surface;
    // The Console shows the machinery; components that gate on 'technical' follow it.
    root.dataset.detail = surface === 'console' ? 'technical' : settings.detail;
    root.dataset.package = settings.appearance.package;
    root.dataset.motion = settings.appearance.motion;
    // Surface changes never resize the interface. Explicit size preferences win.
    const effectiveUiScale = settings.appearance.interfaceScale ?? 1;
    for (const [name, value] of Object.entries({
      'ui-scale': effectiveUiScale,
      'read-scale': settings.appearance.readingScale ?? 1,
      'code-scale': settings.appearance.codeScale ?? 1,
    }))
      root.style.setProperty(`--dm-${name}`, String(value));
  }, [settings]);
  useEffect(() => {
    const change = (command: ScaleCommand) => {
      // Serialize held/repeated shortcuts and read the current preference each time.
      // A scale change owns only one appearance field, never provider or account settings.
      scaleWrites.current = scaleWrites.current
        .then(async () => {
          const current = await api<Settings>('/settings');
          const value = nextInterfaceScale(current.appearance.interfaceScale ?? 1, command);
          if (value === current.appearance.interfaceScale) return;
          setSettings(
            await api<Settings>('/settings', 'PUT', { appearance: { interfaceScale: value } }),
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
      setPage('home');
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
        void api<Settings>('/settings', 'PUT', { openProjects: next.openProjects }).catch(report);
      }
    },
    [report],
  );
  const navigate = useCallback(
    (p: Page) => {
      // Only the page moves. Settings replaces the Workbook and the Console while it is
      // open, so a navigate that arrives then comes from a background restore
      // (a recovered draft, the first plan) and must not close it.
      setPage(p);
      const s = settingsRef.current;
      if (s && selected) {
        const next = { ...s, lastPage: { ...s.lastPage, [selected]: p } };
        settingsRef.current = next;
        setSettings(next);
        void api<Settings>('/settings', 'PUT', { lastPage: next.lastPage }).catch(report);
      }
    },
    [report, selected],
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const s = settingsRef.current;
        const onConsole = !!selected && !!s && surfaceOf(s) === 'console' && !showSettings;
        if (onConsole && paletteOpen.current) paletteOpen.current();
        else setSearch(true);
      }
      if (e.ctrlKey && /^[1-8]$/.test(e.key) && selected) {
        e.preventDefault();
        setShowSettings(false);
        navigate(
          (['home', 'ask', 'plan', 'work', 'review', 'tasks', 'documents', 'history'] as Page[])[
            Number(e.key) - 1
          ],
        );
      }
      if (e.ctrlKey && e.key === '.') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-stop]')?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected, showSettings, navigate]);
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
  const sendLandingAsk = (text: string, project: Project) => {
    const value = text.trim();
    if (!value) return;
    try {
      localStorage.setItem(askDraftKey(project.id), value);
    } catch {
      // Storage is unavailable; continue without a carried draft.
    }
    setLandingText('');
    openProject(project);
    navigate('ask');
  };
  const current = projects.find((p) => p.id === selected);
  const surface: Surface = settings ? surfaceOf(settings) : 'workbook';
  // The Field shell draws its own top strip; the app bar hides underneath it
  // so the shell strip is the only one on the console surface.
  const consoleActive = !!selected && surface === 'console' && !showSettings;
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
        ? `Diomedes is working on ${running} ${running === 1 ? 'task' : 'tasks'}.`
        : settings?.detail === 'guided'
          ? ''
          : 'Ready when you are.';

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
          <p className="prose">{error || 'Opening your workbook...'}</p>
          {error && <Button onClick={() => location.reload()}>Try again</Button>}
        </div>
      </>
    );
  return (
    <>
      {wakeLayer}
      <div className="app">
        {settings.onboarding.resumeAt !== 'done' ? (
          <Setup settings={settings} save={saveSettings} busy={busy} />
        ) : (
          <>
            {!consoleActive && (
              <header className="top-bar">
                <button
                  className="brand-button"
                  onClick={() => {
                    setSelected(null);
                    setShowSettings(false);
                  }}
                  aria-label="Diomedes projects"
                >
                  <MarkGlyph size={18} />
                  <Brand />
                </button>
                <nav className="project-tabs" aria-label="Open projects">
                  <button
                    className={`project-tab ${!selected && !showSettings ? 'active' : ''}`}
                    onClick={() => {
                      setSelected(null);
                      setShowSettings(false);
                    }}
                  >
                    Projects
                  </button>
                  {shownProjects.map((p) => (
                    <button
                      key={p.id}
                      className={`project-tab ${selected === p.id && !showSettings ? 'active' : ''}`}
                      onClick={() => openProject(p)}
                    >
                      {p.status?.needsYou || p.status?.working ? (
                        <Mark state={p.status.needsYou ? 'waiting' : 'working'} />
                      ) : null}
                      <span className="project-tab-name" title={p.name}>
                        {p.name}
                      </span>
                    </button>
                  ))}
                </nav>
                <div className="top-right">
                  <div className="top-status" role="status">
                    {status && (
                      <>
                        <Mark
                          state={
                            !online ? 'fault' : needs ? 'waiting' : running ? 'working' : 'done'
                          }
                        />
                        <span>{status}</span>
                      </>
                    )}
                    {chipVisible && activeIntegration && activeUsage && (
                      <UsageChip
                        snapshot={activeUsage}
                        name={activeIntegration.name}
                        onOpen={() => {
                          setShowSettings(true);
                          setHelpersRequest((n) => n + 1);
                        }}
                      />
                    )}
                  </div>
                  <Button
                    tone={`quiet ${showSettings ? 'selected' : ''}`}
                    onClick={() => setShowSettings(!showSettings)}
                  >
                    Settings
                  </Button>
                  <div className="account-wrap">
                    <Button
                      tone="quiet icon-button"
                      aria-label="Interface detail menu"
                      onClick={() => setAccount(!account)}
                    >
                      <Icon name="settings" />
                    </Button>
                    {account && (
                      <div className="account-menu">
                        <p className="caption">Surface</p>
                        {(['workbook', 'console'] as const).map((s) => (
                          <button
                            key={s}
                            onClick={() => {
                              void saveSettings({
                                ...settings,
                                surface: s,
                                detail:
                                  s === 'workbook' && settings.detail === 'technical'
                                    ? 'standard'
                                    : settings.detail,
                              });
                              setAccount(false);
                            }}
                          >
                            <Mark state={s === surface ? 'working' : 'todo'} />
                            {s === 'workbook' ? 'The Workbook' : 'The Console'}
                          </button>
                        ))}
                        {surface === 'workbook' && (
                          <>
                            <p className="caption">Detail</p>
                            {(['guided', 'standard'] as const).map((d) => (
                              <button
                                key={d}
                                onClick={() => {
                                  void saveSettings({ ...settings, detail: d });
                                  setAccount(false);
                                }}
                              >
                                <Mark state={d === settings.detail ? 'working' : 'todo'} />
                                {titleCase(d)}
                              </button>
                            ))}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </header>
            )}
            <div
              className={`page-frame ${needs && current?.status?.needsYou ? 'needs-attention' : ''} ${!online ? 'disconnected' : ''}`}
            >
              {showSettings ? (
                <SettingsPage
                  settings={settings}
                  save={saveSettings}
                  integrations={integrations}
                  usage={usage}
                  openHelpersSignal={helpersRequest}
                  refresh={() => void refreshIntegrations(true)}
                />
              ) : selected && surface === 'console' ? (
                <Shell
                  key={`console:${selected}`}
                  projectId={selected}
                  projects={shownProjects}
                  settings={settings}
                  integrations={integrations}
                  usage={usage}
                  saveSettings={saveSettings}
                  openInBook={(p) => {
                    void saveSettings({
                      ...settings,
                      surface: 'workbook',
                      detail: settings.detail === 'technical' ? 'standard' : settings.detail,
                    });
                    navigate(p);
                  }}
                  openEngineSettings={() => {
                    setShowSettings(true);
                    setHelpersRequest((n) => n + 1);
                  }}
                  onOpenProject={openProject}
                  onShowProjects={() => {
                    setSelected(null);
                    setShowSettings(false);
                  }}
                  onOpenSettings={() => setShowSettings(true)}
                  report={report}
                  online={online}
                  onPaletteKey={(open) => {
                    paletteOpen.current = open;
                  }}
                />
              ) : selected ? (
                <Workspace
                  key={selected}
                  projectId={selected}
                  page={page}
                  navigate={navigate}
                  settings={settings}
                  integrations={integrations}
                  usage={usage}
                  saveSettings={saveSettings}
                  report={report}
                  online={online}
                />
              ) : (
                <main className="main projects-page">
                  <header className="page-header">
                    <h1>Projects</h1>
                    <div className="actions push-right">
                      <Button onClick={() => setProjectDialog('open')}>
                        Open a folder as a project
                      </Button>
                      <Button tone="primary" onClick={() => setProjectDialog('new')}>
                        <Icon name="plus" />
                        New project
                      </Button>
                    </div>
                  </header>
                  <div className="workbook-layout home">
                    <div className="reading">
                      {projects.length ? (
                        <>
                          <section className="intents landing-ask" aria-label="Start here">
                            <h2>What do you want to do?</h2>
                            <textarea
                              rows={2}
                              aria-label="Ask, plan, or say what to do"
                              placeholder={
                                {
                                  business:
                                    'Ask about a supplier, plan a schedule, or say what to do',
                                  school: 'Ask about a reading, plan the week, or say what to do',
                                  software: 'Ask about the code, plan a change, or say what to do',
                                  personal: 'Ask a question, plan something, or say what to do',
                                  mix: 'Ask, plan, or say what to do',
                                }[settings.onboarding.work ?? 'mix']
                              }
                              value={landingText}
                              onChange={(e) => setLandingText(e.target.value)}
                              onKeyDown={(e) => {
                                if (
                                  e.key === 'Enter' &&
                                  !e.shiftKey &&
                                  !e.nativeEvent.isComposing
                                ) {
                                  e.preventDefault();
                                  const target =
                                    byRecency.find((p) => p.id === landingProjectId) ?? byRecency[0];
                                  if (target) sendLandingAsk(landingText, target);
                                }
                              }}
                            />
                            <div className="landing-row">
                              <label className="landing-project">
                                <span className="caption">In project</span>
                                <select
                                  aria-label="In project"
                                  value={landingProjectId ?? byRecency[0]?.id ?? ''}
                                  onChange={(e) => setLandingProjectId(e.target.value)}
                                >
                                  {byRecency.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <Button
                                tone="primary"
                                disabled={!landingText.trim()}
                                onClick={() => {
                                  const target =
                                    byRecency.find((p) => p.id === landingProjectId) ?? byRecency[0];
                                  if (target) sendLandingAsk(landingText, target);
                                }}
                              >
                                Send
                              </Button>
                            </div>
                          </section>
                          <HelperLine
                            integrations={integrations}
                            settings={settings}
                            saveSettings={saveSettings}
                          />
                          <div className="project-list">
                            {[...projects]
                              .sort(
                                (a, b) =>
                                  (b.status?.needsYou ? 1 : 0) - (a.status?.needsYou ? 1 : 0) ||
                                  (b.lastOpenedAt || b.createdAt).localeCompare(
                                    a.lastOpenedAt || a.createdAt,
                                  ),
                              )
                              .map((p) => (
                                <button
                                  key={p.id}
                                  className="project-row"
                                  onClick={() => openProject(p)}
                                >
                                  <div>
                                    <strong>{p.name}</strong>
                                    {settings.detail === 'technical' && (
                                      <span className="code caption">{p.folder}</span>
                                    )}
                                  </div>
                                  <span className="dotted-leader" />
                                  <span className="project-row-status">
                                    {p.status?.needsYou ? (
                                      <>
                                        <Mark state="waiting" />
                                        Needs your OK
                                      </>
                                    ) : p.status?.working ? (
                                      <>
                                        <Mark state="working" />
                                        Working on {p.status.working} task
                                      </>
                                    ) : p.status?.tasksTotal ? (
                                      `${p.status.tasksDone} of ${p.status.tasksTotal} tasks done`
                                    ) : (
                                      'Ready to begin'
                                    )}
                                  </span>
                                  <span className="caption">
                                    {date(p.lastOpenedAt || p.createdAt)}
                                  </span>
                                </button>
                              ))}
                          </div>
                          <p className="caption">
                            Projects are ordinary folders on this computer.
                            {!projects.some((p) =>
                              p.name.toLowerCase().includes('harbor street'),
                            ) && (
                              <>
                                {' '}
                                <button
                                  className="text-button"
                                  onClick={() => void sampleProject()}
                                >
                                  Try the sample project.
                                </button>
                              </>
                            )}
                          </p>
                        </>
                      ) : (
                        <>
                          <div className="intent-rail">
                            <button className="intent" onClick={() => setProjectDialog('new')}>
                              <span className="pt" aria-hidden="true" />
                              <span>
                                <strong>New project</strong>
                                <span>Start from an empty folder.</span>
                              </span>
                            </button>
                            <button className="intent" onClick={() => setProjectDialog('open')}>
                              <span className="pt" aria-hidden="true" />
                              <span>
                                <strong>Open a folder as a project</strong>
                                <span>Use documents you already have.</span>
                              </span>
                            </button>
                            <button className="intent" onClick={() => void sampleProject()}>
                              <span className="pt" aria-hidden="true" />
                              <span>
                                <strong>Try the sample project</strong>
                                <span>Three example documents to explore on this computer.</span>
                              </span>
                            </button>
                          </div>
                          <p className="prose">
                            {
                              {
                                business:
                                  "For example: a project for a restaurant's menus, suppliers and schedules.",
                                school:
                                  "For example: a project for this semester's courses, readings and deadlines.",
                                software:
                                  'For example: a project for a codebase, its plans and its history.',
                                personal:
                                  "For example: a project for a renovation, a trip, or a game you're building.",
                                mix: "For example: one project per thing you're working on.",
                              }[settings.onboarding.work ?? 'mix']
                            }
                          </p>
                          <p className="caption">Projects are ordinary folders on this computer.</p>
                        </>
                      )}
                    </div>
                  </div>
                </main>
              )}
            </div>
          </>
        )}
      </div>
      {error && (
        <div className="error-bar" role="alert">
          <Mark state="fault" />
          <span>{error}</span>
          <Button tone="quiet" onClick={() => setError('')}>
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
              Diomedes keeps a history of every change it makes inside this folder.
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
        <Modal title="Open a project" onClose={() => setSearch(false)}>
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
