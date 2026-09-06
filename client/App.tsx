import { useCallback, useEffect, useRef, useState } from 'react';
import type { IntegrationStatus, Page, Project, Settings, Surface } from '../shared/types';
import { api } from './api';
import { Brand, Button, Empty, Icon, Mark, Modal, date, titleCase } from './components';
import { Desk } from './Desk';
import { Setup } from './Setup';
import { SettingsPage } from './Settings';
import { Workspace } from './Workspace';

/** Older settings have no surface; 'technical' detail meant the audience the Desk now serves. */
function surfaceOf(settings: Settings): Surface {
  return settings.surface ?? (settings.detail === 'technical' ? 'desk' : 'book');
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [showSettings, setShowSettings] = useState(false);
  const [account, setAccount] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(true);
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const report = useCallback(
    (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The request could not be completed.'),
    [],
  );
  const refreshProjects = useCallback(async () => {
    const data = await api<{ projects: Project[] }>('/projects');
    setProjects(data.projects);
  }, []);
  const refreshIntegrations = useCallback(async () => {
    try {
      const data = await api<{ integrations: IntegrationStatus[] }>('/integrations');
      setIntegrations(data.integrations);
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
  useEffect(() => {
    void (async () => {
      try {
        const [s, p] = await Promise.all([
          api<Settings>('/settings'),
          api<{ projects: Project[] }>('/projects'),
        ]);
        setSettings(s);
        setProjects(p.projects);
        const id = s.openProjects.at(-1);
        if (id && p.projects.some((x) => x.id === id)) {
          setSelected(id);
          setPage(s.lastPage[id] ?? 'home');
        }
        void refreshIntegrations();
      } catch (e) {
        setOnline(false);
        report(e);
      }
    })();
  }, [refreshIntegrations, report]);
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
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [refreshProjects, report]);
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const surface = surfaceOf(settings);
    root.dataset.surface = surface;
    // The Desk shows the machinery; components that gate on 'technical' follow it.
    root.dataset.detail = surface === 'desk' ? 'technical' : settings.detail;
    root.dataset.package = settings.appearance.package;
    root.dataset.motion = settings.appearance.motion;
    for (const [name, value] of Object.entries({
      'ui-scale': settings.appearance.interfaceScale ?? 1,
      'read-scale': settings.appearance.readingScale ?? 1,
      'code-scale': settings.appearance.codeScale ?? 1,
    }))
      root.style.setProperty(`--dm-${name}`, String(value));
  }, [settings]);
  const openProject = useCallback(
    (project: Project) => {
      setSelected(project.id);
      setShowSettings(false);
      setPage('home');
      const s = settingsRef.current;
      if (s)
        void api<Settings>('/settings', 'PUT', {
          ...s,
          openProjects: [...s.openProjects.filter((id) => id !== project.id), project.id].slice(-6),
        })
          .then(setSettings)
          .catch(report);
    },
    [report],
  );
  const navigate = useCallback(
    (p: Page) => {
      setPage(p);
      setShowSettings(false);
      const s = settingsRef.current;
      if (s && selected)
        void api<Settings>('/settings', 'PUT', { ...s, lastPage: { ...s.lastPage, [selected]: p } })
          .then(setSettings)
          .catch(report);
    },
    [report, selected],
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      }
      if (e.ctrlKey && /^[1-8]$/.test(e.key) && selected) {
        e.preventDefault();
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
  }, [selected, navigate]);
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
  const current = projects.find((p) => p.id === selected);
  const surface: Surface = settings ? surfaceOf(settings) : 'book';
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

  if (!settings)
    return (
      <div className="initial-state">
        <Brand />
        <p className="prose">{error || 'Opening your working book...'}</p>
        {error && <Button onClick={() => location.reload()}>Try again</Button>}
      </div>
    );
  return (
    <>
      <div className="app">
        {settings.onboarding.resumeAt !== 'done' ? (
          <Setup settings={settings} save={saveSettings} busy={busy} />
        ) : (
          <>
            <header className="top-bar">
              <button
                className="brand-button"
                onClick={() => {
                  setSelected(null);
                  setShowSettings(false);
                }}
                aria-label="Diomedes projects"
              >
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
                    {p.name}
                  </button>
                ))}
              </nav>
              <div className="top-right">
                <div className="top-status" role="status">
                  {status && (
                    <>
                      <Mark
                        state={!online ? 'fault' : needs ? 'waiting' : running ? 'working' : 'done'}
                      />
                      <span>{status}</span>
                    </>
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
                      {(['book', 'desk'] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => {
                            void saveSettings({
                              ...settings,
                              surface: s,
                              detail:
                                s === 'book' && settings.detail === 'technical'
                                  ? 'standard'
                                  : settings.detail,
                            });
                            setAccount(false);
                          }}
                        >
                          <Mark state={s === surface ? 'working' : 'todo'} />
                          {s === 'book' ? 'The Book' : 'The Desk'}
                        </button>
                      ))}
                      {surface === 'book' && (
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
            <div
              className={`page-frame ${needs && current?.status?.needsYou ? 'needs-attention' : ''} ${!online ? 'disconnected' : ''}`}
            >
              {showSettings ? (
                <SettingsPage
                  settings={settings}
                  save={saveSettings}
                  integrations={integrations}
                  refresh={() => void refreshIntegrations()}
                />
              ) : selected && surface === 'desk' ? (
                <Desk
                  key={`desk:${selected}`}
                  projectId={selected}
                  settings={settings}
                  integrations={integrations}
                  saveSettings={saveSettings}
                  openInBook={(p) => {
                    void saveSettings({
                      ...settings,
                      surface: 'book',
                      detail: settings.detail === 'technical' ? 'standard' : settings.detail,
                    });
                    navigate(p);
                  }}
                  report={report}
                  online={online}
                />
              ) : selected ? (
                <Workspace
                  key={selected}
                  projectId={selected}
                  page={page}
                  navigate={navigate}
                  settings={settings}
                  integrations={integrations}
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
                  <div className="book-layout">
                    <div className="reading">
                      <p className="prose">
                        Work lives in projects. A project holds its documents, plans, tasks and
                        history in one place.
                      </p>
                      {projects.length ? (
                        <div className="project-list">
                          {projects.map((p) => (
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
                              <span className="caption">{date(p.lastOpenedAt || p.createdAt)}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty title="Start with a project">
                          <p>
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
                        </Empty>
                      )}
                      {settings.detail === 'guided' && (
                        <p className="caption">
                          Want more detail on screen? Settings &gt; Interface detail.
                        </p>
                      )}
                    </div>
                    <aside className="margin">
                      <section className="block">
                        <h3>Try a sample project</h3>
                        <p className="prose small">
                          Explore plans, tasks, changes and Restore with three example documents.
                          Sample work stays on this computer.
                        </p>
                        <Button disabled={busy} onClick={() => void sampleProject()}>
                          Open sample project
                        </Button>
                      </section>
                      <section className="block">
                        <h3>Your files stay yours</h3>
                        <p className="caption">
                          Projects use ordinary folders. No special file format is needed to begin.
                        </p>
                      </section>
                    </aside>
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
