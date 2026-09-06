import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Change,
  Conversation,
  IntegrationStatus,
  Mode,
  Need,
  Page,
  ProjectState,
  Route,
  Session,
  Settings,
  Task,
  TaskState,
  ThreadPermission,
  MailboxMessage,
  Slot,
  TeamMember,
  TeamState,
} from '../shared/types';
import { api } from './api';
import {
  Button,
  ChangeCard,
  Empty,
  Mark,
  Modal,
  Notice,
  SessionStatus,
  stateNames,
  time,
  titleCase,
} from './components';

/**
 * The Desk: every thread, every helper and every change on one screen.
 * Same project, same objects and the same words as the Book; only the amount on screen differs.
 * Runs entirely on the existing project API; the thread endpoints are used when the server has them.
 */
interface Props {
  projectId: string;
  settings: Settings;
  integrations: IntegrationStatus[];
  saveSettings: (value: Settings) => Promise<void>;
  openInBook: (page: Page) => void;
  report: (e: unknown) => void;
  online: boolean;
}

type RightTab = 'board' | 'changes' | 'files';

const MAX_PANES = 3;

type ThreadWithPermission = Conversation;
const engineNames: Record<TeamMember['engine'], string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  'oh-my-pi': 'oh-my-pi',
  sample: 'Sample work',
  probe: 'Probe',
};
const emptyTeam: TeamState = { members: [], messages: [], runs: [] };

