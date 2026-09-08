import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Change,
  Conversation,
  IntegrationStatus,
  Mode,
  Need,
  Page,
  Project,
  ProjectState,
  Route,
  Settings,
  Slot,
  Task,
  TaskState,
  TeamMember,
  TeamState,
  ThreadPermission,
  UsageSnapshot,
} from '../../shared/types';
import { api } from '../api';
import { Button, Modal, time, titleCase } from '../components';
import { Mark } from './Mark';
import { Rail, type RailItem } from './Rail';
import { ThreadView } from './ThreadView';
import { Ledger } from './Ledger';
import { Picker } from './Picker';
import { BoardView } from './BoardView';
import { TeamView } from './TeamView';
import { Palette } from './Palette';
import type { ShellView } from './types';
import './console.css';

interface ShellProps {
  projectId: string;
  projects: Project[];
  settings: Settings;
  integrations: IntegrationStatus[];
  usage: UsageSnapshot[];
  saveSettings: (value: Settings) => Promise<void>;
  openInBook: (page: Page) => void;
  openEngineSettings: () => void;
  onOpenProject: (project: Project) => void;
  onShowProjects: () => void;
  onOpenSettings: () => void;
  report: (e: unknown) => void;
  online: boolean;
}

const emptyTeam: TeamState = { members: [], messages: [], runs: [] };

/**
 * The Field shell: top strip, thread rail and the Thread/Board/Team screens
 * on the app's existing data flow. Board, Team and the Ctrl+K palette are
 * placeholders in this pass; the shell already switches between the views.
 */
