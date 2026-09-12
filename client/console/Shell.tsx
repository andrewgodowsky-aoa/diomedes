import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { selectedEngine } from '../../shared/ai-selection';
import { formatOrigin, originForNeed, originForSession } from '../../shared/attribution';
import type { ScopeGrantView } from '../../shared/permissions';
import { isRoute, isExternalEngine, ENGINE_NAMES } from '../../shared/engines';
import type {
  Change,
  Conversation,
  DocumentInfo,
  EngineCatalog,
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
import { api, listDocuments } from '../api';
import { reconcileWorkStarts, startWork } from '../work-start';
import { decideApproval, reconcileApprovals } from '../approval-decisions';
import {
  ApprovalStatus,
  HarnessProposal,
  ChangeCard,
  Button,
  Modal,
  time,
  titleCase,
} from '../components';
import { Mark } from './Mark';
import { Rail, type RailItem } from './Rail';
import { ThreadView } from './ThreadView';
import { PermissionPanel } from './PermissionPanel';
import { Ledger } from './Ledger';
import { Picker } from './Picker';
import { AgentPicker } from './AgentPicker';
import { BoardView } from './BoardView';
import { FilesPane, DEFAULT_WIDTH, clampWidth } from './FilesPane';
import { ActivityOverview } from './ActivityOverview';
import { projectActivity, type ActivityRow } from './activity';
import { TeamView } from './TeamView';
import { Connections } from '../connections/Connections';
import { Palette } from './Palette';
import { WorkspaceMark, WorkspacePanel, useWorkspace } from './Workspaces';
import { applyQuery, buildEntries, type PaletteContext } from './paletteEntries';
import { useTravelOnView } from './motion';
import type { ShellView } from './types';
import './console.css';
import './palette.css';
import './motion.css';
import './files.css';

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
  /** Registration so App can open the console palette on Ctrl+K. */
  onPaletteKey?: (open: () => void) => void;
}

const emptyTeam: TeamState = { members: [], messages: [], runs: [] };