export function Desk({
  projectId,
  settings,
  integrations,
  saveSettings,
  openInBook,
  report,
  online,
}: Props) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [panes, setPanes] = useState<string[]>([]);
  const [tab, setTab] = useState<RightTab>('board');
  const [busy, setBusy] = useState(false);
  const [previewNeed, setPreviewNeed] = useState<Need | null>(null);
  const [pendingOnline, setPendingOnline] = useState<null | (() => Promise<void>)>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [team, setTeam] = useState<TeamState>(emptyTeam);
  const [teamAvailable, setTeamAvailable] = useState(false);
  const [adding, setAdding] = useState<null | { name: string; role: 'lead' | 'member'; engine: 'codex' | 'sample'; model: string }>(null);
  const currentId = useRef(projectId);
  currentId.current = projectId;
  const base = `/projects/${projectId}`;

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
    setPanes([]);
    void load().catch(report);
  }, [load, report]);
  useEffect(() => {
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load().catch(report), 70);
    };
    ['state', 'project', 'tasks', 'needs', 'session', 'history', 'review', 'status', 'conversations', 'team']
      .forEach((n) => es.addEventListener(n, update));
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [load, report]);

  const threads = [...(state?.conversations ?? [])].sort((a, b) =>
    threadTime(b).localeCompare(threadTime(a)),
  );
  // Open the newest thread by default so the Desk never starts empty for a project with history.
  useEffect(() => {
    if (state && !panes.length && threads.length) setPanes([threads[0].id]);
  }, [state, panes.length, threads.length]);

  const waiting = state?.needs.filter((n) => n.state === 'open') ?? [];
  const running =
    state?.sessions.filter((s) => ['queued', 'working', 'waiting'].includes(s.state)) ?? [];
  const changes = state?.changes.filter((c) => c.state === 'waiting') ?? [];
  const codex = integrations.find((i) => i.id === 'codex');
  const helpers: { id: Route; name: string; engine: string; status: string; available: boolean }[] =
    [
      {
        id: 'sample',
        name: 'Sample work',
        engine: 'On this computer, scripted',
        status: 'Ready',
        available: true,
      },
      {
        id: 'codex',
        name: 'Codex',
        engine: 'ChatGPT subscription, native sign-in',
        status: !settings.services?.codex
          ? 'Off. Turn on in Settings > Services.'
          : codex?.available
            ? codex.status || 'Ready'
            : codex?.status || 'Not available',
        available: !!settings.services?.codex && !!codex?.available,
      },
    ];

  function openPane(id: string) {
    setPanes((p) => (p.includes(id) ? p : [...p, id].slice(-MAX_PANES)));
  }
  function closePane(id: string) {
    setPanes((p) => p.filter((x) => x !== id));
  }
  async function newThread(taskId?: string) {
    await perform(async () => {
      try {
        // No name: the service names task threads after their task and the rest 'New thread'.
        const c = await api<Conversation>(`${base}/threads`, 'POST', taskId ? { taskId } : {});
        await load();
        openPane(c.id);
      } catch (e) {
        // Older service without the thread routes: open the project thread instead.
        if (isMissingRoute(e)) {
          const project = threads.find((c) => c.attachedTo.kind === 'project');
          if (project) openPane(project.id);
          else report(new Error('Start a thread by sending a message in a pane.'));
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
  async function setPermission(thread: Conversation, permission: ThreadPermission) {
    await perform(async () => {
      await api(`${base}/threads/${thread.id}`, 'PUT', { permission });
      await load();
    });
  }
  async function addMember() {
    if (!adding || !adding.name.trim()) return;
    await perform(async () => {
      const result = await api<{ member: TeamMember; token?: string }>(`${base}/team/members`, 'POST', {
        name: adding.name.trim(),
        role: adding.role,
        engine: adding.engine,
        ...(adding.model.trim() ? { model: adding.model.trim() } : {}),
      });
      setAdding(null);
      await load();
      if (result.member?.threadId) openPane(result.member.threadId);
    });
  }
  async function stopMember(member: TeamMember) {
    await perform(async () => {
      await api(`${base}/team/members/${encodeURIComponent(member.slotId)}/stop`, 'POST', {});
      await load();
    });
  }
  async function messageMember(member: TeamMember, content: string) {
    await perform(async () => {
      await api(`${base}/team/messages`, 'POST', { to: member.slotId, content });
      await load();
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
  async function startTask(task: Task, route: Route, consent = false) {
    if (route === 'codex' && !consent && (settings.permissions.sending || !settings.seen.onlineServiceNotice)) {
      setPendingOnline(() => () => startTask(task, route, true));
      return;
    }
    await perform(async () => {
      await api(`${base}/work/start`, 'POST', { taskId: task.id, route, sources: [], consent });
      setPendingOnline(null);
      if (route === 'codex' && !settings.seen.onlineServiceNotice)
        await saveSettings({ ...settings, seen: { ...settings.seen, onlineServiceNotice: true } });
      await load();
    });
  }
  async function reviewChange(change: Change, action: 'keep' | 'undo') {
    await perform(async () => {
      await api(`${base}/review/${encodeURIComponent(change.id)}`, 'POST', { action });
      await load();
    });
  }
  async function send(thread: Conversation, mode: Mode, text: string, route: Route, consent = false) {
    if (route === 'codex' && !consent && (settings.permissions.sending || !settings.seen.onlineServiceNotice)) {
      setPendingOnline(() => () => send(thread, mode, text, route, true));
      return;
    }
    await perform(async () => {
      await api(`${base}/ask`, 'POST', {
        mode,
        text,
        route,
        consent,
        threadId: thread.id,
        attachedTo: thread.attachedTo,
      });
      setPendingOnline(null);
      if (route === 'codex' && !settings.seen.onlineServiceNotice)
        await saveSettings({ ...settings, seen: { ...settings.seen, onlineServiceNotice: true } });
      await load();
    });
  }

  if (!state)
    return (
      <div className="desk desk-loading">
        <p className="caption">Opening the Desk...</p>
      </div>
    );

  const project = state.project;
  return (
    <div className={`desk ${!online ? 'disconnected' : ''}`}>
      <aside className="desk-side" aria-label="Project, threads and team">
        <section className="desk-project">
          <h1>{project.name}</h1>
          <p className="caption">
            {waiting.length
              ? `${waiting.length} ${waiting.length === 1 ? 'thing needs' : 'things need'} your OK`
              : running.length
                ? `Working on ${running.length} ${running.length === 1 ? 'task' : 'tasks'}`
                : project.status.tasksTotal
                  ? `${project.status.tasksDone} of ${project.status.tasksTotal} tasks done`
                  : 'Ready when you are'}
          </p>
          <div className="actions">
            <Button tone="quiet" onClick={() => openInBook('home')}>
              Open the Book
            </Button>
          </div>
        </section>
        <section className="desk-threads">
          <header className="desk-side-header">
            <h2>Threads</h2>
            <Button tone="quiet" disabled={busy} onClick={() => void newThread()}>
              New
            </Button>
          </header>
          {!threads.length && (
            <p className="caption">No threads yet. Start one and it is listed here.</p>
          )}
          {threads.map((c) => {
            const task = c.taskId ? state.tasks.find((t) => t.id === c.taskId) : null;
            return (
              <button
                key={c.id}
                className={`desk-thread ${panes.includes(c.id) ? 'open' : ''}`}
                onClick={() => openPane(c.id)}
              >
                <span className="desk-thread-name">{threadName(c, state)}</span>
                <span className="caption">
                  {task
                    ? `Task: ${task.name}`
                    : c.attachedTo.kind === 'project'
                      ? 'Project'
                      : `${titleCase(c.attachedTo.kind)}: ${c.attachedTo.ref}`}
                  {' · '}
                  {c.turns.length} {c.turns.length === 1 ? 'turn' : 'turns'}
                  {' · '}
                  {time(threadTime(c))}
                </span>
              </button>
            );
          })}
        </section>
        <section className="desk-team">
          <header className="desk-side-header">
            <h2>Team</h2>
            {teamAvailable && (
              <Button
                tone="quiet"
                disabled={busy}
                onClick={() =>
                  setAdding({
                    name: '',
                    role: team.members.some((m) => m.role === 'lead') ? 'member' : 'lead',
                    engine: helpers.find((h) => h.id === 'codex')?.available ? 'codex' : 'sample',
                    model: '',
                  })
                }
              >
                Add
              </Button>
            )}
          </header>
          {team.members.map((m) => (
            <div key={m.slotId} className="desk-member">
              <span className="desk-helper-line">
                <Mark
                  state={
                    m.status === 'working'
                      ? 'working'
                      : m.status === 'waiting'
                        ? 'waiting'
                        : m.status === 'error'
                          ? 'fault'
                          : m.status === 'stopped'
                            ? 'todo'
                            : 'done'
                  }
                />
                <strong>{m.name}</strong>
                <span className="caption">{m.role === 'lead' ? 'Leader' : 'Member'}</span>
              </span>
              <span className="caption">
                {engineNames[m.engine]}
                {m.model ? `, ${m.model}` : ''}
                {' · '}
                {m.status === 'idle'
                  ? 'Idle'
                  : m.status === 'working'
                    ? 'Working'
                    : m.status === 'waiting'
                      ? 'Waiting for you'
                      : m.status === 'stopped'
                        ? 'Stopped'
                        : 'Something went wrong'}
              </span>
              <span className="actions desk-member-actions">
                {m.threadId && (
                  <Button tone="quiet" onClick={() => openPane(m.threadId!)}>
                    Thread
                  </Button>
                )}
                {m.status !== 'stopped' && (
                  <Button tone="quiet" disabled={busy} onClick={() => void stopMember(m)}>
                    Stop
                  </Button>
                )}
              </span>
            </div>
          ))}
          {teamAvailable && !team.members.length && (
            <p className="caption desk-honest">No team yet. Add a leader, then members.</p>
          )}
          <h3 className="desk-side-sub">Helpers available</h3>
          {helpers.map((h) => (
            <div key={h.id} className="desk-helper">
              <span className="desk-helper-line">
                <Mark state={h.available ? 'done' : 'todo'} />
                <strong>{h.name}</strong>
              </span>
              <span className="caption">{h.engine}</span>
              <span className="caption">{h.status}</span>
            </div>
          ))}
          <p className="caption desk-honest">
            {teamAvailable
              ? 'Members talk through the Diomedes team service. One engine run at a time in this version; the leader cannot spawn members yet.'
              : 'One helper works at a time in this version. The team service is being built; see the plan in the project notes.'}
          </p>
        </section>
      </aside>

      <section className="desk-panes" aria-label="Helper panes">
        {!panes.length && (
          <Empty
            title="Open a thread"
            action={
              <Button tone="primary" disabled={busy} onClick={() => void newThread()}>
                New thread
              </Button>
            }
          >
            <p>Pick a thread on the left, or start a new one. Up to three sit side by side.</p>
          </Empty>
        )}
        {panes.map((id) => {
          const thread = state.conversations.find((c) => c.id === id);
          if (!thread) return null;
          return (
            <Pane
              key={id}
              thread={thread}
              state={state}
              settings={settings}
              helpers={helpers}
              busy={busy}
              online={online}
              waiting={waiting.filter((n) => threadOwnsNeed(thread, n, state))}
              running={running.filter((s) => s.taskId && s.taskId === thread.taskId)}
              member={team.members.find((m) => m.threadId === id) ?? null}
              mail={team.messages.filter((m) => {
                const member = team.members.find((x) => x.threadId === id);
                return member ? m.to === member.slotId || m.from === member.slotId : m.threadId === id;
              })}
              members={team.members}
              close={() => closePane(id)}
              rename={() => setRenaming({ id, name: threadName(thread, state) })}
              send={(mode, text, route) => void send(thread, mode, text, route)}
              message={(member, text) => void messageMember(member, text)}
              setPermission={(perm) => void setPermission(thread, perm)}
              decide={(n, r, a) => void resolveNeed(n, r, a)}
              show={setPreviewNeed}
              stop={(sid) => void stopSession(sid)}
            />
          );
        })}
      </section>

      <aside className="desk-right" aria-label="Board, changes and files">
        <div className="segmented desk-tabs" role="tablist">
          {(['board', 'changes', 'files'] as RightTab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {titleCase(t)}
              {t === 'changes' && changes.length ? ` ${changes.length}` : ''}
              {t === 'board' && waiting.length ? ` ${waiting.length}` : ''}
            </button>
          ))}
        </div>
        <div className="desk-right-body">
          {tab === 'board' && (
            <div className="desk-board">
              {(Object.keys(stateNames) as TaskState[]).map((s) => (
                <section
                  key={s}
                  className="desk-column"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const task = state.tasks.find(
                      (t) => t.id === e.dataTransfer.getData('text/plain'),
                    );
                    if (task && task.state !== s) void moveTask(task, s);
                  }}
                >
                  <header>
                    <Mark state={s} />
                    <h3>{stateNames[s]}</h3>
                    <span className="caption push-right">
                      {state.tasks.filter((t) => t.state === s).length}
                    </span>
                  </header>
                  {state.tasks
                    .filter((t) => t.state === s)
                    .map((task) => {
                      const session = running.find((x) => x.taskId === task.id);
                      const need = state.needs.find(
                        (n) => n.id === task.needId && n.state === 'open',
                      );
                      const thread = state.conversations.find((c) => c.taskId === task.id);
                      return (
                        <article
                          key={task.id}
                          className={`task-card ${task.state}`}
                          draggable={!session}
                          onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
                        >
                          <p className="task-title">{task.name}</p>
                          <p className="caption owner">
                            {task.owner === 'you'
                              ? 'You'
                              : session
                                ? `${session.engine.name}${session.engine.model ? `, ${session.engine.model}` : ''}, with your OK`
                                : 'Diomedes, with your OK'}
                          </p>
                          {task.reason && (
                            <p className={task.reason === 'needs-ok' ? 'signal-text caption' : 'caption'}>
                              {task.reason === 'needs-ok'
                                ? 'Needs your OK'
                                : task.reason === 'changes-ready'
                                  ? 'Changes ready to look at'
                                  : 'Something went wrong'}
                            </p>
                          )}
                          <div className="actions">
                            {task.state === 'todo' && (
                              <>
                                {helpers
                                  .filter((h) => h.available)
                                  .map((h) => (
                                    <Button
                                      key={h.id}
                                      tone={h.id === 'sample' ? 'primary' : ''}
                                      disabled={busy || running.length > 0}
                                      onClick={() => void startTask(task, h.id)}
                                    >
                                      Start with {h.name}
                                    </Button>
                                  ))}
                              </>
                            )}
                            {task.state === 'working' && (
                              <Button
                                onClick={() =>
                                  session ? void stopSession(session.id) : void moveTask(task, 'done')
                                }
                              >
                                {session ? 'Stop' : 'Mark done'}
                              </Button>
                            )}
                            {task.state === 'waiting' && need && (
                              <>
                                <Button tone="primary" onClick={() => void resolveNeed(need, 'go-ahead')}>
                                  Go ahead
                                </Button>
                                <Button onClick={() => void resolveNeed(need, 'declined')}>
                                  Don't do this
                                </Button>
                                <Button tone="quiet" onClick={() => setPreviewNeed(need)}>
                                  Show me first
                                </Button>
                              </>
                            )}
                            {task.state === 'waiting' && task.reason === 'changes-ready' && (
                              <Button onClick={() => setTab('changes')}>Look at changes</Button>
                            )}
                            {task.state === 'done' && (
                              <Button tone="quiet" onClick={() => void moveTask(task, 'todo')}>
                                Reopen
                              </Button>
                            )}
                            {thread ? (
                              <Button tone="quiet" onClick={() => openPane(thread.id)}>
                                Thread
                              </Button>
                            ) : (
                              <Button tone="quiet" disabled={busy} onClick={() => void newThread(task.id)}>
                                Thread
                              </Button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  {!state.tasks.some((t) => t.state === s) && (
                    <p className="caption column-empty">
                      {
                        {
                          todo: 'Add a task in the Book, or make tasks from a plan.',
                          working: 'Nothing is running.',
                          waiting: 'Nothing needs your attention.',
                          done: 'Finished tasks will appear here.',
                        }[s]
                      }
                    </p>
                  )}
                </section>
              ))}
            </div>
          )}
          {tab === 'changes' && (
            <div className="desk-changes">
              {!changes.length ? (
                <Empty title="Nothing waiting">
                  <p>Changes a helper makes are listed here until you keep or undo them.</p>
                </Empty>
              ) : (
                changes.map((c) => (
                  <ChangeCard key={c.id} change={c} detail="technical">
                    <Button tone="primary" disabled={busy} onClick={() => void reviewChange(c, 'keep')}>
                      Keep
                    </Button>
                    <Button disabled={busy} onClick={() => void reviewChange(c, 'undo')}>
                      Undo
                    </Button>
                  </ChangeCard>
                ))
              )}
              {changes.length > 0 && (
                <div className="actions">
                  <Button tone="quiet" onClick={() => openInBook('review')}>
                    Open Review in the Book
                  </Button>
                </div>
              )}
            </div>
          )}
          {tab === 'files' && (
            <div className="desk-files">
              {!state.documents.length ? (
                <Empty title="No files yet">
                  <p>Documents and plans in the project folder are listed here.</p>
                </Empty>
              ) : (
                [...state.documents]
                  .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
                  .map((d) => (
                    <div key={d.path} className="document-row static">
                      <span>{d.path}</span>
                      <span className="dotted-leader" />
                      <span className="caption">
                        {d.kind}, {time(d.changedAt)}
                        {d.hasChangesWaiting ? ', changes waiting' : ''}
                      </span>
                    </div>
                  ))
              )}
              <div className="actions">
                <Button tone="quiet" onClick={() => openInBook('documents')}>
                  Edit in the Book
                </Button>
                <Button tone="quiet" onClick={() => openInBook('history')}>
                  History
                </Button>
              </div>
            </div>
          )}
        </div>
      </aside>

      {previewNeed && (
        <Modal title={`Diomedes wants to ${previewNeed.what}`} onClose={() => setPreviewNeed(null)}>
          <p className="prose">
            {previewNeed.why} {previewNeed.consequence}
          </p>
          {previewNeed.files.length > 0 && (
            <p className="caption">Files: {previewNeed.files.join(', ')}</p>
          )}
          {previewNeed.preview?.map((c) => (
            <ChangeCard key={c.id} change={c} detail="technical">
              {null}
            </ChangeCard>
          ))}
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
              onClick={() => {
                void resolveNeed(previewNeed, 'go-ahead', true);
                setPreviewNeed(null);
              }}
            >
              Go ahead for this whole task
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
      {pendingOnline && (
        <Modal title="Use an online service?" onClose={() => setPendingOnline(null)}>
          <p className="prose">
            Diomedes will use an online service for this. Your instructions are sent to that
            service. You can change this in Settings &gt; Services.
          </p>
          <p className="caption">
            This uses your existing ChatGPT subscription. There is no paid API fallback.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setPendingOnline(null)}>Not now</Button>
            <Button tone="primary" disabled={busy} onClick={() => void pendingOnline()}>
              Continue
            </Button>
          </div>
        </Modal>
      )}
      {adding && (
        <Modal title="Add a helper to the team" onClose={() => setAdding(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addMember();
            }}
          >
            <label className="field">
              Name
              <input
                autoFocus
                value={adding.name}
                onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                placeholder="Luna, Codex lead, Reviewer..."
                maxLength={60}
                required
              />
            </label>
            <label className="field">
              Role
              <select
                value={adding.role}
                onChange={(e) => setAdding({ ...adding, role: e.target.value as 'lead' | 'member' })}
              >
                <option value="lead">Leader: plans and hands out tasks</option>
                <option value="member">Member: takes direction</option>
              </select>
            </label>
            <label className="field">
              Engine
              <select
                value={adding.engine}
                onChange={(e) => setAdding({ ...adding, engine: e.target.value as 'codex' | 'sample' })}
              >
                {helpers.map((h) => (
                  <option key={h.id} value={h.id} disabled={!h.available}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Model (optional)
              <input
                value={adding.model}
                onChange={(e) => setAdding({ ...adding, model: e.target.value })}
                placeholder="Leave empty for the engine's default"
              />
            </label>
            <p className="caption">
              The helper gets its own thread. It talks to the team through the Diomedes team
              service and asks before anything that matters.
            </p>
            <div className="dialog-actions">
              <Button onClick={() => setAdding(null)}>Cancel</Button>
              <Button type="submit" tone="primary" disabled={busy || !adding.name.trim()}>
                Add to the team
              </Button>
            </div>
          </form>
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

function Pane({
  thread,
  state,
  settings,
  helpers,
  busy,
  online,
  waiting,
  running,
  member,
  mail,
  members,
  close,
  rename,
  send,
  message,
  setPermission,
  decide,
  show,
  stop,
}: {
  thread: ThreadWithPermission;
  state: ProjectState;
  settings: Settings;
  helpers: { id: Route; name: string; available: boolean }[];
  busy: boolean;
  online: boolean;
  waiting: Need[];
  running: Session[];
  member: TeamMember | null;
  mail: MailboxMessage[];
  members: TeamMember[];
  close: () => void;
  rename: () => void;
  send: (mode: Mode, text: string, route: Route) => void;
  message: (member: TeamMember, text: string) => void;
  setPermission: (permission: ThreadPermission) => void;
  decide: (need: Need, resolution: 'go-ahead' | 'declined', allow?: boolean) => void;
  show: (need: Need) => void;
  stop: (sessionId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('ask');
  const lastHelper = [...thread.turns].reverse().find((t) => t.role === 'diomedes');
  const [route, setRoute] = useState<Route>(lastHelper?.route ?? 'sample');
  const [text, setText] = useState('');
  const [details, setDetails] = useState(false);
  const [toTeam, setToTeam] = useState(false);
  const permission: ThreadPermission = thread.permission ?? 'show-first';
  const nameOf = (slot: Slot) =>
    slot === 'owner' ? 'You' : (members.find((m) => m.slotId === slot)?.name ?? slot);
  const timeline: { at: string; node: ReactNode }[] = [
    ...thread.turns.map((t, i) => ({
      at: t.at,
      node: (
        <div className={`turn ${t.role}`} key={t.id || `${thread.id}:${i}`}>
          <p className="caption turn-meta">
            {t.role === 'you' ? 'You' : t.route === 'codex' ? 'Codex' : 'Diomedes, sample work'}
            {t.mode !== 'ask' ? ` · ${titleCase(t.mode)}` : ''}
            <time>{time(t.at)}</time>
          </p>
          <p className="desk-turn-text">{t.text}</p>
        </div>
      ),
    })),
    ...mail.map((m) => ({
      at: m.createdAt,
      node: (
        <div className={`turn team ${m.from === 'owner' ? 'you' : ''}`} key={m.id}>
          <p className="caption turn-meta">
            <span>
              {nameOf(m.from)} to {nameOf(m.to)}
              {m.type === 'shutdown_request'
                ? ' · asked to stop'
                : m.type === 'idle_notification'
                  ? ' · idle'
                  : m.summary === 'interrupt'
                    ? ' · interrupt'
                    : ' · team message'}
            </span>
            <time>{time(m.createdAt)}</time>
          </p>
          <p className="desk-turn-text">{m.content}</p>
          {m.files && m.files.length > 0 && <p className="caption">Files: {m.files.join(', ')}</p>}
        </div>
      ),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [thread.turns.length, running.length]);
  const task = thread.taskId ? state.tasks.find((t) => t.id === thread.taskId) : null;
  const helperName = lastHelper?.route === 'codex' ? 'Codex' : lastHelper ? 'Sample work' : 'No helper yet';
  const live = running[0];
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (toTeam && member) message(member, value);
    else send(mode, value, route);
    setText('');
  };
  return (
    <article className={`desk-pane ${live ? 'live' : ''} ${waiting.length ? 'needs' : ''}`}>
      <header className="desk-pane-header">
        <div className="desk-pane-title">
          <Mark state={waiting.length ? 'waiting' : live ? 'working' : 'todo'} />
          <button className="desk-pane-name" onClick={rename} title="Rename thread">
            {threadName(thread, state)}
          </button>
        </div>
        <p className="caption desk-pane-meta">
          {member ? `${member.name}, ${member.role === 'lead' ? 'leader' : 'member'} on ${engineNames[member.engine]}` : helperName}
          {live?.engine.model ? `, ${live.engine.model}` : member?.model ? `, ${member.model}` : ''}
          {task ? ` · Task: ${task.name}` : ''}
          {live?.engine.context != null ? ` · Context ${Math.round(live.engine.context)}%` : ''}
        </p>
        <div className="desk-permission" role="group" aria-label="Permission for this thread">
          <div className="segmented compact">
            <button
              className={permission === 'show-first' ? 'active' : ''}
              disabled={busy}
              onClick={() => permission !== 'show-first' && setPermission('show-first')}
            >
              Show me first
            </button>
            <button
              className={permission === 'task' ? 'active' : ''}
              disabled={busy}
              onClick={() => permission !== 'task' && setPermission('task')}
            >
              Go ahead for this task
            </button>
            <button disabled title="Not in this version">
              Full access
            </button>
          </div>
          <span className="caption">
            {permission === 'task'
              ? 'The first OK in a task covers the rest of it. Nothing runs without that first OK.'
              : 'Every change waits for your OK.'}
          </span>
        </div>
        <div className="actions desk-pane-actions">
          {live && (
            <Button tone="quiet" data-stop onClick={() => stop(live.id)}>
              Stop
            </Button>
          )}
          <Button tone="quiet" onClick={close} aria-label="Close pane">
            Close
          </Button>
        </div>
      </header>
      <div className="desk-pane-body" ref={body}>
        {waiting.map((n) => (
          <Notice
            key={n.id}
            need={n}
            decide={(r, a) => decide(n, r, a ?? (r === 'go-ahead' && permission === 'task'))}
            show={() => show(n)}
          />
        ))}
        {!thread.turns.length && !live && (
          <p className="prose small muted">
            {mode === 'ask'
              ? 'Questions and thinking out loud. Nothing in the project changes here.'
              : mode === 'plan'
                ? 'Diomedes writes a plan for you to read before work begins.'
                : 'Give Diomedes a job. It does the work and asks before anything that matters.'}
          </p>
        )}
        {timeline.map((entry) => entry.node)}
        {live && (
          <section className="work-session compact">
            <SessionStatus session={live} detail="technical" name={task?.name} stop={() => stop(live.id)} />
            <div className="work-log">
              {live.log
                .filter((l) => l.level === 'plain' || details)
                .slice(-12)
                .map((l, i) => (
                  <div key={i} className={l.level === 'technical' ? 'technical-log' : ''}>
                    <time>{time(l.time)}</time>
                    <p>{l.sentence}</p>
                  </div>
                ))}
            </div>
            <Button tone="quiet" onClick={() => setDetails(!details)}>
              {details ? 'Fewer details' : 'All details'}
            </Button>
          </section>
        )}
      </div>
      <footer className="desk-pane-composer">
        <div className="row desk-composer-modes">
          <div className="segmented compact" role="group" aria-label="Mode">
            {(['ask', 'plan', 'work'] as const).map((m) => (
              <button
                key={m}
                className={mode === m && !toTeam ? 'active' : ''}
                onClick={() => {
                  setMode(m);
                  setToTeam(false);
                }}
              >
                {titleCase(m)}
              </button>
            ))}
            {member && (
              <button className={toTeam ? 'active' : ''} onClick={() => setToTeam(true)} title="Send a team message through the Diomedes team service">
                Team
              </button>
            )}
          </div>
        </div>
        <textarea
          aria-label="Message this thread"
          placeholder={
            toTeam && member
              ? `Message ${member.name} through the team service...`
              : mode === 'ask'
                ? 'Ask or think out loud...'
                : mode === 'plan'
                  ? 'What should the plan cover?'
                  : 'What should be done?'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
        />
        <div className="row desk-pane-send">
          {!toTeam && (
            <select aria-label="Helper" value={route} onChange={(e) => setRoute(e.target.value as Route)}>
              {helpers.map((h) => (
                <option key={h.id} value={h.id} disabled={!h.available}>
                  {h.name}
                </option>
              ))}
            </select>
          )}
          <Button tone="primary push-right" disabled={busy || !online || !text.trim()} onClick={submit}>
            {busy ? 'Working...' : 'Send'}
          </Button>
        </div>
      </footer>
    </article>
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