export function Shell({
  projectId,
  projects,
  settings,
  integrations,
  usage,
  saveSettings,
  openInBook,
  openEngineSettings,
  onOpenProject,
  onShowProjects,
  onOpenSettings,
  report,
  online,
}: ShellProps) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ShellView>('Thread');
  const [mode, setMode] = useState<Mode>('ask');
  const [route, setRoute] = useState<Route>('sample');
  const [toTeam, setToTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [previewNeed, setPreviewNeed] = useState<Need | null>(null);
  const [team, setTeam] = useState<TeamState>(emptyTeam);
  const [teamAvailable, setTeamAvailable] = useState(false);
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const currentId = useRef(projectId);
  currentId.current = projectId;
  const base = `/projects/${projectId}`;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1600);
  }, []);

  const load = useCallback(async () => {
    const data = await api<ProjectState>(`/projects/${projectId}/state`);
    if (currentId.current === projectId) setState(data);
    try {
      const t = await api<TeamState>(`/projects/${projectId}/team`);
      if (currentId.current === projectId) {
        setTeam({ members: t.members ?? [], messages: t.messages ?? [], runs: t.runs ?? [] });
        setTeamAvailable(true);
      }
    } catch (e) {
      // A service without the team routes yet: the roster stays empty and says so.
      if (!isMissingRoute(e)) throw e;
      if (currentId.current === projectId) setTeamAvailable(false);
    }
  }, [projectId]);
  const perform = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        report(e);
      } finally {
        setBusy(false);
      }
    },
    [report],
  );
  useEffect(() => {
    setState(null);
    setSelectedId(null);
    setView('Thread');
    void load().catch(report);
  }, [load, report]);
  useEffect(() => {
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load().catch(report), 70);
    };
    ['state', 'project', 'tasks', 'needs', 'session', 'history', 'review', 'status', 'conversations', 'team'].forEach(
      (n) => es.addEventListener(n, update),
    );
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [load, report]);

  const threads = [...(state?.conversations ?? [])].sort((a, b) =>
    threadTime(b).localeCompare(threadTime(a)),
  );
  // Open the newest thread by default so the shell never starts empty for a project with history.
  useEffect(() => {
    if (state && threads.length && !threads.some((t) => t.id === selectedId)) {
      setSelectedId(threads[0].id);
    }
  }, [state, selectedId, threads.length]);
  const selected = selectedId ? (state?.conversations.find((c) => c.id === selectedId) ?? null) : null;
  useEffect(() => {
    if (selected) setMode(selected.mode ?? 'ask');
  }, [selected?.id, selected?.mode]);
  useEffect(() => {
    if (selected) {
      const lastHelper = [...selected.turns].reverse().find((t) => t.role === 'diomedes');
      setRoute(lastHelper?.route ?? 'sample');
      setToTeam(false);
    }
  }, [selected?.id]);

  const waiting = state?.needs.filter((n) => n.state === 'open') ?? [];
  const sessions = state?.sessions ?? [];
  const liveByTask = (taskId: string) =>
    sessions.find((s) => s.taskId === taskId && ['queued', 'working', 'waiting'].includes(s.state)) ?? null;
  const taskOf = (thread: Conversation | null) =>
    thread?.taskId ? (state?.tasks.find((t) => t.id === thread.taskId) ?? null) : null;
  const selectedTask = taskOf(selected);
  const selectedSessions = selectedTask
    ? sessions.filter((s) => s.taskId === selectedTask.id)
    : [];
  const selectedMember = team.members.find((m) => m.threadId === selected?.id) ?? null;
  const selectedMail = team.messages.filter((m) => {
    const member = selected ? team.members.find((x) => x.threadId === selected.id) : undefined;
    return member ? m.to === member.slotId || m.from === member.slotId : m.threadId === selected?.id;
  });
  const helpers = integrations
    .filter((i) => i.adapter === 'ready' || i.adapter === 'planned')
    .map((i) => ({
      id: i.id,
      available:
        i.kind === 'sample' ? i.available : i.available && settings.services?.[i.id] === true,
    }));
  // Only these ids can start work or take a thread; the Route contract has no other engine.
  const routeHelpers = helpers.filter((h) => h.id === 'sample' || h.id === 'codex');
  const firstRoute = (routeHelpers[0]?.id ?? 'sample') as Route;

  async function newThread(taskId?: string) {
    await perform(async () => {
      try {
        // No name: the service names task threads after their task and the rest 'New thread'.
        const c = await api<Conversation>(`${base}/threads`, 'POST', taskId ? { taskId } : {});
        await load();
        setSelectedId(c.id);
        setView('Thread');
      } catch (e) {
        // Older service without the thread routes: open the project thread instead.
        if (isMissingRoute(e)) {
          const project = threads.find((c) => c.attachedTo.kind === 'project');
          if (project) {
            setSelectedId(project.id);
            setView('Thread');
          } else report(new Error('Start a thread by sending a message in a pane.'));
        } else throw e;
      }
    });
  }
  async function rename() {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    await perform(async () => {
      await api(`${base}/threads/${renaming.id}`, 'PUT', { name });
      await load();
      setRenaming(null);
    });
  }
  async function setRequested(thread: Conversation, requested: Conversation['requested']) {
    await perform(async () => {
      await api(`${base}/threads/${thread.id}`, 'PUT', { requested });
      await load();
    });
  }
  async function setPermission(thread: Conversation, permission: ThreadPermission) {
    await perform(async () => {
      await api(`${base}/threads/${thread.id}`, 'PUT', { permission });
      await load();
    });
  }
  function changeMode(next: Mode) {
    if (!selected || next === mode) return;
    const previous = mode;
    setMode(next);
    setToTeam(false);
    void api(`${base}/threads/${selected.id}`, 'PUT', { mode: next }).catch((e: unknown) => {
      report(e);
      setMode(previous);
    });
  }
  function pick(requested: Conversation['requested'], engine: string) {
    if (!selected) return;
    if (engine === 'codex') setRoute('codex');
    else if (engine === 'sample') setRoute('sample');
    void setRequested(selected, requested);
  }
  async function postMessage(to: Slot, content: string) {
    await perform(async () => {
      await api(`${base}/team/messages`, 'POST', { to, content });
      await load();
    });
  }
  async function messageMember(member: TeamMember, content: string) {
    await postMessage(member.slotId, content);
  }
  async function stopMember(member: TeamMember) {
    await perform(async () => {
      await api(`${base}/team/members/${encodeURIComponent(member.slotId)}/stop`, 'POST', {});
      await load();
    });
  }
  // A helper parked on "Show me first" waits for the person to start it on its messages.
  async function wakeMember(member: TeamMember) {
    await perform(async () => {
      await api(`${base}/team/members/${encodeURIComponent(member.slotId)}/wake`, 'POST', {});
      await load();
      if (member.threadId) {
        setSelectedId(member.threadId);
        setView('Thread');
      }
    });
  }
  async function resolveNeed(need: Need, resolution: 'go-ahead' | 'declined', allowForTask = false) {
    await perform(async () => {
      await api(`${base}/needs/${need.id}/resolve`, 'POST', { resolution, allowForTask });
      await load();
    });
  }
  async function stopSession(id: string) {
    await perform(async () => {
      await api(`${base}/work/${id}/stop`, 'POST', {});
      await load();
    });
  }
  async function moveTask(task: Task, next: TaskState) {
    await perform(async () => {
      await api(`${base}/tasks/${task.id}`, 'PUT', { state: next });
      await load();
    });
  }
  async function startTask(task: Task, route: Route) {
    await perform(async () => {
      await api(`${base}/work/start`, 'POST', { taskId: task.id, route, sources: [], consent: true });
      await load();
    });
  }
  async function reviewChange(change: Change, action: 'keep' | 'undo') {
    await perform(async () => {
      await api(`${base}/review/${encodeURIComponent(change.id)}`, 'POST', { action });
      await load();
    });
  }
  async function send(
    thread: Conversation,
    mode: Mode,
    text: string,
    route: Route,
    failing?: { document?: string; text?: string },
    sources?: string[],
  ) {
    await perform(async () => {
      await api(`${base}/ask`, 'POST', {
        mode,
        text,
        route,
        consent: true,
        threadId: thread.id,
        attachedTo: thread.attachedTo,
        ...(sources?.length ? { sources } : {}),
        ...(mode === 'fix' && failing ? { failing } : {}),
      });
      await load();
    });
  }

  function scrollToNeed(need: Need) {
    window.setTimeout(() => {
      document.getElementById(`need-${need.id}`)?.scrollIntoView({ block: 'center' });
    }, 80);
  }
  function openTaskThread(task: Task) {
    const thread = state?.conversations.find((c) => c.taskId === task.id) ?? null;
    if (thread) {
      setSelectedId(thread.id);
      setView('Thread');
    } else {
      void newThread(task.id);
    }
  }

  if (!state) {
    return (
      <div className="console console-loading">
        <p className="caption">Opening the Console...</p>
      </div>
    );
  }

  const project = state.project;
  const railItems: RailItem[] = threads.map((c) => {
    const task = c.taskId ? state.tasks.find((t) => t.id === c.taskId) : null;
    const lastTurn = c.turns.at(-1)?.text.trim() ?? '';
    return {
      id: c.id,
      name: threadName(c, state),
      time: time(threadTime(c)).toLowerCase(),
      sub: task ? task.name : lastTurn ? lastTurn.slice(0, 60) : 'Nothing said yet',
    };
  });
  const openTasks = state.tasks.filter((t) => t.state !== 'done').length;
  const policy: 'first' | 'go' = selected?.permission === 'task' ? 'go' : 'first';
  const taskWorker = selectedTask
    ? (liveByTask(selectedTask.id)?.engine.name ??
      selectedMember?.name ??
      (selectedTask.owner === 'you' ? 'You' : 'Diomedes'))
    : '';
  const latestTaskSession = selectedSessions.length
    ? [...selectedSessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)!
    : null;

  return (
    <div className={`console ${!online ? 'disconnected' : ''}`}>
      <header className="top">
        <Mark />
        <nav className="crumb" aria-label="Open projects">
          <button type="button" onClick={onShowProjects}>
            Projects
          </button>
          <span>/</span>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={p.id === projectId ? 'on' : ''}
              onClick={() => p.id !== projectId && onOpenProject(p)}
            >
              {p.id === projectId ? <b>{p.name}</b> : p.name}
            </button>
          ))}
        </nav>
        <div className="top-right">
          {selected && (
            <Picker
              thread={selected}
              mode={mode}
              route={route}
              live={selectedTask ? liveByTask(selectedTask.id) !== null : false}
              integrations={integrations}
              settings={settings}
              busy={busy}
              onPick={pick}
            />
          )}
          <span
            className="mono link"
            role="button"
            tabIndex={0}
            title="Find a task, worker, model or project and act on it"
            onClick={() => say('The Ctrl+K palette arrives in the next pass.')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') say('The Ctrl+K palette arrives in the next pass.');
            }}
          >
            Ctrl K
          </span>
          <button type="button" onClick={onOpenSettings}>
            Settings
          </button>
          <div className="surface-menu">
            <button
              type="button"
              aria-label="Interface detail menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              ···
            </button>
            {menuOpen && (
              <div className="pmenu open" role="menu">
                <p className="caption">Surface</p>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void saveSettings({
                      ...settings,
                      surface: 'workbook',
                      detail: settings.detail === 'technical' ? 'standard' : settings.detail,
                    });
                  }}
                >
                  The Workbook
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void saveSettings({ ...settings, surface: 'console' });
                  }}
                >
                  The Console
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="stage">
        <Rail
          items={railItems}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setView('Thread');
          }}
          onNew={() => void newThread()}
          view={view}
          onView={setView}
          openTasks={openTasks}
          workerCount={team.members.length}
          onHome={() => openInBook('home')}
          onHistory={() => openInBook('history')}
          onEngines={openEngineSettings}
        />
        {view === 'Thread' && selected && (
          <section className="screen on" id="scrThread">
            <ThreadView
              thread={selected}
              title={threadName(selected, state)}
              task={selectedTask}
              sessions={selectedSessions}
              mail={selectedMail}
              members={team.members}
              member={selectedMember}
              needs={waiting.filter((n) => threadOwnsNeed(selected, n, state))}
              settings={settings}
              mode={mode}
              route={route}
              toTeam={toTeam}
              busy={busy}
              online={online}
              onMode={changeMode}
              onTeam={setToTeam}
              onPermission={(p) => void setPermission(selected, p)}
              onRename={() => setRenaming({ id: selected.id, name: threadName(selected, state) })}
              onSend={(m, text, r, failing, sources) => void send(selected, m, text, r, failing, sources)}
              onMessage={(m, text) => void messageMember(m, text)}
              onResolve={(n, res, allow) => void resolveNeed(n, res, allow)}
              onPreview={setPreviewNeed}
              onStopSession={(id) => void stopSession(id)}
              onOpenBoard={() => setView('Board')}
            />
            <Ledger
              project={project}
              state={state}
              task={selectedTask}
              taskWorker={taskWorker}
              mode={mode}
              running={selectedTask ? liveByTask(selectedTask.id) !== null : false}
              latest={latestTaskSession}
              openNeeds={waiting}
              onBoard={() => setView('Board')}
              onTeam={() => setView('Team')}
              onReviewNeed={(need) => {
                const owner =
                  state.conversations.find((c) => c.taskId && c.taskId === need.taskId) ??
                  state.conversations.find((c) => c.attachedTo.kind === 'project') ??
                  null;
                if (owner && owner.id !== selectedId) setSelectedId(owner.id);
                setView('Thread');
                scrollToNeed(need);
              }}
            />
          </section>
        )}
        {view === 'Thread' && !selected && (
          <section className="screen on" id="scrThread">
            <main className="work" aria-label="No thread">
              <div className="col head">
                <h1>No threads yet</h1>
              </div>
              <div className="col">
                <p className="caption">Start one and it is listed in the rail.</p>
                <button type="button" disabled={busy} onClick={() => void newThread()}>
                  New thread
                </button>
              </div>
            </main>
            <Ledger
              project={project}
              state={state}
              task={null}
              taskWorker=""
              mode={mode}
              running={false}
              latest={null}
              openNeeds={waiting}
              onBoard={() => setView('Board')}
              onTeam={() => setView('Team')}
              onReviewNeed={(need) => {
                const owner =
                  state.conversations.find((c) => c.taskId && c.taskId === need.taskId) ??
                  state.conversations.find((c) => c.attachedTo.kind === 'project') ??
                  null;
                if (owner) setSelectedId(owner.id);
                setView('Thread');
                scrollToNeed(need);
              }}
            />
          </section>
        )}
        {view === 'Board' && (
          <section className="screen on" aria-label="Board">
            <BoardView
              project={project}
              state={state}
              tasks={state.tasks}
              policy={policy}
              focusTaskId={selectedTask?.id}
              busy={busy}
              onStart={async (task) => {
                await startTask(task, firstRoute);
              }}
              onPause={async (task) => {
                const running = liveByTask(task.id);
                if (running) await stopSession(running.id);
              }}
              onReview={(task) => {
                openTaskThread(task);
                const need =
                  task.needId != null
                    ? (waiting.find((n) => n.id === task.needId) ?? null)
                    : (waiting.find((n) => n.taskId === task.id) ?? null);
                if (need) scrollToNeed(need);
              }}
              onRoute={async (task, to) => {
                await perform(async () => {
                  await api(`${base}/tasks/${task.id}`, 'PUT', { assignedTo: to });
                  await load();
                });
              }}
              onReopen={async (task) => {
                await moveTask(task, 'todo');
              }}
              onOpenTeam={() => setView('Team')}
              onOpenThread={(task) => openTaskThread(task)}
            />
          </section>
        )}
        {view === 'Team' && (
          <section className="screen on" aria-label="Team">
            <TeamView
              project={project}
              state={state}
              members={team.members}
              mail={team.messages}
              runs={team.runs}
              focusTaskId={selectedTask?.id}
              usage={usage}
              busy={busy}
              onMessage={async (to, text) => {
                const target =
                  to === 'diomedes'
                    ? (team.members.find((m) => m.role === 'lead') ?? team.members[0] ?? null)
                    : (team.members.find((m) => m.slotId === to) ?? null);
                if (!target) {
                  report(new Error('No team member to message.'));
                  return;
                }
                await postMessage(target.slotId, text);
              }}
              onStop={async (m) => {
                await stopMember(m);
              }}
              onWake={async (m) => {
                await wakeMember(m);
              }}
              onOpenThread={(m) => {
                if (m.threadId) {
                  setSelectedId(m.threadId);
                  setView('Thread');
                }
              }}
            />
          </section>
        )}
      </div>

      <Palette open={false} entries={() => []} onClose={() => {}} />
      {toast && (
        <div className="toast show" role="status">
          {toast}
        </div>
      )}

      {previewNeed && (
        <Modal title={`Diomedes wants to ${previewNeed.what}`} onClose={() => setPreviewNeed(null)}>
          <p className="prose">
            {previewNeed.why} {previewNeed.consequence}
          </p>
          <div className="dialog-actions">
            <Button
              onClick={() => {
                void resolveNeed(previewNeed, 'declined');
                setPreviewNeed(null);
              }}
            >
              Don't do this
            </Button>
            <Button
              tone="primary"
              onClick={() => {
                void resolveNeed(previewNeed, 'go-ahead');
                setPreviewNeed(null);
              }}
            >
              Go ahead
            </Button>
          </div>
        </Modal>
      )}
      {renaming && (
        <Modal title="Rename thread" onClose={() => setRenaming(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <label className="field">
              Name
              <input
                autoFocus
                value={renaming.name}
                onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                maxLength={120}
                required
              />
            </label>
            <div className="dialog-actions">
              <Button onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" tone="primary" disabled={busy}>
                Rename
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function threadTime(c: Conversation) {
  return c.updatedAt ?? c.turns.at(-1)?.at ?? c.createdAt ?? '';
}
function threadName(c: Conversation, state: ProjectState) {
  if (c.name) return c.name;
  const first = c.turns.find((t) => t.role === 'you')?.text.trim();
  if (first) return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first;
  if (c.attachedTo.kind === 'task')
    return `Thread for ${state.tasks.find((t) => t.id === c.attachedTo.ref)?.name ?? 'a task'}`;
  return c.attachedTo.kind === 'project' ? 'Project thread' : `${titleCase(c.attachedTo.kind)}: ${c.attachedTo.ref}`;
}
function threadOwnsNeed(thread: Conversation, need: Need, state: ProjectState) {
  if (thread.taskId) return need.taskId === thread.taskId;
  // Without a task link, project-level threads carry the needs that no task thread owns.
  return (
    thread.attachedTo.kind === 'project' &&
    !state.conversations.some((c) => c.taskId && c.taskId === need.taskId)
  );
}
function isMissingRoute(e: unknown) {
  return typeof e === 'object' && e !== null && 'status' in e && (e as { status: number }).status === 404;
}