// Cap for the live streamed display: ephemeral text never persists.
const MAX_STREAM_CHARS = 256 * 1024;

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
  onPaletteKey,
}: ShellProps) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ShellView>('Thread');
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [workspace, setWorkspace] = useWorkspace(report);
  const [mode, setMode] = useState<Mode>('ask');
  const [route, setRoute] = useState<Route>(selectedEngine(settings));
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [previewNeed, setPreviewNeed] = useState<Need | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [scopeGrants, setScopeGrants] = useState<ScopeGrantView[]>([]);
  const [sendTask, setSendTask] = useState<{ task: Task; route: Route } | null>(null);
  const [team, setTeam] = useState<TeamState>(emptyTeam);
  const [teamAvailable, setTeamAvailable] = useState(false);
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [routingTaskId, setRoutingTaskId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, EngineCatalog>>({});
  // The Files pane: off by default and remembered per person, never per project.
  const [filesOpen, setFilesOpen] = useState(() => stored('console.files.open') === 'true');
  const [filesWidth, setFilesWidth] = useState(() => {
    const saved = Number(stored('console.files.width'));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : DEFAULT_WIDTH;
  });
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsFailure, setDocumentsFailure] = useState<string | null>(null);
  // Live streamed text for a new external-engine Ask/Plan: ephemeral, never
  // persisted. The server owns the requestId; the started event adopts it.
  const [streaming, setStreaming] = useState<{
    requestId: string;
    threadId: string;
    text: string;
    engine: string;
  } | null>(null);
  const askControl = useRef<AbortController | null>(null);
  const askThreadId = useRef<string | null>(null);
  const askEngine = useRef<Route | null>(null);
  const streamingId = useRef<string | null>(null);
  // The member a palette Message picked. The lane view has no composer yet,
  // so opening Team records the target here for the pass that adds one.
  const teamTarget = useRef<Slot | null>(null);
  // The console root the travelling point lives in (motion.ts appends it here).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const currentId = useRef(projectId);
  const reconciliationIssue = useRef<string | undefined>(undefined);
  currentId.current = projectId;
  const base = `/projects/${projectId}`;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1600);
  }, []);

  const load = useCallback(async () => {
    const [data, permissions] = await Promise.all([
      api<ProjectState>(`/projects/${projectId}/state`),
      api<{ grants: ScopeGrantView[] }>(`/projects/${projectId}/permissions/grants`),
    ]);
    if (currentId.current === projectId) {
      setState(data);
      setScopeGrants(permissions.grants);
    }
    const workIssue = reconcileWorkStarts(projectId, data.sessions);
    const approvalIssue = reconcileApprovals(projectId, data.needs);
    const issue = workIssue ?? approvalIssue;
    if (issue?.message !== reconciliationIssue.current) {
      reconciliationIssue.current = issue?.message;
      if (issue) report(issue);
    }
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
  }, [projectId, report]);
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
    const deadlines = scopeGrants
      .filter((record) => record.active)
      .map((record) => Date.parse(record.grant.expiresAt))
      .filter(Number.isFinite);
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => void load().catch(report),
      Math.max(1, Math.min(...deadlines) - Date.now() + 25),
    );
    return () => clearTimeout(timer);
  }, [scopeGrants, load, report]);
  const openPalette = useCallback(() => {
    setPaletteQuery('');
    setPendingTaskId(null);
    setRoutingTaskId(null);
    setPaletteOpen(true);
  }, []);
  useEffect(() => {
    onPaletteKey?.(openPalette);
  }, [onPaletteKey, openPalette]);
  // Live engine catalogues for the Models group, read exactly as the Picker does.
  useEffect(() => {
    let alive = true;
    for (const id of ['codex', 'claude-code', 'opencode', 'oh-my-pi'] as const) {
      const found = integrations.find((i) => i.id === id);
      const on =
        !!found &&
        (found.kind === 'sample'
          ? found.available
          : found.available && settings.services?.[id] === true);
      if (!on) continue;
      api<EngineCatalog>(`/engines/${id}/models`)
        .then((catalog) => {
          if (alive) setCatalogs((prev) => ({ ...prev, [id]: catalog }));
        })
        .catch(() => {
          if (alive)
            setCatalogs((prev) => ({ ...prev, [id]: { engine: id, models: [], detail: '' } }));
        });
    }
    return () => {
      alive = false;
    };
  }, [integrations, settings]);
  useEffect(() => {
    setState(null);
    setScopeGrants([]);
    setPermissionsOpen(false);
    setSelectedId(null);
    setView('Thread');
    setOpenPath(null);
    setDocuments([]);
    setDocumentsFailure(null);
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
      'team',
    ].forEach((n) => es.addEventListener(n, update));
    // Live engine text: started before engine metadata/generate, delta for
    // partial text, ended in finally on all outcomes. Ephemeral only.
    const onEngineText = (ev: Event) => {
      let data: {
        projectId?: unknown;
        threadId?: unknown;
        requestId?: unknown;
        kind?: unknown;
        text?: unknown;
      };
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      if (
        typeof data.projectId !== 'string' ||
        typeof data.threadId !== 'string' ||
        typeof data.requestId !== 'string' ||
        (data.kind !== 'started' && data.kind !== 'delta' && data.kind !== 'ended')
      ) {
        return;
      }
      if (data.projectId !== currentId.current) return;
      if (data.kind === 'started') {
        if (askThreadId.current == null || data.threadId !== askThreadId.current) return;
        if (streamingId.current != null) return;
        streamingId.current = data.requestId;
        setStreaming({
          requestId: data.requestId,
          threadId: data.threadId,
          text: '',
          engine: askEngine.current ?? '',
        });
        return;
      }
      if (data.kind === 'delta') {
        if (streamingId.current == null || data.requestId !== streamingId.current) return;
        if (data.threadId !== askThreadId.current) return;
        const chunk = typeof data.text === 'string' ? data.text : '';
        if (!chunk) return;
        setStreaming((prev) => {
          if (!prev || prev.requestId !== data.requestId) return prev;
          const next = (prev.text + chunk).slice(0, MAX_STREAM_CHARS);
          return next === prev.text ? prev : { ...prev, text: next };
        });
        return;
      }
      if (streamingId.current == null || data.requestId !== streamingId.current) return;
      streamingId.current = null;
      setStreaming((prev) => (prev && prev.requestId === data.requestId ? null : prev));
    };
    es.addEventListener('engine-text', onEngineText as EventListener);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [load, report]);
  // An in-flight ask owns its AbortController; leaving the project or
  // unmounting cancels it and drops any partial text.
  useEffect(() => {
    return () => {
      askControl.current?.abort();
      askControl.current = null;
      askThreadId.current = null;
      streamingId.current = null;
      setStreaming(null);
    };
  }, [projectId]);

  useEffect(() => {
    remember('console.files.open', filesOpen ? 'true' : 'false');
  }, [filesOpen]);
  useEffect(() => {
    remember('console.files.width', String(filesWidth));
  }, [filesWidth]);
  // `statePayload` strips `documents` from the SSE fan-out, so the listing is
  // fetched here: when the pane or the palette wants it, and again on each
  // state event while one of them is open. Nothing reads `state.documents`.
  const wantDocuments = filesOpen || paletteOpen;
  useEffect(() => {
    if (!wantDocuments) return;
    let alive = true;
    setDocumentsLoading(true);
    listDocuments(projectId)
      .then((result) => {
        if (!alive || currentId.current !== projectId) return;
        setDocuments(result.documents);
        setDocumentsFailure(null);
      })
      .catch((e: unknown) => {
        if (!alive || currentId.current !== projectId) return;
        setDocuments([]);
        setDocumentsFailure(
          isMissingRoute(e)
            ? 'This service does not list project documents.'
            : e instanceof Error
              ? e.message
              : "This project's folder could not be read.",
        );
      })
      .finally(() => {
        if (alive) setDocumentsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [wantDocuments, projectId, state]);

  // The overview of what is happening in this Project, derived from the same
  // task, run, Need, change and History records the Board reads. Null when
  // nothing is happening, so the screen keeps its own sentence. Memoised on
  // the state object: it must not recompute on every keystroke.
  const activity = useMemo(() => {
    if (!state) return null;
    const projected = projectActivity(state);
    return projected.working.length ||
      projected.needsYou.length ||
      projected.readyForReview.length ||
      projected.finishedRecently.length
      ? projected
      : null;
  }, [state]);

  const threads = [...(state?.conversations ?? [])].sort((a, b) =>
    threadTime(b).localeCompare(threadTime(a)),
  );
  // Open the newest thread by default so the shell never starts empty for a project with history.
  useEffect(() => {
    if (state && threads.length && !threads.some((t) => t.id === selectedId)) {
      setSelectedId(threads[0].id);
    }
  }, [state, selectedId, threads.length]);
  const selected = selectedId
    ? (state?.conversations.find((c) => c.id === selectedId) ?? null)
    : null;
  useEffect(() => {
    if (selected) setMode(selected.mode ?? 'ask');
  }, [selected?.id, selected?.mode]);
  useEffect(() => {
    setRoute(selectedEngine(settings, state?.project, selected));
  }, [selected?.id, selected?.engine, state?.project.ai, settings.services?.defaultEngine]);

  const waiting = state?.needs.filter((n) => n.state === 'open') ?? [];
  const sessions = state?.sessions ?? [];
  const liveByTask = (taskId: string) =>
    sessions.find(
      (s) => s.taskId === taskId && ['queued', 'working', 'waiting'].includes(s.state),
    ) ?? null;
  const taskOf = (thread: Conversation | null) =>
    thread?.taskId ? (state?.tasks.find((t) => t.id === thread.taskId) ?? null) : null;
  const selectedTask = taskOf(selected);
  // Thread -> Board -> Team -> Thread continuity: one travelling point
  // between the views' anchors (kind `screen`, 260 ms). Enter and every
  // board/team action resolve without waiting on it.
  useTravelOnView(view, selectedTask?.id ?? null, rootRef);
  const selectedSessions = selected
    ? sessions.filter((s) =>
        s.threadId ? s.threadId === selected.id : s.taskId === selectedTask?.id,
      )
    : [];
  // Keep exact approvals and scoped authorization outcomes visible on their owning thread.
  const selectedReceipts =
    selected && state
      ? state.needs
          .filter(
            (n) => (n.approvalReceipt || n.authorization) && threadOwnsNeed(selected, n, state),
          )
          .slice(-1)
      : [];
  // Live text shows only for the exact selected thread: cross-thread events
  // never render elsewhere.
  const streamingForSelected =
    selected && streaming && streaming.threadId === selected.id
      ? { requestId: streaming.requestId, text: streaming.text, engine: streaming.engine }
      : undefined;
  const selectedMember = team.members.find((m) => m.threadId === selected?.id) ?? null;
  const selectedMail = team.messages.filter((m) => {
    const member = selected ? team.members.find((x) => x.threadId === selected.id) : undefined;
    return member
      ? m.to === member.slotId || m.from === member.slotId
      : m.threadId === selected?.id;
  });
  const helpers = integrations
    .filter((i) => i.adapter === 'ready' || i.adapter === 'planned')
    .map((i) => ({
      id: i.id,
      available:
        i.kind === 'sample' ? i.available : i.available && settings.services?.[i.id] === true,
    }));
  const routeForTask = (task: Task) =>
    selectedEngine(
      settings,
      state?.project,
      state?.conversations.find((thread) => thread.taskId === task.id),
    );

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
  async function setRequested(
    thread: Conversation,
    requested: Conversation['requested'],
    engine: Route = route,
  ) {
    await perform(async () => {
      await api(`${base}/threads/${thread.id}`, 'PUT', { requested, engine });
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
    void api(`${base}/threads/${selected.id}`, 'PUT', { mode: next }).catch((e: unknown) => {
      report(e);
      setMode(previous);
    });
  }
  /** Agent and model are separate choices; changing one preserves the other. */
  function pickAgent(agentId: string | null) {
    if (!selected) return;
    const current = selected.requested;
    const next =
      agentId === null
        ? current?.model
          ? { model: current.model, effort: current.effort ?? null }
          : null
        : {
            model: current?.model ?? null,
            effort: current?.effort ?? null,
            agent: agentId,
          };
    void setRequested(selected, next as Conversation['requested'], route);
  }
  function pick(requested: Conversation['requested'], engine: string) {
    if (!selected || !isRoute(engine)) return;
    setRoute(engine);
    // Changing the model must not silently change the worker.
    const agent = selected.requested?.agent ?? null;
    const next = agent
      ? { model: requested?.model ?? null, effort: requested?.effort ?? null, agent }
      : requested;
    void setRequested(selected, next as Conversation['requested'], engine);
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
  async function resolveNeed(
    need: Need,
    resolution: 'go-ahead' | 'declined',
    allowForTask = false,
  ) {
    await perform(async () => {
      await decideApproval(projectId, need, resolution, allowForTask);
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
    if (isExternalEngine(route)) {
      setSendTask({ task, route });
      return;
    }
    await dispatchTask(task, route);
  }
  async function dispatchTask(task: Task, route: Route) {
    await perform(async () => {
      const thread = state?.conversations.find((item) => item.taskId === task.id);
      await startWork(projectId, {
        taskId: task.id,
        route,
        sources: [],
        consent: true,
        ...(thread ? { threadId: thread.id } : {}),
      });
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
    askControl.current?.abort();
    const control = new AbortController();
    askControl.current = control;
    askThreadId.current = thread.id;
    askEngine.current = route;
    await perform(async () => {
      try {
        await api(
          `${base}/ask`,
          'POST',
          {
            mode,
            text,
            route,
            consent: true,
            threadId: thread.id,
            attachedTo: thread.attachedTo,
            ...(sources?.length ? { sources } : {}),
            ...(mode === 'fix' && failing ? { failing } : {}),
          },
          control.signal,
        );
        await load();
        // The persisted turn is in; drop the ephemeral text if still ours.
        streamingId.current = null;
        setStreaming((prev) => (prev && prev.threadId === thread.id ? null : prev));
      } catch (e) {
        if (control.signal.aborted || isAbortError(e)) {
          streamingId.current = null;
          setStreaming((prev) => (prev && prev.threadId === thread.id ? null : prev));
          report(new Error('Request stopped. The provider may still consume usage.'));
          return;
        }
        streamingId.current = null;
        setStreaming((prev) => (prev && prev.threadId === thread.id ? null : prev));
        throw e;
      } finally {
        if (askControl.current === control) {
          askControl.current = null;
          askThreadId.current = null;
        }
      }
    });
  }
  function cancelAsk() {
    askControl.current?.abort();
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
  // Palette Message: open the Team view with the member selected and focus
  // its composer. The lane view has no composer yet, so this records the
  // target and focuses the first composer available.
  function focusTeamComposer(member: TeamMember) {
    teamTarget.current = member.slotId;
    setView('Team');
    window.setTimeout(() => {
      const box =
        document.querySelector<HTMLTextAreaElement>('[data-team-composer] textarea') ??
        document.querySelector<HTMLTextAreaElement>('.console .composer textarea');
      box?.focus();
    }, 80);
  }
  /** Opening a document opens the pane; it never changes the selected thread. */
  function openDocument(path: string) {
    setOpenPath(path);
    setFilesOpen(true);
  }
  /** A row is a way back into the record it came from, never a new action. */
  function openActivityRow(row: ActivityRow) {
    if (row.threadId) {
      setSelectedId(row.threadId);
      setView('Thread');
      return;
    }
    setView('Board');
  }
  function closePalette() {
    setPaletteOpen(false);
    setPendingTaskId(null);
    setRoutingTaskId(null);
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
    ? ((liveByTask(selectedTask.id)
        ? formatOrigin(originForSession(liveByTask(selectedTask.id)!)).label
        : null) ??
      selectedMember?.name ??
      (selectedTask.owner === 'you' ? 'You' : 'Assistant'))
    : '';
  const latestTaskSession = selectedSessions.length
    ? [...selectedSessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)!
    : null;
  const activeGrant = scopeGrants.find(
    (record) =>
      record.active &&
      record.grant.taskId === selectedTask?.id &&
      record.grant.engine === route &&
      Date.parse(record.grant.expiresAt) > Date.now(),
  );
  // The palette finds tasks, workers, models, projects and views and exposes
  // only the actions valid for each item's current state. Every action calls
  // the same handlers the board and lanes call; nothing is duplicated.
  const paletteCtx: PaletteContext = {
    tasks: state.tasks,
    sessions,
    needs: state.needs,
    changes: state.changes,
    documents,
    members: team.members,
    catalogs,
    integrations,
    projects,
    currentProjectId: projectId,
    currentThread: selected,
    policy,
    view,
    focusTaskId: selectedTask?.id,
    focusTaskName: selectedTask?.name,
    pendingTaskId,
    routingTaskId,
    onPendingTask: setPendingTaskId,
    onRoutingTask: setRoutingTaskId,
    onPivotModels: () => {
      setPaletteQuery('use');
    },
    handlers: {
      startTask: (task) => void startTask(task, routeForTask(task)),
      pauseTask: (task) => {
        const running = liveByTask(task.id);
        if (running) void stopSession(running.id);
      },
      reviewTask: (task) => {
        openTaskThread(task);
        const need =
          task.needId != null
            ? (waiting.find((n) => n.id === task.needId) ?? null)
            : (waiting.find((n) => n.taskId === task.id) ?? null);
        if (need) scrollToNeed(need);
      },
      routeTask: (task, to) =>
        void perform(async () => {
          await api(`${base}/tasks/${task.id}`, 'PUT', { assignedTo: to });
          await load();
        }),
      reopenTask: (task) => void moveTask(task, 'todo'),
      openBoard: () => setView('Board'),
      openTeam: () => setView('Team'),
      setRequested: (requested) => {
        if (selected) void setRequested(selected, requested);
      },
      messageMember: focusTeamComposer,
      stopMember: (m) => void stopMember(m),
      wakeMember: (m) => void wakeMember(m),
      selectThread: (id) => {
        setSelectedId(id);
        setView('Thread');
      },
      setView: (v) => setView(v),
      openProject: (p) => onOpenProject(p),
      openDocument,
    },
  };
  const paletteEntries = (query: string) => applyQuery(buildEntries(paletteCtx), query);

  return (
    <div ref={rootRef} className={`console ${!online ? 'disconnected' : ''}`}>
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
            <AgentPicker
              projectId={projectId}
              thread={selected}
              mode={mode}
              route={route}
              live={selectedTask ? liveByTask(selectedTask.id) !== null : false}
              busy={busy}
              onPick={pickAgent}
            />
          )}
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
            onClick={openPalette}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openPalette();
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

      <div
        className={`stage${filesOpen ? ' files-open' : ''}`}
        style={filesOpen ? ({ '--files-w': `${filesWidth}px` } as CSSProperties) : undefined}
      >
        <Rail
          top={<WorkspaceMark view={workspace} onOpen={() => setWorkspacesOpen(true)} />}
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
          filesOpen={filesOpen}
          onFiles={() => setFilesOpen(!filesOpen)}
          onHome={() => openInBook('home')}
          onHistory={() => openInBook('history')}
          onEngines={openEngineSettings}
        />
        {view === 'Connections' && (
          <section className="screen on" aria-label="Connections">
            <Connections projectId={projectId} />
          </section>
        )}
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
              receiptNeeds={selectedReceipts}
              projectId={projectId}
              history={state.history}
              allNeeds={state.needs}
              changes={state.changes}
              grantActive={!!activeGrant}
              onScope={() => setPermissionsOpen(true)}
              permissionControl={
                <div className="task-permission">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => setPermissionsOpen(true)}
                  >
                    {activeGrant
                      ? activeGrant.grant.review === 'model-reviewer'
                        ? 'Approve for me'
                        : 'Work in this project'
                      : 'Review changes'}
                  </button>
                  {activeGrant && (
                    <button
                      type="button"
                      onClick={() =>
                        void perform(async () => {
                          await api(
                            `${base}/permissions/grants/${encodeURIComponent(activeGrant.grant.id)}/revoke`,
                            'POST',
                            {},
                          );
                          await load();
                        })
                      }
                    >
                      Revoke and stop
                    </button>
                  )}
                </div>
              }
              settings={settings}
              mode={mode}
              route={route}
              busy={busy}
              online={online}
              onMode={changeMode}
              onPermission={(p) => void setPermission(selected, p)}
              onRename={() => setRenaming({ id: selected.id, name: threadName(selected, state) })}
              onSend={(m, text, r, failing, sources) =>
                void send(selected, m, text, r, failing, sources)
              }
              onResolve={(n, res, allow) => void resolveNeed(n, res, allow)}
              onPreview={setPreviewNeed}
              onStopSession={(id) => void stopSession(id)}
              onOpenBoard={() => setView('Board')}
              streaming={streamingForSelected}
              onCancelText={cancelAsk}
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
                {activity ? (
                  <ActivityOverview activity={activity} onOpenRow={openActivityRow} />
                ) : (
                  <p className="caption">Start one and it is listed in the rail.</p>
                )}
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
                await startTask(task, routeForTask(task));
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
        {/* Last in the stage on purpose: the pane is the third grid column, so
            it must follow whichever screen is showing. */}
        {filesOpen && (
          <FilesPane
            projectId={projectId}
            documents={documents}
            loading={documentsLoading}
            failure={documentsFailure}
            openPath={openPath}
            width={filesWidth}
            onOpen={setOpenPath}
            onWidth={setFilesWidth}
            onClose={() => setFilesOpen(false)}
          />
        )}
      </div>

      <Palette
        open={paletteOpen}
        entries={paletteEntries}
        onClose={closePalette}
        query={paletteQuery}
        onQuery={setPaletteQuery}
      />
      {toast && (
        <div className="toast show" role="status">
          {toast}
        </div>
      )}

      {workspacesOpen && workspace && (
        <WorkspacePanel
          view={workspace}
          busy={busy}
          onClose={() => setWorkspacesOpen(false)}
          onChanged={setWorkspace}
          report={report}
        />
      )}
      {sendTask && (
        <Modal title="Send this task?" onClose={() => setSendTask(null)}>
          <p className="prose">
            Send the instruction for {sendTask.task.name} to{' '}
            {isExternalEngine(sendTask.route) ? ENGINE_NAMES[sendTask.route] : sendTask.route} using
            its selected model and account. No documents are included. File proposals will wait for
            exact approval.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setSendTask(null)}>Cancel</Button>
            <Button
              tone="primary"
              onClick={() => {
                const pending = sendTask;
                setSendTask(null);
                void dispatchTask(pending.task, pending.route);
              }}
            >
              Send task
            </Button>
          </div>
        </Modal>
      )}
      {permissionsOpen && selected && (
        <Modal title="Task permissions" onClose={() => setPermissionsOpen(false)}>
          <PermissionPanel
            key={`${projectId}:${selectedTask?.id ?? 'none'}:${route}`}
            projectId={projectId}
            projectName={project.name}
            taskId={selectedTask?.id ?? null}
            taskName={selectedTask?.name ?? null}
            engine={route}
            onChange={() => {
              void load().catch(report);
            }}
          />
        </Modal>
      )}
      {previewNeed && (
        <Modal
          title={`${
            formatOrigin(
              originForNeed(
                previewNeed,
                state.sessions.find((s) => s.id === previewNeed.sessionId),
              ),
            ).label
          } proposes to ${previewNeed.what}`}
          wide
          onClose={() => setPreviewNeed(null)}
        >
          <p className="prose">
            {previewNeed.why} {previewNeed.consequence}
          </p>
          <ApprovalStatus need={previewNeed} />
          {previewNeed.authorizationBoundary && (
            <p>Approval needed: {previewNeed.authorizationBoundary}</p>
          )}
          <HarnessProposal need={previewNeed} />
          {previewNeed.preview?.map((change) => (
            <ChangeCard key={change.id} change={change} detail={settings.detail}>
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
  return c.attachedTo.kind === 'project'
    ? 'Project thread'
    : `${titleCase(c.attachedTo.kind)}: ${c.attachedTo.ref}`;
}
function threadOwnsNeed(thread: Conversation, need: Need, state: ProjectState) {
  const session = state.sessions.find((item) => item.id === need.sessionId);
  if (session?.threadId) return session.threadId === thread.id;
  if (thread.taskId) return need.taskId === thread.taskId;
  // Without a task link, project-level threads carry the needs that no task thread owns.
  return (
    thread.attachedTo.kind === 'project' &&
    !state.conversations.some((c) => c.taskId && c.taskId === need.taskId)
  );
}
/**
 * Per-person interface memory. A browser that refuses storage still gets the
 * pane; it simply does not remember it.
 */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // No storage: the choice lasts for this session only.
  }
}
function isMissingRoute(e: unknown) {
  return (
    typeof e === 'object' && e !== null && 'status' in e && (e as { status: number }).status === 404
  );
}
function isAbortError(e: unknown) {
  return (
    (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') ||
    (typeof e === 'object' &&
      e !== null &&
      'name' in e &&
      (e as { name: unknown }).name === 'AbortError')
  );
}
