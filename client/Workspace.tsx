import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Change,
  Conversation,
  DocumentContent,
  HistoryEntry,
  IntegrationStatus,
  Mode,
  Need,
  Page,
  ProjectState,
  RestoreConflict,
  Route,
  Settings,
  Task,
  TaskCandidate,
  TaskState,
} from '../shared/types';
import { api, ApiError } from './api';
import {
  Button,
  ChangeCard,
  Empty,
  HelperLine,
  Icon,
  Mark,
  Modal,
  Notice,
  SessionStatus,
  askDraftKey,
  date,
  pages,
  stateNames,
  time,
  titleCase,
} from './components';

type RestoreRequest = {
  entry: HistoryEntry;
  paths?: string[];
  conflicts?: RestoreConflict[];
  inProgress?: { sessionId: string; taskId: string; path: string };
};
interface Props {
  projectId: string;
  page: Page;
  navigate: (page: Page) => void;
  settings: Settings;
  integrations: IntegrationStatus[];
  saveSettings: (s: Settings) => Promise<void>;
  report: (e: unknown) => void;
  online: boolean;
}
export function Workspace({
  projectId,
  page,
  navigate,
  settings,
  integrations,
  saveSettings,
  report,
  online,
}: Props) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [path, setPath] = useState('');
  const [doc, setDoc] = useState<DocumentContent | null>(null);
  const [buffer, setBuffer] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem(askDraftKey(projectId)) ? 'ask' : 'ask';
    } catch {
      return 'ask';
    }
  });
  const [prompt, setPrompt] = useState(() => {
    try {
      const carried = localStorage.getItem(askDraftKey(projectId));
      if (carried != null) {
        localStorage.removeItem(askDraftKey(projectId));
        return carried;
      }
    } catch {
      // Storage is unavailable; start with an empty box.
    }
    return '';
  });
  const [route, setRoute] = useState<Route>('sample');
  const [attached, setAttached] = useState('');
  const [pendingOnline, setPendingOnline] = useState(false);
  const [modal, setModal] = useState<
    'document' | 'plan' | 'task' | 'snapshot' | 'folder' | 'attach' | null
  >(null);
  const [name, setName] = useState('');
  const [candidates, setCandidates] = useState<(TaskCandidate & { selected: boolean })[] | null>(
    null,
  );
  const [restore, setRestore] = useState<RestoreRequest | null>(null);
  const [historyView, setHistoryView] = useState<{ entry: HistoryEntry; files: Change[] } | null>(
    null,
  );
  const [filter, setFilter] = useState('All');
  const [feedback, setFeedback] = useState<{ text: string; undo?: () => void } | null>(null);
  const [taskDetail, setTaskDetail] = useState<Task | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [logDetails, setLogDetails] = useState(false);
  const [editorConflict, setEditorConflict] = useState(false);
  const [sessionNote, setSessionNote] = useState('');
  const [workSessionId, setWorkSessionId] = useState('');
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [previewNeed, setPreviewNeed] = useState<Need | null>(null);
  const [showMore, setShowMore] = useState(false);
  const currentId = useRef(projectId);
  currentId.current = projectId;
  const openedDraft = useRef(false);
  const dirty = !!doc && buffer !== doc.text;
  const base = `/projects/${projectId}`;
  const detail = settings.detail;
  const load = useCallback(async () => {
    const data = await api<ProjectState>(`/projects/${projectId}/state`);
    if (currentId.current === projectId) setState(data);
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
    setDoc(null);
    setPath('');
    setBuffer('');
    setEditing(false);
    setHistoryView(null);
    setThreadId(null);
    setRenaming(null);
    openedDraft.current = false;
    void load().catch(report);
  }, [load, report]);
  useEffect(() => {
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load().catch(report), 70);
    };
    [
      'state',
      'project',
      'tasks',
      'needs',
      'session',
      'history',
      'review',
      'status',
      'conversations',
    ].forEach((n) => es.addEventListener(n, update));
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [load, report]);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [dirty]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 60000);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    if (!state || path) return;
    if (!openedDraft.current) {
      openedDraft.current = true;
      try {
        const draftPath = localStorage.getItem(`diomedes.draft-path.${projectId}`);
        if (draftPath) {
          void openDocument(
            draftPath,
            state.project.plans.includes(draftPath) ? 'plan' : 'documents',
          );
          return;
        }
      } catch (e) {
        report(e);
      }
    }
    if (page === 'plan' && state.project.plans[0])
      void openDocument(state.project.plans[0], 'plan');
  }, [state, page, path]);
  useEffect(() => {
    if (!doc || !path) return;
    try {
      const key = `diomedes.draft.${projectId}.${path}`;
      if (dirty) {
        localStorage.setItem(key, JSON.stringify({ ...doc, draft: buffer }));
        localStorage.setItem(`diomedes.draft-path.${projectId}`, path);
      } else {
        localStorage.removeItem(key);
        if (localStorage.getItem(`diomedes.draft-path.${projectId}`) === path)
          localStorage.removeItem(`diomedes.draft-path.${projectId}`);
      }
    } catch (e) {
      report(
        new Error(
          `Your unsaved writing could not be backed up in this browser. Save the document before leaving. ${e instanceof Error ? e.message : ''}`,
        ),
      );
    }
  }, [doc, path, buffer, dirty, projectId, report]);
  useEffect(() => {
    if (!settings.services?.codex) setRoute('sample');
  }, [settings.services?.codex]);
  function say(text: string, undo?: () => void) {
    setFeedback({ text, undo });
  }
  async function openDocument(nextPath: string, nextPage: Page = 'documents') {
    if (dirty && nextPath !== path) {
      report(
        new Error(
          'Save your changes before opening another document. Your writing is still in the editor.',
        ),
      );
      return;
    }
    await perform(async () => {
      const d = await api<DocumentContent>(
        `${base}/documents/read?path=${encodeURIComponent(nextPath)}`,
      );
      if (currentId.current !== projectId) return;
      let draft: { text: string; sha: string; draft: string } | null = null;
      const saved = localStorage.getItem(`diomedes.draft.${projectId}.${nextPath}`);
      if (saved) {
        const candidate: unknown = JSON.parse(saved);
        if (
          candidate &&
          typeof candidate === 'object' &&
          'draft' in candidate &&
          typeof candidate.draft === 'string' &&
          'text' in candidate &&
          typeof candidate.text === 'string' &&
          'sha' in candidate &&
          typeof candidate.sha === 'string'
        )
          draft = { text: candidate.text, sha: candidate.sha, draft: candidate.draft };
      }
      setDoc(draft ? { ...d, text: draft.text, sha: draft.sha } : d);
      setBuffer(draft?.draft ?? d.text);
      setPath(nextPath);
      setEditing(!!draft);
      if (draft) say('Recovered your unsaved writing.');
      navigate(nextPage);
      await api(`${base}/left-off`, 'PUT', { page: nextPage, document: nextPath, scroll: 0 });
    });
  }
  function go(p: Page) {
    if (dirty && p !== page) {
      report(new Error('Save your changes before leaving the editor. Your writing is still here.'));
      return;
    }
    setHistoryView(null);
    navigate(p);
  }
  async function saveDocument() {
    if (!doc) return;
    setBusy(true);
    try {
      const result = await api<{ sha: string; entryId: string }>(
        `${base}/documents/write`,
        'POST',
        { path, text: buffer, baseSha: doc.sha },
      );
      setDoc({ path, text: buffer, sha: result.sha });
      setEditing(false);
      setEditorConflict(false);
      say('Changes saved.');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setEditorConflict(true);
      else report(e);
    } finally {
      setBusy(false);
    }
  }
  async function newItem() {
    const type = modal;
    await perform(async () => {
      if (type === 'task') {
        await api(`${base}/tasks`, 'POST', { name: name.trim(), owner: 'you' });
        say('Task added.');
      } else if (type === 'snapshot') {
        await api(`${base}/history/label`, 'POST', { label: name.trim() });
        say('Version saved.');
      } else {
        const file = /\.(md|txt)$/i.test(name) ? name : `${name}.md`;
        await api(`${base}/documents/create`, 'POST', {
          path: file,
          text: `# ${name.replace(/\.(md|txt)$/i, '')}\n\n`,
          kind: type === 'plan' ? 'plan' : 'markdown',
        });
        setModal(null);
        setName('');
        await load();
        await openDocument(file, type === 'plan' ? 'plan' : 'documents');
        setEditing(true);
        return;
      }
      setModal(null);
      setName('');
      await load();
    });
  }
  async function findTasks() {
    if (!path) return;
    if (dirty) {
      report(new Error('Save this plan before making tasks from it.'));
      return;
    }
    await perform(async () => {
      const result = await api<{ found: TaskCandidate[] }>(`${base}/plans/find-tasks`, 'POST', {
        path,
      });
      setCandidates(result.found.map((x) => ({ ...x, selected: true })));
    });
  }
  async function addTasks() {
    await perform(async () => {
      const items =
        candidates?.filter((c) => c.selected).map(({ selected: _selected, ...c }) => c) ?? [];
      await api(`${base}/plans/add-tasks`, 'POST', { path, items });
      setCandidates(null);
      setDoc(null);
      setPath('');
      await load();
      say(`Added ${items.length} tasks.`);
      navigate('tasks');
    });
  }
  async function startTask(task: Task, consent = false) {
    if (route === 'codex' && !consent) {
      setPendingTask(task);
      return;
    }
    await perform(async () => {
      const sources = attached ? [attached] : task.from ? [task.from.plan] : [];
      await api(`${base}/work/start`, 'POST', { taskId: task.id, route, sources, consent });
      setPendingTask(null);
      setWorkSessionId('');
      navigate('work');
      await load();
    });
  }
  async function stopSession(id: string) {
    await perform(async () => {
      await api(`${base}/work/${id}/stop`, 'POST', {});
      await load();
      say('Stopped. Changes already made are in History.');
    });
  }
  async function moveTask(task: Task, next: TaskState) {
    if (task.state === next) return;
    await perform(async () => {
      await api(`${base}/tasks/${task.id}`, 'PUT', { state: next });
      await load();
      say(`Moved ${task.name} to ${stateNames[next]}.`);
    });
  }
  async function resolveNeed(
    need: Need,
    resolution: 'go-ahead' | 'declined',
    allowForTask = false,
  ) {
    await perform(async () => {
      await api(`${base}/needs/${need.id}/resolve`, 'POST', { resolution, allowForTask });
      await load();
      say(resolution === 'go-ahead' ? 'You said go ahead.' : 'That step will not be done.');
    });
  }
  function showNeed(need: Need) {
    if (need.preview?.length) {
      setPreviewNeed(need);
      return;
    }
    const file = need.files.find((f) => state?.documents.some((d) => d.path === f));
    if (file) void openDocument(file);
    else {
      setTaskDetail(state?.tasks.find((t) => t.id === need.taskId) ?? null);
    }
  }
  function needCard(n: Need) {
    return (
      <Notice
        key={n.id}
        need={n}
        decide={(r, a) => void resolveNeed(n, r, a)}
        show={() => showNeed(n)}
      />
    );
  }
  async function viewEntry(entry: HistoryEntry) {
    await perform(async () => {
      const result = await api<{ files: Change[] }>(`${base}/history/${entry.id}/changes`);
      setHistoryView({ entry, files: result.files });
      navigate('history');
    });
  }
  async function restoreEntry(request: RestoreRequest, mode?: 'all' | 'unchanged-only' | 'copies') {
    setBusy(true);
    try {
      const result = await api<{ entryId: string; conflicts: RestoreConflict[] }>(
        `${base}/history/${request.entry.id}/restore`,
        'POST',
        { ...(request.paths ? { files: request.paths } : {}), ...(mode ? { mode } : {}) },
      );
      setRestore(null);
      setHistoryView(null);
      await load();
      say(
        'Files restored. The restore is listed in History.',
        () =>
          void perform(async () => {
            await api(`${base}/history/${result.entryId}/restore`, 'POST', {});
            await load();
            say('The restore was undone.');
          }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.data.conflicts || e.data.inProgress))
        setRestore({
          ...request,
          conflicts: e.data.conflicts as RestoreConflict[] | undefined,
          inProgress: e.data.inProgress as RestoreRequest['inProgress'],
        });
      else report(e);
    } finally {
      setBusy(false);
    }
  }
  async function reviewChange(change: Change, action: 'keep' | 'undo') {
    await perform(async () => {
      try {
        await api(`${base}/review/${encodeURIComponent(change.id)}`, 'POST', { action });
        await load();
        say(action === 'keep' ? 'Change kept.' : 'Change undone.');
      } catch (e) {
        if (action === 'undo' && e instanceof ApiError && e.status === 409) {
          const entry = state?.history.find((h) => h.id === change.entryId);
          if (entry)
            setRestore({
              entry,
              paths: [change.path],
              conflicts: e.data.conflicts as RestoreConflict[] | undefined,
            });
          else throw e;
        } else throw e;
      }
    });
  }
  async function reviewAll(action: 'keep' | 'undo') {
    await perform(async () => {
      await api(`${base}/review/all`, 'POST', { action });
      await load();
      say(action === 'keep' ? 'Kept all changes.' : 'Undid all changes.');
    });
  }
  const allThreads = [...(state?.conversations ?? [])].sort((a, b) =>
    threadTime(b).localeCompare(threadTime(a)),
  );
  const pageThreads = allThreads.filter(
    (c) =>
      c.attachedTo.kind === 'project' ||
      (attached &&
        (c.attachedTo.kind === 'document' || c.attachedTo.kind === 'plan') &&
        c.attachedTo.ref === attached),
  );
  const selectedThread =
    (threadId ? allThreads.find((c) => c.id === threadId) : undefined) ?? pageThreads[0] ?? null;
  const selectedThreadId = selectedThread?.id ?? null;
  const recentThreads = allThreads.filter((c) => c.turns.length > 0).slice(0, 3);
  function openThread(id: string) {
    setThreadId(id);
    go('ask');
  }
  async function newThread() {
    await perform(async () => {
      const c = await api<Conversation>(`${base}/threads`, 'POST', attached ? { attachedTo: { kind: 'document', ref: attached } } : {});
      await load();
      setThreadId(c.id);
      say('New thread started.');
    });
  }
  async function renameThread() {
    if (!renaming) return;
    const next = renaming.name.trim();
    if (!next) return;
    const id = renaming.id;
    await perform(async () => {
      await api(`${base}/threads/${id}`, 'PUT', { name: next });
      await load();
      setRenaming(null);
      say('Thread renamed.');
    });
  }
  async function send(consent = false) {
    if (!prompt.trim()) return;
    if (
      route === 'codex' &&
      !consent &&
      (settings.permissions.sending || !settings.seen.onlineServiceNotice)
    ) {
      setPendingOnline(true);
      return;
    }
    if (mode === 'plan' && dirty) {
      report(new Error('Save your plan before asking for a new version.'));
      return;
    }
    const sentThreadId = selectedThreadId;
    await perform(async () => {
      const result = await api<{ document?: string; session?: unknown }>(`${base}/ask`, 'POST', {
        mode,
        text: prompt.trim(),
        route,
        consent,
        ...(sentThreadId ? { threadId: sentThreadId } : {}),
        attachedTo: {
          kind: attached ? 'document' : page === 'plan' && path ? 'plan' : 'project',
          ref: attached || (page === 'plan' ? path : projectId),
        },
        ...(attached ? { sources: [attached] } : {}),
      });
      setPrompt('');
      setPendingOnline(false);
      if (route === 'codex' && !settings.seen.onlineServiceNotice)
        await saveSettings({ ...settings, seen: { ...settings.seen, onlineServiceNotice: true } });
      if (!sentThreadId && !result.document) {
        const data = await api<ProjectState>(`/projects/${projectId}/state`);
        if (currentId.current === projectId) {
          setState(data);
          const newest = [...data.conversations]
            .filter(
              (c) =>
                c.attachedTo.kind === 'project' ||
                (attached &&
                  (c.attachedTo.kind === 'document' || c.attachedTo.kind === 'plan') &&
                  c.attachedTo.ref === attached),
            )
            .sort((a, b) => threadTime(b).localeCompare(threadTime(a)))[0];
          setThreadId(newest?.id ?? null);
        }
      } else await load();
      if (result.document) {
        await openDocument(result.document, 'plan');
      } else navigate(mode === 'work' ? 'work' : 'ask');
    });
  }
  const newDialog = (m: typeof modal) => {
    setName('');
    setModal(m);
  };
  const waiting = state?.needs.filter((n) => n.state === 'open') ?? [];
  const running =
    state?.sessions.filter((s) => ['queued', 'working', 'waiting'].includes(s.state)) ?? [];
  const changes = state?.changes.filter((c) => c.state === 'waiting') ?? [];
  const todo = state?.tasks.filter((t) => t.state === 'todo') ?? [];
  const workSession =
    state?.sessions.find((s) => s.id === workSessionId) ?? running[0] ?? state?.sessions.at(-1);
  const workTask = state?.tasks.find((t) => t.id === workSession?.taskId);
  const reviewTask = state?.tasks.find((t) => t.id === changes[0]?.taskId);
  const reviewSession = state?.sessions.find((s) => s.id === changes[0]?.sessionId);
  const workThread =
    workTask ? (state?.conversations.find((c) => c.taskId === workTask.id) ?? null) : null;
  const taskDetailThread = taskDetail
    ? (state?.conversations.find((c) => c.taskId === taskDetail.id) ?? null)
    : null;
  const contentTitle =
    page === 'work' && workTask
      ? workTask.name
      : page === 'review' && changes.length
        ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} from ${reviewTask?.name ?? 'Diomedes'}`
        : page === 'home'
          ? (state?.project.name ?? 'Home')
          : page === 'history' && historyView
            ? historyView.entry.sentence
            : titleCase(page);
  const composer = (
    <section className="composer" aria-label="Ask box">
      <div className="segmented" role="group" aria-label="Work mode">
        {(['ask', 'plan', 'work'] as const).map((m) => (
          <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {titleCase(m)}
          </button>
        ))}
      </div>
      <p className="caption mode-line">
        {mode === 'ask'
          ? 'Diomedes answers. Nothing in the project changes.'
          : mode === 'plan'
            ? 'Diomedes writes a plan for you to read before work begins.'
            : 'Diomedes makes the changes. Everything is recorded in History.'}
      </p>
      {attached && (
        <div className="attachment">
          <span>{attached}</span>
          <button aria-label="Remove attachment" onClick={() => setAttached('')}>
            x
          </button>
        </div>
      )}
      <textarea
        aria-label="Ask, plan, or say what to do"
        placeholder="Ask, plan, or say what to do..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            void send();
          }
        }}
        rows={2}
      />
      <div className="actions composer-actions">
        <Button tone="quiet" onClick={() => setModal('attach')}>
          Attach a document
        </Button>
        <Button
          tone="primary push-right"
          disabled={busy || !online || !prompt.trim()}
          onClick={() => void send()}
        >
          {busy ? 'Working...' : 'Send'}
        </Button>
      </div>
      <div className="route-line">
        {settings.services?.codex ? (
          <label>
            Service
            <select value={route} onChange={(e) => setRoute(e.target.value as Route)}>
              <option value="sample">Sample work</option>
              <option
                value="codex"
                disabled={!integrations.find((i) => i.id === 'codex')?.available}
              >
                {detail === 'technical' ? 'Codex / ChatGPT subscription' : 'Online service'}
              </option>
            </select>
          </label>
        ) : (
          <span className="caption">Sample work, on this computer</span>
        )}
      </div>
    </section>
  );
  const headerActions: Record<Page, ReactNode> = {
    home: (
      <>
        <Button onClick={() => newDialog('snapshot')}>Save a version</Button>
        <Button
          onClick={() =>
            void perform(async () => {
              await api(`${base}/open-folder`, 'POST', {});
            })
          }
        >
          Open folder
        </Button>
      </>
    ),
    ask: <Button onClick={() => setModal('attach')}>Attach a document</Button>,
    plan: (
      <>
        <Button onClick={() => newDialog('plan')}>New plan</Button>
        <Button onClick={() => newDialog('snapshot')}>Save a version</Button>
        <Button tone="primary" disabled={!path || busy} onClick={() => void findTasks()}>
          Make tasks from this plan
        </Button>
      </>
    ),
    work:
      workSession && ['queued', 'working', 'waiting'].includes(workSession.state) ? (
        <Button data-stop onClick={() => void stopSession(workSession.id)}>
          <Icon name="stop" />
          Stop
        </Button>
      ) : (
        <Button onClick={() => go('tasks')}>Open Tasks</Button>
      ),
    review: (
      <>
        <Button onClick={() => go('history')}>Open in History</Button>
        <Button disabled={!changes.length || busy} onClick={() => void reviewAll('undo')}>
          Undo all
        </Button>
        <Button
          tone="primary"
          disabled={!changes.length || busy}
          onClick={() => void reviewAll('keep')}
        >
          Keep all
        </Button>
      </>
    ),
    tasks: (
      <>
        <div className="segmented compact">
          <button
            className={settings.tasksView[projectId] !== 'list' ? 'active' : ''}
            onClick={() =>
              void saveSettings({
                ...settings,
                tasksView: { ...settings.tasksView, [projectId]: 'board' },
              })
            }
          >
            Board
          </button>
          <button
            className={settings.tasksView[projectId] === 'list' ? 'active' : ''}
            onClick={() =>
              void saveSettings({
                ...settings,
                tasksView: { ...settings.tasksView, [projectId]: 'list' },
              })
            }
          >
            List
          </button>
        </div>
        <Button onClick={() => go('plan')}>Make tasks from a plan</Button>
        <Button tone="primary" onClick={() => newDialog('task')}>
          New task
        </Button>
      </>
    ),
    documents: (
      <>
        <Button onClick={() => newDialog('document')}>New document</Button>
      </>
    ),
    history: (
      <>
        {historyView && <Button onClick={() => setHistoryView(null)}>Back to History</Button>}
        <Button tone="primary" onClick={() => newDialog('snapshot')}>
          Save a version
        </Button>
      </>
    ),
  };
  const descriptors: Partial<Record<Page, string>> = {
    ask: 'Talk something through. Nothing changes.',
    plan: 'Write down what should happen first.',
    work: 'Diomedes does the task.',
    review: 'Look at changes before living with them.',
  };
  const railCounts: Partial<Record<Page, number>> = {
    work: running.length,
    review: changes.length,
    tasks: waiting.length,
    history: state?.project.counts.historyToday ?? 0,
  };
  const renderTask = (task: Task) => (
    <article
      key={task.id}
      className={`task-card ${task.state}`}
      draggable={!running.some((s) => s.taskId === task.id)}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
    >
      <button className="task-title" onClick={() => setTaskDetail(task)}>
        {task.name}
      </button>
      {task.from && (
        <p className="caption">
          from {task.from.plan}, step {task.from.step}
        </p>
      )}
      <p className="caption owner">
        {task.owner === 'you'
          ? 'You'
          : task.owner === 'diomedes-with-ok'
            ? 'Diomedes, with your OK'
            : 'Diomedes'}
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
            <Button
              tone="primary"
              disabled={busy || running.length > 0}
              onClick={() => void startTask(task)}
            >
              {detail === 'guided' ? 'Do this for me' : 'Start'}
            </Button>
            <Button
              tone="quiet"
              onClick={() =>
                void perform(async () => {
                  await api(`${base}/tasks/${task.id}`, 'PUT', { owner: 'you', state: 'working' });
                  await load();
                })
              }
            >
              I'll do it
            </Button>
          </>
        )}
        {task.state === 'working' && (
          <Button
            onClick={() => {
              const s = running.find((s) => s.taskId === task.id);
              if (s) void stopSession(s.id);
              else void moveTask(task, 'done');
            }}
          >
            {running.some((s) => s.taskId === task.id) ? 'Stop' : 'Mark done'}
          </Button>
        )}
        {task.state === 'waiting' &&
          (task.reason === 'needs-ok' &&
          state?.needs.find((n) => n.id === task.needId && n.state === 'open') ? (
            <div className="task-decision-actions">
              <Button
                tone="signal"
                disabled={busy}
                onClick={() =>
                  void resolveNeed(state!.needs.find((n) => n.id === task.needId)!, 'go-ahead')
                }
              >
                Go ahead
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void resolveNeed(
                    state!.needs.find((n) => n.id === task.needId)!,
                    'go-ahead',
                    true,
                  )
                }
              >
                Go ahead for this whole task
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void resolveNeed(state!.needs.find((n) => n.id === task.needId)!, 'declined')
                }
              >
                Don't do this
              </Button>
              <Button
                tone="quiet"
                onClick={() => showNeed(state!.needs.find((n) => n.id === task.needId)!)}
              >
                Show me first
              </Button>
            </div>
          ) : (
            <Button onClick={() => go('review')}>Look at changes</Button>
          ))}
        {task.state === 'done' && (
          <Button tone="quiet" onClick={() => void moveTask(task, 'todo')}>
            Reopen
          </Button>
        )}
      </div>
    </article>
  );
  /** Changed today, one row per task: its current state, the files it touched, and a way back. */
  function todayRows() {
    if (!state) return [];
    const today = new Date().toDateString();
    const entries = [...state.history]
      .reverse()
      .filter((e) => new Date(e.time).toDateString() === today);
    const rows: ReactNode[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (rows.length >= 4) break;
      const group = entry.taskId ? entries.filter((e) => e.taskId === entry.taskId) : [entry];
      if (entry.taskId) {
        if (seen.has(entry.taskId)) continue;
        seen.add(entry.taskId);
      }
      const task = state.tasks.find((t) => t.id === entry.taskId);
      const files = [...new Set(group.flatMap((e) => e.files.map((f) => f.path)))];
      const latestWithFiles = group.find((e) => e.files.length > 0);
      const parts = [
        task ? stateNames[task.state] : null,
        files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'} changed` : null,
      ].filter(Boolean);
      rows.push(
        <div key={entry.taskId ?? entry.id} className="history-entry compact">
          <time dateTime={entry.time}>{time(entry.time)}</time>
          <div className="entry-body">
            <span>{task?.name ?? entry.sentence}</span>
            {parts.length > 0 && (
              <p className="caption">
                {parts.join(', ')}
                {files.length ? `: ${files.join(', ')}` : ''}
              </p>
            )}
          </div>
          <div className="actions">
            {latestWithFiles && (
              <>
                <Button onClick={() => void viewEntry(latestWithFiles)}>View changes</Button>
                <Button onClick={() => setRestore({ entry: latestWithFiles })}>Restore</Button>
              </>
            )}
          </div>
        </div>,
      );
    }
    return rows;
  }
  const codex = integrations.find((i) => i.id === 'codex');
  void codex;
  function historyRow(entry: HistoryEntry) {
    // The verified helper behind this entry, looked up from its session engine.
    const entrySession = entry.sessionId
      ? state?.sessions.find((s) => s.id === entry.sessionId)
      : undefined;
    const entryHelper =
      entrySession?.engine.verified && entrySession.engine.model
        ? `, Codex, ${entrySession.engine.model}`
        : '';
    return (
      <div key={entry.id} className="history-entry">
        <time dateTime={entry.time}>{time(entry.time)}</time>
        <div className="entry-body">
          <strong>{entry.sentence}</strong>
          {entry.files.length > 0 && (
            <p className="caption">{entry.files.map((f) => f.path).join(', ')}</p>
          )}
          {detail === 'technical' && (
            <p className="code caption">
              {entry.versionId}, {entry.id}
              {entry.commit ? `, maps to commit ${entry.commit}` : ''}
              {entryHelper}
            </p>
          )}
        </div>
        <div className="actions">
          {entry.files.length > 0 && (
            <>
              <Button onClick={() => void viewEntry(entry)}>View changes</Button>
              <Button onClick={() => setRestore({ entry })}>Restore</Button>
            </>
          )}
        </div>
      </div>
    );
  }
  const editor = doc ? (
    <>
      <div className="document-heading">
        <h2>{path.replace(/\.(md|txt)$/i, '')}</h2>
        <div className="actions">
          {editing ? (
            <>
              <span className="caption">{dirty ? 'Unsaved changes' : 'Saved'}</span>
              <Button disabled={!dirty || busy} tone="primary" onClick={() => void saveDocument()}>
                Save changes
              </Button>
              <Button
                onClick={() => {
                  if (dirty) {
                    report(new Error('Save your changes before closing the editor.'));
                    return;
                  }
                  setEditing(false);
                }}
              >
                Close editor
              </Button>
            </>
          ) : (
            <Button onClick={() => setEditing(true)}>Edit document</Button>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          className="document-editor prose"
          aria-label="Document content"
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          spellCheck
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 's') {
              e.preventDefault();
              void saveDocument();
            }
          }}
        />
      ) : (
        <Markdown text={doc.text} />
      )}
      {detail === 'technical' && (
        <details className="technical">
          <summary>Details</summary>
          <p className="code">
            {path}
            <br />
            SHA-256 {doc.sha}
          </p>
        </details>
      )}
    </>
  ) : null;
  return (
    <div className="workspace">
      <nav className="rail" aria-label="Project pages">
        {pages.map((p, i) => (
          <div key={p}>
            {(i === 1 || i === 5) && <div className="rail-separator" />}
            <button
              className={`rail-link ${page === p ? 'active' : ''} ${detail === 'guided' && descriptors[p] ? 'with-description' : ''}`}
              onClick={() => go(p)}
            >
              <span className="rail-line">
                <span>{titleCase(p)}</span>
                {!!railCounts[p] && <span className="rail-count">{railCounts[p]}</span>}
                {detail === 'technical' && !railCounts[p] && (
                  <span className="key-hint">Ctrl+{i + 1}</span>
                )}
              </span>
              {detail === 'guided' && descriptors[p] && (
                <span className="rail-description">{descriptors[p]}</span>
              )}
            </button>
          </div>
        ))}
      </nav>
      <main className="main">
        <header className="page-header">
          <h1>{contentTitle}</h1>
          {page === 'work' && workSession ? (
            <span className="caption">Work, started {time(workSession.startedAt)}</span>
          ) : null}
          <div className="actions push-right">{headerActions[page]}</div>
        </header>
        {!state ? (
          <div className="reading">
            <p className="caption">Opening project...</p>
          </div>
        ) : (
          <>
            {state.project.missing && (
              <div className="notice fault">
                <h3>The project's folder is missing</h3>
                <p>Reconnect the drive to work on documents. History remains available.</p>
              </div>
            )}
            {page === 'tasks' ? (
              <div
                className={`task-board ${settings.tasksView[projectId] === 'list' ? 'list-view' : ''}`}
                aria-label="Tasks board"
              >
                {(Object.keys(stateNames) as TaskState[]).map((s) => (
                  <section
                    key={s}
                    className="task-column"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const task = state.tasks.find(
                        (t) => t.id === e.dataTransfer.getData('text/plain'),
                      );
                      if (task) void moveTask(task, s);
                    }}
                  >
                    <header>
                      <Mark state={s} />
                      <h2>{stateNames[s]}</h2>
                      <span className="caption push-right">
                        {state.tasks.filter((t) => t.state === s).length}
                      </span>
                    </header>
                    {state.tasks.filter((t) => t.state === s).map(renderTask)}
                    {!state.tasks.some((t) => t.state === s) && (
                      <p className="caption column-empty">
                        {
                          {
                            todo: 'Add a task, or make tasks from a plan.',
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
            ) : (
              <div
                className={`book-layout ${running.some((s) => s.state === 'working') ? 'working' : ''} ${page === 'home' ? 'home' : ''}`}
              >
                <div className="reading" key={`${projectId}:${page}`}>
                  {page === 'home' && (
                    <>
                      {!!waiting.length && (
                        <section className="block">
                          <h3 className="section-title">Needs you</h3>
                          {waiting.map(needCard)}
                        </section>
                      )}
                      <section className="intents" aria-label="What do you want to do?">
                        <h2>What do you want to do?</h2>
                        <div className="intent-rail">
                          {(
                            [
                              ['ask', 'Ask a question', 'Talk it through. Nothing in the project changes.'],
                              ['work', 'Get something done', 'Give Diomedes a job. It asks before anything that matters.'],
                              ['plan', 'Make a plan', 'Write down what should happen, in order, before any work.'],
                              ['review', 'Look over what changed', 'See every change waiting for you. Keep it or undo it.'],
                            ] as const
                          ).map(([intent, title, line]) => (
                            <button
                              key={intent}
                              className="intent"
                              onClick={() => {
                                if (intent !== 'review') setMode(intent);
                                go(intent);
                              }}
                            >
                              <span className="square" aria-hidden="true" />
                              <span>
                                <strong>{title}</strong>
                                <span>{line}</span>
                                {intent === 'review' && changes.length > 0 && (
                                  <span className="caption signal-text">
                                    {changes.length} {changes.length === 1 ? 'change' : 'changes'} waiting
                                  </span>
                                )}
                                {intent === 'work' && running.length > 0 && (
                                  <span className="caption">
                                    Working on {running.length} {running.length === 1 ? 'task' : 'tasks'} now
                                  </span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                        <HelperLine
                          integrations={integrations}
                          settings={settings}
                          saveSettings={saveSettings}
                        />
                      </section>
                      {!!recentThreads.length && (
                        <section className="block">
                          <h3 className="section-title">Recent threads</h3>
                          {recentThreads.map((c) => (
                            <button
                              key={c.id}
                              className="document-row"
                              onClick={() => openThread(c.id)}
                            >
                              <span>{threadName(c, state)}</span>
                              <span className="dotted-leader" />
                              <span className="caption">{threadMeta(c)}</span>
                            </button>
                          ))}
                        </section>
                      )}
                      {!!running.length && (
                        <section className="block">
                          <h3 className="section-title">Now</h3>
                          {running.map((s) => (
                            <SessionStatus
                              key={s.id}
                              session={s}
                              detail={detail}
                              name={state.tasks.find((t) => t.id === s.taskId)?.name}
                              stop={() => void stopSession(s.id)}
                            />
                          ))}
                        </section>
                      )}
                      {state.history.some(
                        (e) => new Date(e.time).toDateString() === new Date().toDateString(),
                      ) && (
                        <section className="block changed-today">
                          <h3 className="section-title">Changed today</h3>
                          {todayRows()}
                        </section>
                      )}
                      {!!state.documents.length && (
                        <section className="block">
                          <h3 className="section-title">Where you left off</h3>
                          {[...state.documents]
                            .sort((a, b) =>
                              a.path === state.project.leftOff?.document
                                ? -1
                                : b.path === state.project.leftOff?.document
                                  ? 1
                                  : b.changedAt.localeCompare(a.changedAt),
                            )
                            .slice(0, 3)
                            .map((d) => (
                              <button
                                key={d.path}
                                className="document-row"
                                onClick={() =>
                                  void openDocument(
                                    d.path,
                                    state.project.plans.includes(d.path) ? 'plan' : 'documents',
                                  )
                                }
                              >
                                <span>{d.path}</span>
                                <span className="dotted-leader" />
                                <span className="caption">
                                  {d.kind}, {time(d.changedAt)}
                                </span>
                              </button>
                            ))}
                        </section>
                      )}
                      {!!state.project.plans.length && (
                        <section className="block">
                          <h3 className="section-title">Plans</h3>
                          {state.project.plans.map((p) => (
                            <button
                              key={p}
                              className="document-row"
                              onClick={() => void openDocument(p, 'plan')}
                            >
                              <span>{p}</span>
                              <span className="dotted-leader" />
                              <span className="caption">Open plan</span>
                            </button>
                          ))}
                        </section>
                      )}
                      {!state.documents.length && (
                        <Empty
                          title="This project is empty"
                          action={
                            <>
                              <Button tone="primary" onClick={() => newDialog('document')}>
                                New document
                              </Button>
                              <Button onClick={() => newDialog('plan')}>New plan</Button>
                            </>
                          }
                        >
                          <p>Add files, write a plan, or ask Diomedes where to start.</p>
                        </Empty>
                      )}
                      {detail !== 'technical' && (
                        <p className="prose capability">
                          In this project Diomedes can read and change supported text files, write
                          plans, keep tasks up to date, and restore the changes it recorded.
                        </p>
                      )}
                      {detail === 'standard' && (
                        <p className="caption open-desk">
                          <button
                            className="text-button"
                            onClick={() => void saveSettings({ ...settings, surface: 'desk' })}
                          >
                            Open the Desk
                          </button>
                          {' '}
                          to see every thread, every helper and every change at once.
                        </p>
                      )}
                    </>
                  )}
                  {page === 'ask' && (
                    <>
                      <section className="desk-threads" aria-label="Threads">
                        <header className="desk-side-header">
                          <h2>Threads</h2>
                          <Button tone="quiet" disabled={busy} onClick={() => void newThread()}>
                            New thread
                          </Button>
                        </header>
                        {pageThreads.map((c) => (
                          <button
                            key={c.id}
                            className={`desk-thread ${c.id === selectedThreadId ? 'open' : ''}`}
                            onClick={() => setThreadId(c.id)}
                          >
                            <span className="desk-thread-name">{threadName(c, state)}</span>
                            <span className="caption">{threadMeta(c)}</span>
                          </button>
                        ))}
                      </section>
                      {!selectedThread ? (
                        <Empty title="Ask about this project">
                          <p>
                            This is for questions and thinking out loud. Nothing in the project
                            changes here. Your threads stay with this project.
                          </p>
                          <p>To have Diomedes do something, switch the box below to Work.</p>
                        </Empty>
                      ) : (
                        <section key={selectedThread.id} className="conversation">
                          <div className="row">
                            <button
                              className="text-button"
                              title="Rename thread"
                              onClick={() =>
                                setRenaming({
                                  id: selectedThread.id,
                                  name: threadName(selectedThread, state),
                                })
                              }
                            >
                              {threadName(selectedThread, state)}
                            </button>
                            <span className="caption push-right">
                              {threadMeta(selectedThread)}
                            </span>
                          </div>
                          {!selectedThread.turns.length ? (
                            <p className="caption">Nothing here yet.</p>
                          ) : (
                            selectedThread.turns.map((t, i) => (
                              <div
                                className={`turn ${t.role}`}
                                key={t.id || `${selectedThread.id}:${i}`}
                              >
                                <p className="caption turn-meta">
                                  {t.role === 'you'
                                    ? 'You'
                                    : t.route === 'codex'
                                      ? detail === 'technical'
                                        ? 'Codex'
                                        : 'Online service'
                                      : 'Diomedes, sample work'}
                                  <time>{time(t.at)}</time>
                                </p>
                                {t.role === 'you' ? <p>{t.text}</p> : <Markdown text={t.text} />}
                                {t.role === 'diomedes' && t.helper && (
                                  <p className="caption helper-caption">
                                    {t.helper.engine === 'codex'
                                      ? t.helper.verified && t.helper.model
                                        ? `Codex, ${t.helper.model}`
                                        : 'Codex, name not reported'
                                      : 'Sample work, on this computer'}
                                  </p>
                                )}
                                {t.sources?.length > 0 && (
                                  <p className="caption">Sources: {t.sources.join(', ')}</p>
                                )}
                              </div>
                            ))
                          )}
                        </section>
                      )}
                    </>
                  )}
                  {page === 'plan' && (
                    <>
                      {detail === 'guided' && (
                        <p className="prose small muted">
                          A plan is a document that says what should happen. You can edit it. When
                          you're ready, Diomedes can turn its steps into tasks.
                        </p>
                      )}
                      {state.project.plans.length > 1 && (
                        <label className="field">
                          Plan
                          <select
                            value={path}
                            onChange={(e) => void openDocument(e.target.value, 'plan')}
                          >
                            {state.project.plans.map((p) => (
                              <option key={p}>{p}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      {editor ?? (
                        <Empty
                          title="No plans yet"
                          action={
                            <Button tone="primary" onClick={() => newDialog('plan')}>
                              New plan
                            </Button>
                          }
                        >
                          <p>A plan says what should happen before it happens.</p>
                        </Empty>
                      )}
                    </>
                  )}
                  {page === 'documents' && (
                    <>
                      {doc ? (
                        <>
                          <Button
                            tone="quiet"
                            className="back-link"
                            onClick={() => {
                              if (dirty) {
                                report(new Error('Save your changes before closing the document.'));
                                return;
                              }
                              setDoc(null);
                              setPath('');
                            }}
                          >
                            Back to Documents
                          </Button>
                          {editor}
                        </>
                      ) : (
                        <>
                          <p className="prose">The documents in this project's folder.</p>
                          {state.documents.length ? (
                            state.documents.map((d) => (
                              <button
                                key={d.path}
                                className="document-row"
                                disabled={!d.recorded}
                                onClick={() => void openDocument(d.path)}
                              >
                                {d.hasChangesWaiting && <Mark state="waiting" />}
                                <span>{d.path}</span>
                                <span className="dotted-leader" />
                                <span className="caption">
                                  {d.recorded
                                    ? `${Math.max(1, Math.round(d.size / 1024))} KB`
                                    : 'Preview unavailable'}
                                </span>
                                {detail === 'technical' && (
                                  <span className="code caption">{d.kind}</span>
                                )}
                              </button>
                            ))
                          ) : (
                            <Empty
                              title="No documents yet"
                              action={
                                <Button onClick={() => newDialog('document')}>New document</Button>
                              }
                            />
                          )}
                        </>
                      )}
                    </>
                  )}
                  {page === 'work' && (
                    <>
                      {waiting.map(needCard)}
                      {!state.sessions.length ? (
                        <Empty
                          title="Nothing is running"
                          action={<Button onClick={() => go('tasks')}>Open Tasks</Button>}
                        >
                          <p>
                            Give Diomedes a job in the box below. It writes down what it will do,
                            does the work, and asks before anything that matters. Or start a task
                            from Tasks.
                          </p>
                        </Empty>
                      ) : (
                        [...state.sessions]
                          .filter((s) => s.id === workSession?.id)
                          .map((s) => (
                            <section className="work-session" key={s.id}>
                              <SessionStatus
                                session={s}
                                detail={detail}
                                stop={() => void stopSession(s.id)}
                              />
                              <div className="work-log">
                                {s.log
                                  .filter(
                                    (l) =>
                                      l.level === 'plain' || (detail === 'technical' && logDetails),
                                  )
                                  .map((l, i) => (
                                    <div
                                      key={i}
                                      className={l.level === 'technical' ? 'technical-log' : ''}
                                    >
                                      <time>{time(l.time)}</time>
                                      <p>{l.sentence}</p>
                                    </div>
                                  ))}
                              </div>
                              {s.entryIds.length > 0 && (
                                <div className="actions">
                                  <Button onClick={() => go('review')}>Look at changes</Button>
                                  <Button onClick={() => go('history')}>Open in History</Button>
                                </div>
                              )}
                            </section>
                          ))
                      )}
                    </>
                  )}
                  {page === 'review' && (
                    <>
                      {!changes.length ? (
                        <Empty title="Nothing to review">
                          <p>Changes appear here after Diomedes works on a task.</p>
                        </Empty>
                      ) : (
                        <>
                          <p className="prose">
                            These are the changes from {reviewTask?.name ?? 'this work'}. Keep the
                            ones you want; Undo puts that file back the way it was. You can change
                            your mind later from History.
                          </p>
                          {changes.map((c) => (
                            <ChangeCard key={c.id} change={c} detail={detail}>
                              <Button
                                disabled={busy}
                                tone="primary"
                                onClick={() => void reviewChange(c, 'keep')}
                              >
                                Keep
                              </Button>
                              <Button disabled={busy} onClick={() => void reviewChange(c, 'undo')}>
                                Undo
                              </Button>
                              <Button tone="quiet" onClick={() => void openDocument(c.path)}>
                                Open document
                              </Button>
                            </ChangeCard>
                          ))}
                        </>
                      )}
                    </>
                  )}
                  {page === 'history' && (
                    <>
                      {historyView ? (
                        <>
                          <p className="caption">
                            {date(historyView.entry.time)}, {time(historyView.entry.time)}
                          </p>
                          {historyView.files.map((c, i) => (
                            <ChangeCard
                              key={`${c.path}:${i}`}
                              change={{
                                ...c,
                                state: c.state ?? 'kept',
                                id: c.id ?? `${historyView.entry.id}:${i}`,
                              }}
                              detail={detail}
                            >
                              <Button
                                onClick={() =>
                                  void restoreEntry({ entry: historyView.entry, paths: [c.path] })
                                }
                              >
                                Restore this file
                              </Button>
                              <Button tone="quiet" onClick={() => void openDocument(c.path)}>
                                Open document
                              </Button>
                            </ChangeCard>
                          ))}
                        </>
                      ) : (
                        <>
                          <div className="filter-chips" aria-label="History filters">
                            {[
                              'All',
                              'Saved versions',
                              ...(detail !== 'guided' ? ['Diomedes', 'You'] : []),
                            ].map((f) => (
                              <button
                                key={f}
                                className={filter === f ? 'active' : ''}
                                onClick={() => setFilter(f)}
                              >
                                {f}
                              </button>
                            ))}
                          </div>
                          {detail === 'guided' && (
                            <p className="prose small muted">
                              Restore puts those files back the way they were. Nothing later is
                              lost; the restore is recorded here too.
                            </p>
                          )}
                          {state.history.length ? (
                            [
                              ...new Set(
                                [...state.history]
                                  .reverse()
                                  .map((e) => new Date(e.time).toDateString()),
                              ),
                            ].map((day) => (
                              <section className="block" key={day}>
                                <h3 className="section-title">
                                  {day === new Date().toDateString() ? 'Today' : day}
                                </h3>
                                {[...state.history]
                                  .reverse()
                                  .filter(
                                    (e) =>
                                      new Date(e.time).toDateString() === day &&
                                      (filter === 'All' ||
                                        (filter === 'Saved versions' &&
                                          e.kind === 'saved-version') ||
                                        (filter === 'You' && e.actor === 'you') ||
                                        (filter === 'Diomedes' && e.actor !== 'you')),
                                  )
                                  .map(historyRow)}
                              </section>
                            ))
                          ) : (
                            <Empty title="Nothing has changed yet">
                              <p>
                                Every change Diomedes makes in this project will be listed here,
                                with a way back.
                              </p>
                            </Empty>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
                <aside className="margin">
                  {candidates ? (
                    <section className="block task-proposals">
                      <h3>Diomedes found {candidates.length} tasks in this plan</h3>
                      <p className="caption">Choose what to add. Done tasks are never removed.</p>
                      {candidates.map((c, i) => (
                        <div className="candidate" key={i}>
                          <input
                            type="checkbox"
                            aria-label={`Include ${c.name}`}
                            checked={c.selected}
                            onChange={(e) =>
                              setCandidates(
                                candidates.map((v, j) =>
                                  j === i ? { ...v, selected: e.target.checked } : v,
                                ),
                              )
                            }
                          />
                          <div>
                            <input
                              aria-label={`Task ${i + 1} name`}
                              value={c.name}
                              onChange={(e) =>
                                setCandidates(
                                  candidates.map((v, j) =>
                                    j === i ? { ...v, name: e.target.value } : v,
                                  ),
                                )
                              }
                            />
                            <p className="caption">
                              {c.owner === 'you' ? 'You' : 'Diomedes, with your OK'}
                            </p>
                          </div>
                        </div>
                      ))}
                      <div className="actions">
                        <Button
                          tone="primary"
                          disabled={busy || !candidates.some((c) => c.selected)}
                          onClick={() => void addTasks()}
                        >
                          Add {candidates.filter((c) => c.selected).length} tasks
                        </Button>
                        <Button tone="quiet" onClick={() => setCandidates(null)}>
                          Cancel
                        </Button>
                      </div>
                    </section>
                  ) : null}
                  {page === 'review' && changes.length > 0 && (
                    <>
                      <section className="task-summary">
                        <h3>{reviewTask?.name ?? 'Changes to this project'}</h3>
                        {reviewTask?.from && (
                          <p className="caption">
                            from {reviewTask.from.plan}, step {reviewTask.from.step}
                          </p>
                        )}
                        <p>
                          Finished. {changes.length}{' '}
                          {changes.length === 1 ? 'change is' : 'changes are'} ready to look at.
                        </p>
                      </section>
                      <section className="block">
                        <h3>What Diomedes says it did</h3>
                        <p className="prose">
                          {reviewSession?.sample
                            ? 'Sample work changed the files listed below. These are scripted changes to demonstrate the workflow.'
                            : (reviewSession?.log.filter((l) => l.level === 'plain').at(-1)
                                ?.sentence ??
                              'Changes were written to the project and recorded in History.')}
                        </p>
                      </section>
                      <section className="block">
                        <div className="row">
                          <h3>All changes</h3>
                          <span className="caption push-right">
                            {changes.length} {changes.length === 1 ? 'file' : 'files'}
                          </span>
                        </div>
                        {changes.map((c) => (
                          <button
                            key={c.id}
                            className="reference-row"
                            onClick={() =>
                              document
                                .getElementById(`change-${c.id}`)
                                ?.scrollIntoView({ block: 'nearest' })
                            }
                          >
                            <span>{c.path}</span>
                            <span className="caption push-right">
                              {c.changedSince ? 'newer changes' : 'waiting'}
                            </span>
                          </button>
                        ))}
                      </section>
                    </>
                  )}
                  {page === 'work' && workSession && (
                    <>
                      <section className="task-summary active">
                        <h3>{workTask?.name ?? 'This task'}</h3>
                        {workTask?.from && (
                          <p className="caption">
                            from {workTask.from.plan}, step {workTask.from.step}
                          </p>
                        )}
                        <p>
                          {workSession.state === 'waiting'
                            ? 'Waiting for your OK'
                            : workSession.state === 'working'
                              ? 'Working'
                              : titleCase(workSession.state)}
                          . {workSession.sample ? 'Sample work.' : 'Diomedes, with your OK.'}
                        </p>
                        {workThread && (
                          <div className="actions">
                            <Button tone="quiet" onClick={() => openThread(workThread.id)}>
                              Open thread
                            </Button>
                          </div>
                        )}
                        {detail === 'technical' && (
                          <p className="code caption">
                            {workSession.engine.name}, session {workSession.id}
                          </p>
                        )}
                      </section>
                      <section className="block">
                        <h3>Changes so far</h3>
                        {state.changes
                          .filter((c) => c.sessionId === workSession.id)
                          .map((c) => (
                            <button
                              className="reference-row"
                              key={c.id}
                              onClick={() => go('review')}
                            >
                              {c.path}
                            </button>
                          ))}
                        {!state.changes.some((c) => c.sessionId === workSession.id) && (
                          <p className="caption">No files have changed yet.</p>
                        )}
                      </section>
                    </>
                  )}
                  {!!todo.length && page !== 'review' && (
                    <section className="block">
                      <div className="row">
                        <h3>Up next</h3>
                        <span className="caption push-right">
                          {todo.length === 1 ? '1 task' : `${todo.length} tasks`}
                        </span>
                      </div>
                      {todo.slice(0, 3).map((t) => (
                        <button
                          key={t.id}
                          className="reference-row"
                          onClick={() => setTaskDetail(t)}
                        >
                          <span>{t.name}</span>
                          <span className="caption push-right">
                            {t.owner === 'you'
                              ? 'You'
                              : t.owner === 'diomedes-with-ok'
                                ? 'Diomedes, with your OK'
                                : 'Diomedes'}
                          </span>
                        </button>
                      ))}
                    </section>
                  )}
                  {page === 'history' && (
                    <section className="block">
                      <h3>Save a version</h3>
                      <p className="prose small">
                        Name a point you want to come back to. It stays here with the changes.
                      </p>
                      <Button onClick={() => newDialog('snapshot')}>Save a version</Button>
                    </section>
                  )}
                  {page === 'work' && workSession && (
                    <section className="block">
                      {detail === 'technical' && (
                        <>
                          <div className="row">
                            <h3>Details</h3>
                            <label className="switch caption push-right">
                              <input
                                type="checkbox"
                                checked={logDetails}
                                onChange={(e) => setLogDetails(e.target.checked)}
                              />
                              Show log
                            </label>
                          </div>
                          <dl className="facts code">
                            <dt>engine</dt>
                            <dd>
                              {workSession.engine.name}
                              {workSession.engine.model ? ` ${workSession.engine.model}` : ''}
                            </dd>
                            <dt>worker</dt>
                            <dd>{workSession.engine.worker}</dd>
                            <dt>repository</dt>
                            <dd>{state.project.repository.present ? 'present' : 'none'}</dd>
                            <dt>context</dt>
                            <dd>{workSession.engine.context ?? 'not reported'}</dd>
                            <dt>events</dt>
                            <dd>{workSession.engine.events}</dd>
                            <dt>usage</dt>
                            <dd>
                              {workSession.sample ? 'no model calls' : 'ChatGPT subscription'}
                            </dd>
                          </dl>
                        </>
                      )}
                      {state.sessions.length > 1 && (
                        <label className="field">
                          Work session
                          <select
                            value={workSession.id}
                            onChange={(e) => setWorkSessionId(e.target.value)}
                          >
                            {[...state.sessions].reverse().map((s) => (
                              <option key={s.id} value={s.id}>
                                {state.tasks.find((t) => t.id === s.taskId)?.name},{' '}
                                {titleCase(s.state)}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <details>
                        <summary>Leave a note</summary>
                        <label className="field">
                          Note
                          <input
                            value={sessionNote}
                            onChange={(e) => setSessionNote(e.target.value)}
                            placeholder="A note for this task"
                          />
                        </label>
                        <Button
                          disabled={!sessionNote.trim() || busy}
                          onClick={() =>
                            void perform(async () => {
                              await api(`${base}/work/${workSession.id}/note`, 'POST', {
                                text: sessionNote,
                              });
                              setSessionNote('');
                              await load();
                            })
                          }
                        >
                          Add note
                        </Button>
                      </details>
                    </section>
                  )}
                  {page !== 'home' && composer}
                  {(detail !== 'guided' || showMore) && state.project.references.length > 0 && (
                    <section className="block">
                      <h3>References</h3>
                      {state.project.references.map((r) => (
                        <p key={r}>{r}</p>
                      ))}
                    </section>
                  )}
                  {detail === 'guided' && state.project.references.length > 0 && !showMore && (
                    <Button tone="quiet" onClick={() => setShowMore(true)}>
                      More
                    </Button>
                  )}
                  {detail === 'technical' && page !== 'work' && page !== 'review' && (
                    <section className="block">
                      <h3>This project</h3>
                      <p className="code">{state.project.folder}</p>
                      <p className="caption">
                        {state.documents.length} files.{' '}
                        {state.project.repository.present
                          ? 'Git repository present. No Git actions are performed.'
                          : 'No repository.'}
                      </p>
                      <p className="caption">
                        {running.length} running, {changes.length} changes waiting
                      </p>
                    </section>
                  )}
                </aside>
              </div>
            )}
          </>
        )}
      </main>
      {feedback && (
        <div className="feedback" role="status">
          <Mark state="done" />
          <span>{feedback.text}</span>
          {feedback.undo && (
            <Button tone="quiet" onClick={feedback.undo}>
              Undo
            </Button>
          )}
          <Button tone="quiet" onClick={() => setFeedback(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {modal && !['folder', 'attach'].includes(modal) && (
        <Modal
          title={
            modal === 'task'
              ? 'New task'
              : modal === 'snapshot'
                ? 'Save a version'
                : modal === 'plan'
                  ? 'New plan'
                  : 'New document'
          }
          onClose={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void newItem();
            }}
          >
            <label className="field">
              {modal === 'task' ? 'Task name' : modal === 'snapshot' ? 'Version name' : 'Name'}
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  modal === 'snapshot'
                    ? 'Before the price change'
                    : modal === 'plan'
                      ? 'Reopening plan'
                      : ''
                }
                required
              />
            </label>
            <div className="dialog-actions">
              <Button onClick={() => setModal(null)}>Cancel</Button>
              <Button tone="primary" type="submit" disabled={busy || !name.trim()}>
                {modal === 'task' ? 'Add task' : modal === 'snapshot' ? 'Save' : 'Create'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'folder' && (
        <Modal title="Project folder" onClose={() => setModal(null)}>
          <p className="prose">
            These are ordinary files on your computer. Open this path in File Explorer.
          </p>
          <label className="field">
            Folder
            <input
              readOnly
              value={state?.project.folder ?? ''}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <div className="dialog-actions">
            <Button
              onClick={() =>
                void perform(async () => {
                  await navigator.clipboard.writeText(state?.project.folder ?? '');
                  say('Folder path copied.');
                })
              }
            >
              Copy path
            </Button>
            <Button onClick={() => setModal(null)}>Close</Button>
          </div>
        </Modal>
      )}
      {modal === 'attach' && (
        <Modal title="Attach a document" onClose={() => setModal(null)}>
          <p className="prose small">Only the document you choose is attached to this request.</p>
          {state?.documents
            .filter((d) => d.recorded)
            .map((d) => (
              <button
                key={d.path}
                className="document-row"
                onClick={() => {
                  setAttached(d.path);
                  setModal(null);
                }}
              >
                {d.path}
              </button>
            ))}
          {!state?.documents.length && <p>No documents yet.</p>}
        </Modal>
      )}
      {renaming && (
        <Modal title="Rename thread" onClose={() => setRenaming(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void renameThread();
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
      {pendingTask && (
        <Modal title="Use an online service for this task?" onClose={() => setPendingTask(null)}>
          <p className="prose">
            Diomedes will send the task instruction
            {attached || pendingTask.from ? ` and ${attached || pendingTask.from?.plan}` : ''} to
            the online service. It will prepare changes for you to review. Files change only after
            you say go ahead.
          </p>
          <p className="caption">
            This uses your existing ChatGPT subscription. No paid API fallback. No commands or
            external tools run.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setPendingTask(null)}>Not now</Button>
            <Button
              tone="primary"
              disabled={busy}
              onClick={() => void startTask(pendingTask, true)}
            >
              Continue
            </Button>
          </div>
        </Modal>
      )}
      {previewNeed && (
        <Modal title="Proposed changes" wide onClose={() => setPreviewNeed(null)}>
          <p className="prose">
            {previewNeed.why} Nothing here has been written to the project yet.
          </p>
          {previewNeed.preview?.map((c) => (
            <ChangeCard key={c.id} change={c} detail={detail}>
              <span className="caption">Proposed</span>
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
              tone="signal"
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
        <Modal title="Use an online service?" onClose={() => setPendingOnline(false)}>
          <p className="prose">
            Diomedes will use an online service for this. Your instructions
            {attached || (page === 'plan' && path) ? ` and ${attached || path}` : ''} are sent to
            that service. You can change this in Settings &gt; Helpers on this computer.
          </p>
          <p className="caption">
            This uses your existing ChatGPT subscription. There is no paid API fallback.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setPendingOnline(false)}>Not now</Button>
            <Button tone="primary" disabled={busy} onClick={() => void send(true)}>
              Continue
            </Button>
          </div>
        </Modal>
      )}
      {restore && (
        <Modal
          title={
            restore.inProgress
              ? 'Work is still running'
              : `Restore ${restore.paths?.length ?? restore.entry.files.length} files?${restore.conflicts?.length ? ` ${restore.conflicts.length} changed since.` : ''}`
          }
          onClose={() => setRestore(null)}
        >
          <p className="prose">
            {restore.inProgress
              ? 'Stop the current task before restoring its files. Changes already made will stay in History.'
              : "They'll go back to how they were before this change. Nothing is deleted from History; this restore will be listed here too, and you can undo it."}
          </p>
          {restore.conflicts?.length ? (
            <>
              <p className="prose small">
                Your newer edits stay in History and can be restored later.
              </p>
              <ul>
                {restore.conflicts.map((c) => (
                  <li key={c.path}>
                    {c.path}, changed by {c.actor} {c.at ? `at ${time(c.at)}` : ''}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <ul>
              {(restore.paths ?? restore.entry.files.map((f) => f.path)).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <div className="restore-actions">
            {restore.inProgress ? (
              <Button
                tone="primary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await api(`${base}/work/${restore.inProgress!.sessionId}/stop`, 'POST', {});
                    await restoreEntry({ ...restore, inProgress: undefined });
                  })
                }
              >
                Stop it and restore
              </Button>
            ) : restore.conflicts?.length ? (
              <>
                <Button
                  tone="primary"
                  disabled={busy}
                  onClick={() => void restoreEntry(restore, 'all')}
                >
                  Restore all {restore.paths?.length ?? restore.entry.files.length} files
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void restoreEntry(restore, 'unchanged-only')}
                >
                  Restore only the files that haven't changed
                </Button>
                <Button disabled={busy} onClick={() => void restoreEntry(restore, 'copies')}>
                  Restore copies beside the current files
                </Button>
              </>
            ) : (
              <Button tone="primary" disabled={busy} onClick={() => void restoreEntry(restore)}>
                Restore {restore.paths?.length ?? restore.entry.files.length} files
              </Button>
            )}
            <Button tone="quiet" onClick={() => setRestore(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
      {taskDetail && (
        <Modal title={taskDetail.name} onClose={() => setTaskDetail(null)}>
          <p className="prose">
            {taskDetail.description || 'A task keeps a piece of work and its changes together.'}
          </p>
          {taskDetail.from && (
            <p className="caption">
              from {taskDetail.from.plan}, step {taskDetail.from.step}
            </p>
          )}
          {settings.services?.codex && (
            <label className="field">
              Work service
              <select value={route} onChange={(e) => setRoute(e.target.value as Route)}>
                <option value="sample">Sample work</option>
                <option value="codex">
                  {detail === 'technical' ? 'Codex / ChatGPT subscription' : 'Online service'}
                </option>
              </select>
            </label>
          )}
          <label className="field">
            Move to
            <select
              value={state?.tasks.find((t) => t.id === taskDetail.id)?.state ?? taskDetail.state}
              disabled={running.some((s) => s.taskId === taskDetail.id)}
              onChange={(e) => void moveTask(taskDetail, e.target.value as TaskState)}
            >
              {Object.entries(stateNames).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {detail === 'technical' && (
            <p className="code">
              {taskDetail.id}, {taskDetail.sessionIds.length} sessions
            </p>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setTaskDetail(null)}>Close</Button>
            {taskDetailThread && (
              <Button
                tone="quiet"
                onClick={() => {
                  const id = taskDetailThread.id;
                  setTaskDetail(null);
                  openThread(id);
                }}
              >
                Open thread
              </Button>
            )}
            {taskDetail.state === 'todo' && (
              <Button
                tone="primary"
                disabled={busy || running.length > 0}
                onClick={() => {
                  void startTask(taskDetail);
                  setTaskDetail(null);
                }}
              >
                Do this for me
              </Button>
            )}
          </div>
        </Modal>
      )}
      {editorConflict && (
        <Modal title="Newer changes are in the way" onClose={() => setEditorConflict(false)}>
          <p className="prose">
            The file changed after you opened it. Your writing is still in the editor. Save a
            separate copy, or copy your writing before reloading the current file.
          </p>
          <div className="restore-actions">
            <Button
              tone="primary"
              onClick={() =>
                void perform(async () => {
                  const copy = path.replace(/(\.[^.]+)?$/, ` (your edits ${Date.now()})$1`);
                  await api(`${base}/documents/create`, 'POST', { path: copy, text: buffer });
                  setEditorConflict(false);
                  setDoc(null);
                  setPath('');
                  await load();
                  say(`Saved ${copy}.`);
                })
              }
            >
              Save my writing as a copy
            </Button>
            <Button
              onClick={() =>
                void perform(async () => {
                  await navigator.clipboard.writeText(buffer);
                  say('Your writing was copied.');
                })
              }
            >
              Copy my writing
            </Button>
            <Button
              onClick={() =>
                void perform(async () => {
                  const d = await api<DocumentContent>(
                    `${base}/documents/read?path=${encodeURIComponent(path)}`,
                  );
                  setDoc(d);
                  setBuffer(d.text);
                  setEditorConflict(false);
                })
              }
            >
              Reload the current file
            </Button>
            <Button tone="quiet" onClick={() => setEditorConflict(false)}>
              Keep editing
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function threadTime(c: Conversation) {
  return c.updatedAt ?? c.turns.at(-1)?.at ?? c.createdAt ?? '';
}
function threadName(c: Conversation, state: ProjectState | null) {
  if (c.name) return c.name;
  const first = c.turns.find((t) => t.role === 'you')?.text.trim();
  if (first) return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first;
  if (c.attachedTo.kind === 'task')
    return `Thread for ${state?.tasks.find((t) => t.id === c.attachedTo.ref)?.name ?? 'a task'}`;
  return c.attachedTo.kind === 'project'
    ? 'Project thread'
    : `${titleCase(c.attachedTo.kind)}: ${c.attachedTo.ref}`;
}
function threadMeta(c: Conversation) {
  const turns = `${c.turns.length} ${c.turns.length === 1 ? 'turn' : 'turns'}`;
  const at = threadTime(c);
  return at ? `${turns} · ${time(at)}` : turns;
}

function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  let inCode = false;
  return (
    <div className="markdown prose">
      {lines.map((line, i) => {
        if (line.startsWith('```')) {
          inCode = !inCode;
          return <span key={i} />;
        }
        if (inCode)
          return (
            <pre className="code code-line" key={i}>
              {line || ' '}
            </pre>
          );
        if (/^### /.test(line)) return <h3 key={i}>{line.slice(4)}</h3>;
        if (/^## /.test(line)) return <h2 key={i}>{line.slice(3)}</h2>;
        if (/^# /.test(line))
          return (
            <h2 className="document-title" key={i}>
              {line.slice(2)}
            </h2>
          );
        if (/^\s*([-*]|\d+\.) /.test(line))
          return (
            <div className="markdown-list-line" key={i}>
              <span>{line.match(/^\s*([-*]|\d+\.)/)?.[1]}</span>
              <span>{line.replace(/^\s*([-*]|\d+\.) /, '').replace(/\[ \] /, '')}</span>
            </div>
          );
        if (!line.trim()) return <div className="paragraph-space" key={i} />;
        return (
          <p key={i}>
            {line
              .split(/(\*\*.*?\*\*)/g)
              .map((part, j) =>
                part.startsWith('**') ? <strong key={j}>{part.slice(2, -2)}</strong> : part,
              )}
          </p>
        );
      })}
    </div>
  );
}
