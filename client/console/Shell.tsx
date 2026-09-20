import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { selectedEngine } from '../../shared/ai-selection';
import { formatOrigin, originForNeed, originForSession } from '../../shared/attribution';
import type { ScopeGrantView } from '../../shared/permissions';
import { isRoute, isExternalEngine } from '../../shared/engines';
import {
  selectTaskSources,
  taskDocumentProblem,
  TASK_SOURCE_LIMITS,
} from '../../shared/task-sources';
import { TaskDocumentSelect } from './TaskDocumentSelect';
import type {
  Change,
  Conversation,
  DocumentInfo,
  EngineCatalog,
  IntegrationStatus,
  Mode,
  Need,
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
import { createTask as admitTaskCreation } from '../task-create';
import { decideApproval, reconcileApprovals } from '../approval-decisions';
import {
  ApprovalStatus,
  HarnessProposal,
  ChangeCard,
  Button,
  Modal,
  time,
  titleCase,
  askDraftKey,
  askModeKey,
} from '../components';
import { Mark } from './Mark';
import { Rail, type RailItem } from './Rail';
import { ThreadView } from './ThreadView';
import { acceptPreview, type PreviewPosition } from './engine-text-preview';
import { SendConfirmation } from './SendConfirmation';
import { PermissionPanel } from './PermissionPanel';
import { Ledger } from './Ledger';
import { Picker } from './Picker';
import { COMPOSER_LABEL } from './Composer';
import { AgentPicker } from './AgentPicker';
import { BoardView } from './BoardView';
import { FilesPane, DEFAULT_WIDTH, clampWidth } from './FilesPane';
import { ActivityOverview } from './ActivityOverview';
import { projectActivity, type ActivityRow } from './activity';
import { TeamView } from './TeamView';
import { HistoryView } from './HistoryView';
import { DocumentEditor, UNSAVED_WARNING } from './DocumentEditor';
import type { EverythingItem } from './Everything';
import { Palette } from './Palette';
import { WorkspaceMark, WorkspacePanel, useWorkspace } from './Workspaces';
import { applyQuery, buildEntries, type PaletteContext } from './paletteEntries';
import { useTravelOnView } from './motion';
import type { ShellView } from './types';
import './console.css';
import './palette.css';
import './motion.css';
import './files.css';
import { activeInstructionFiles } from '../../shared/capability-packs';

interface ShellProps {
  projectId: string;
  projects: Project[];
  settings: Settings;
  integrations: IntegrationStatus[];
  usage: UsageSnapshot[];
  saveSettings: (value: Settings) => Promise<void>;
  openEngineSettings: () => void;
  onOpenProject: (project: Project) => void;
  onShowProjects: () => void;
  onOpenSettings: () => void;
  report: (e: unknown) => void;
  online: boolean;
  /** Registration so App can open the console palette on Ctrl+K. */
  onPaletteKey?: (open: () => void) => void;
  /**
   * A route and model a connection test verified, handed over from Settings so
   * the person can write their first task on it. `n` identifies one handover,
   * which is taken exactly once. It chooses; it never sends.
   */
  firstTask?: { route: Route; model: string; effort: string | null; n: number } | null;
  /** Said once the handover above has been applied, so it is not applied again. */
  onFirstTaskTaken?: () => void;
}

const emptyTeam: TeamState = { members: [], messages: [], runs: [] };

/**
 * What the rail carries before anybody changes it: the three screens that were
 * already in the view switch, the History the Console just gained, and the
 * Files pane that was already in its foot. That is six fewer decisions made for
 * everybody than the eight fixed buttons this replaces, and every one of them
 * can now be taken out. Everything else is one click away in Everything.
 */
const DEFAULT_PINS = ['thread', 'board', 'team', 'history', 'files'];

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
  openEngineSettings,
  onOpenProject,
  onShowProjects,
  onOpenSettings,
  report,
  online,
  onPaletteKey,
  firstTask,
  onFirstTaskTaken,
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
  const [sendTask, setSendTask] = useState<{
    task: Task;
    route: Route;
    sources: string[];
    namedSources: string[];
    documents: DocumentInfo[];
  } | null>(null);
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
  // What this person keeps in the rail. Remembered per person and never per
  // project, the same as the Files pane above: which destinations you reach for
  // is a habit, not a property of the work.
  //
  // localStorage rather than Settings on purpose. `validateSettings` rejects any
  // key that is not in `defaults()`, so a new settings key is a server change
  // that every existing settings file has to be migrated through; pins do not
  // earn that yet. A browser that refuses storage gets the defaults every time
  // and everything still works.
  const [pins, setPins] = useState<string[]>(() => {
    const saved = stored('console.rail.pins');
    if (saved === null) return DEFAULT_PINS;
    try {
      const parsed: unknown = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : DEFAULT_PINS;
    } catch {
      return DEFAULT_PINS;
    }
  });
  // The file being written in, on the main stage, and whether it holds writing
  // that has not been saved. The Console owns the warning because the Console
  // owns the navigation the warning is about.
  const [editing, setEditing] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
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
  const streamingRunId = useRef<string | null>(null);
  const streamingPosition = useRef<PreviewPosition>(null);
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
    for (const id of ['codex', 'claude-code', 'opencode', 'oh-my-pi', 'cursor', 'devin'] as const) {
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
    const discardPreview = () => {
      if (streamingId.current == null || streamingPosition.current === 'lost') return;
      streamingPosition.current = 'lost';
      setStreaming(null);
      update();
    };
    // EventSource reconnects without replaying ephemeral text. A missed frame
    // invalidates the whole preview; read the durable outcome without dispatch.
    es.addEventListener('error', discardPreview);
    es.addEventListener('open', update);
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
        runId?: unknown;
        stepId?: unknown;
        attempt?: unknown;
        fence?: unknown;
        seq?: unknown;
        kind?: unknown;
        text?: unknown;
      };
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      if (
        !data ||
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
        if (typeof data.runId !== 'string' || !data.runId) return;
        if (streamingId.current != null) return;
        streamingId.current = data.requestId;
        // The stream binds to the run that owns it: deltas and the end frame
        // only count when they carry the same authoritative run identity.
        streamingRunId.current = data.runId;
        streamingPosition.current = null;
        setStreaming({
          requestId: data.requestId,
          threadId: data.threadId,
          text: '',
          engine: askEngine.current ?? '',
        });
        return;
      }
      if (streamingId.current == null || data.requestId !== streamingId.current) return;
      if (
        data.runId !== streamingRunId.current || data.threadId !== askThreadId.current
      )
        return;
      if (data.kind === 'delta') {
        const accepted = acceptPreview(streamingPosition.current, { ...data, kind: 'text-delta' });
        if (accepted.kind === 'discard') {
          discardPreview();
          return;
        }
        if (accepted.kind === 'ignore') return;
        streamingPosition.current = accepted.cursor;
        setStreaming((prev) => {
          if (!prev || prev.requestId !== data.requestId) return prev;
          const next = (prev.text + accepted.text).slice(0, MAX_STREAM_CHARS);
          return next === prev.text ? prev : { ...prev, text: next };
        });
        return;
      }
      streamingId.current = null;
      streamingRunId.current = null;
      streamingPosition.current = null;
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
      streamingRunId.current = null;
      streamingPosition.current = null;
      setStreaming(null);
    };
  }, [projectId]);

  useEffect(() => {
    remember('console.files.open', filesOpen ? 'true' : 'false');
  }, [filesOpen]);
  useEffect(() => {
    remember('console.files.width', String(filesWidth));
  }, [filesWidth]);
  useEffect(() => {
    remember('console.rail.pins', JSON.stringify(pins));
  }, [pins]);
  // `statePayload` strips `documents` from the SSE fan-out, so the listing is
  // fetched here: when the pane or the palette wants it, and again on each
  // state event while one of them is open. Nothing reads `state.documents`.
  // The Board uses the same listing for the new task's document picker.
  // Starts refresh it again before presenting the selection and dispatching.
  // The editor is on this list too: it opens one file from the listing, and a
  // person can reach it from History without the pane ever having been open.
  const wantDocuments = filesOpen || paletteOpen || view === 'Board' || editing !== null;
  const documentsFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wantDocuments) return;
    let alive = true;
    setDocumentsLoading(true);
    listDocuments(projectId)
      .then((result) => {
        if (!alive || currentId.current !== projectId) return;
        setDocuments(result.documents);
        documentsFor.current = projectId;
        setDocumentsFailure(null);
      })
      .catch((e: unknown) => {
        if (!alive || currentId.current !== projectId) return;
        setDocuments([]);
        documentsFor.current = null;
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
  // A mode chosen on the Projects page arrives with the carried ask and lands on
  // the thread the draft opens in. Declared after the effect above, which would
  // otherwise put the thread's stored mode back in the same commit.
  useEffect(() => {
    if (!selected) return;
    let carried: string | null = null;
    try {
      carried = localStorage.getItem(askModeKey(projectId));
      if (carried !== null) localStorage.removeItem(askModeKey(projectId));
    } catch {
      // Storage is unavailable; the thread keeps its own mode.
    }
    if (carried !== 'ask' && carried !== 'plan' && carried !== 'build' && carried !== 'fix') return;
    if (carried === (selected.mode ?? 'ask')) return;
    const next: Mode = carried;
    setMode(next);
    void api(`${base}/threads/${selected.id}`, 'PUT', { mode: next }).catch((e: unknown) => {
      report(e);
      setMode(selected.mode ?? 'ask');
    });
  }, [selected?.id]);
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

  // An ask carried from the Projects page needs a thread to land in. A project
  // with none would show "No threads yet" over a draft nobody can see, so the
  // thread is opened for it, once per project.
  const openedForAsk = useRef('');
  useEffect(() => {
    if (!state || state.project.id !== projectId || threads.length > 0) return;
    if (openedForAsk.current === projectId) return;
    let carried = '';
    try {
      carried = localStorage.getItem(askDraftKey(projectId)) ?? '';
    } catch {
      // Storage is unavailable; nothing was carried.
    }
    if (!carried) return;
    openedForAsk.current = projectId;
    void newThread();
  }, [state, projectId, threads.length]);

  // One handover from Settings, taken once: the route and model a connection
  // test verified become this thread's choice through the same call the Picker
  // makes, the cursor goes into the composer, and nothing is sent. A project
  // that has no thread yet gets the same new thread the rail's own button
  // opens, rather than a draft with nowhere to land.
  const takenStart = useRef(0);
  const openedForStart = useRef('');
  useEffect(() => {
    if (!firstTask || firstTask.n === takenStart.current) return;
    if (!state || state.project.id !== projectId) return;
    if (!selected) {
      if (threads.length > 0 || openedForStart.current === projectId) return;
      // A carried ask is already opening one above; waiting for it is what keeps
      // a project from being given two empty threads in the same pass.
      if (openedForAsk.current === projectId) return;
      openedForStart.current = projectId;
      void newThread();
      return;
    }
    takenStart.current = firstTask.n;
    setView('Thread');
    pick({ model: firstTask.model, effort: firstTask.effort }, firstTask.route);
    rootRef.current
      ?.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${COMPOSER_LABEL}"]`)
      ?.focus();
    say(`This thread uses ${firstTask.model}. Write your first task.`);
    onFirstTaskTaken?.();
  }, [firstTask?.n, state, projectId, selected?.id, threads.length]);

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
  /**
   * Creation uses ordinary command admission. The returned Task is already
   * Ready by projection; no run or task move follows. Only an unconfirmed create
   * keeps the form open: a later refresh failure must not invite a second task.
   */
  async function createTask(input: { name: string; description: string; sourceDocument?: string }) {
    setBusy(true);
    try {
      // The pending record carries the chosen document, so a retry re-sends exactly it.
      await admitTaskCreation(projectId, input);
      await load().catch(report);
    } catch (error) {
      report(error);
      throw error;
    } finally {
      setBusy(false);
    }
  }
  async function startTask(task: Task, route: Route) {
    if (route !== 'sample') {
      setBusy(true);
      try {
        const listed = (await listDocuments(projectId)).documents;
        if (currentId.current !== projectId) return;
        // Keep an unavailable saved path visible so the person can replace it.
        const sources = task.sourceDocument !== undefined
          ? [task.sourceDocument]
          : selectTaskSources(task, listed);
        setSendTask({ task, route, sources, namedSources: sources, documents: listed });
      } catch (error) {
        report(error);
      } finally {
        setBusy(false);
      }
      return;
    }
    await dispatchTask(task, route);
  }
  async function dispatchTask(task: Task, route: Route, sources?: string[]) {
    await perform(async () => {
      if (route !== 'sample') {
        const listed = (await listDocuments(projectId)).documents;
        for (const source of sources ?? []) {
          const problem = taskDocumentProblem(source, listed);
          if (problem) throw new Error(problem);
        }
      }
      if (currentId.current !== projectId) return;
      const thread = state?.conversations.find((item) => item.taskId === task.id);
      await startWork(projectId, {
        taskId: task.id,
        route,
        sources: sources ?? [],
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
            ...(sources ? { sources } : {}),
            ...(mode === 'fix' && failing ? { failing } : {}),
          },
          control.signal,
        );
        await load();
        // The persisted turn is in; drop the ephemeral text if still ours.
        streamingId.current = null;
        streamingRunId.current = null;
        streamingPosition.current = null;
        setStreaming((prev) => (prev && prev.threadId === thread.id ? null : prev));
      } catch (e) {
        if (control.signal.aborted || isAbortError(e)) {
          streamingId.current = null;
          streamingRunId.current = null;
          streamingPosition.current = null;
          setStreaming((prev) => (prev && prev.threadId === thread.id ? null : prev));
          report(new Error('Request stopped. The provider may still consume usage.'));
          return;
        }
        streamingId.current = null;
        streamingRunId.current = null;
        streamingPosition.current = null;
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
  async function messageSources(
    thread: Conversation,
    mode: Mode,
    text: string,
    failingDocument: string,
  ): Promise<string[]> {
    // Preserve explicit attachments and Fix's failing document. Ask may also
    // carry documents named by the person in this message or its owning task.
    // Never infer scope from assistant prose or the rest of the transcript.
    const sources = [...new Set([
      ...(mode === 'fix' && failingDocument ? [failingDocument] : []),
      ...(['document', 'plan'].includes(thread.attachedTo.kind)
        ? [thread.attachedTo.ref]
        : []),
    ])];
    if (mode !== 'ask') return sources;
    const listed = (await listDocuments(projectId)).documents;
    const task = taskOf(thread);
    const named = selectTaskSources({
      name: text,
      description: task ? `${task.name}\n${task.description ?? ''}` : '',
    }, listed);
    // Attachments are also included by the server. Reserve their room before
    // adding named documents so the preview and submitted list stay identical.
    let bytes = sources.reduce(
      (sum, source) => sum + (listed.find((d) => d.path === source)?.size ?? 0),
      0,
    );
    for (const source of named) {
      if (sources.includes(source)) continue;
      const size = listed.find((d) => d.path === source)!.size;
      if (sources.length >= TASK_SOURCE_LIMITS.files || bytes + size > TASK_SOURCE_LIMITS.bytes)
        continue;
      sources.push(source);
      bytes += size;
    }
    return sources;
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

  /**
   * Everywhere the Console can go, in one list, because the rail and the
   * flyout have to agree about what exists and only one of them should be
   * holding the list.
   *
   * Two rows carry `unavailableReason` and open nothing. They are here rather
   * than hidden because a person asking "can it do X" deserves the answer
   * "not yet, and here is why" instead of silence:
   *
   * - Automations has no built item behind it. The button exists, the work it
   *   would run does not, and wiring the button to nothing would be worse than
   *   saying so (owner decision, 2026-09-19).
   * - Connections runs against three hardcoded example locations, which its own
   *   heading calls synthetic data. It is real code and a real demo; it is not
   *   a connection to anything this person owns, and presenting it as one would
   *   be the drift we just took off the marketing site.
   */
  // A label names the screen it opens, so Board and Team keep the words their
  // own headings use. The plain-language explanation belongs in `hint`, where
  // it does not have to disagree with the place it takes you.
  const destinations: EverythingItem[] = [
    {
      id: 'thread',
      label: 'Thread',
      hint: 'The conversation you are having, and everything it produced.',
    },
    {
      id: 'board',
      label: 'Board',
      hint: 'Everything asked for, who has it, and what is waiting on you.',
      badge: openTasks > 0 ? `${openTasks} open` : undefined,
    },
    {
      id: 'team',
      label: 'Team',
      hint: 'The helpers on this project, what they are doing, and what they cost.',
      badge: team.members.length > 0 ? `${team.members.length} workers` : undefined,
    },
    {
      id: 'history',
      label: 'History',
      hint: 'Every change made in this project, and the way to put files back.',
    },
    {
      id: 'files',
      label: 'Files',
      hint: "Read and write in this project's documents.",
    },
    {
      id: 'automations',
      label: 'Automations',
      hint: 'Work that runs on its own, on a schedule or when something happens.',
      unavailableReason:
        'Nothing is built behind this yet. It opens once there is real work for it to run.',
    },
    {
      id: 'connections',
      label: 'Connections',
      hint: 'Watch the software your business already runs on, and act on what it says.',
      unavailableReason:
        'It runs on example data rather than your own software, so nothing it would show you is yours.',
    },
    {
      id: 'engines',
      label: 'AI engines',
      hint: 'Which engines are installed, signed in, and available to this project.',
    },
    {
      id: 'settings',
      label: 'Settings',
      hint: 'How much Diomedes explains, what it may do on its own, and how it looks.',
    },
    {
      id: 'projects',
      label: 'Projects',
      hint: 'Leave this project and open another one.',
    },
  ];
  const destinationGroups = [
    { heading: 'In this project', ids: ['thread', 'board', 'team', 'history', 'files'] },
    { heading: 'Diomedes', ids: ['engines', 'settings', 'projects'] },
    { heading: 'Not ready yet', ids: ['automations', 'connections'] },
  ];
  // Which destination the rail and the flyout mark as the one showing. The
  // Files pane is a toggle rather than a screen, so it counts as current while
  // it is open, whatever screen is behind it.
  const currentDestination = editing
    ? 'files'
    : view === 'Board'
      ? 'board'
      : view === 'Team'
        ? 'team'
        : view === 'History'
          ? 'history'
          : 'thread';

  function goTo(id: string) {
    // The editor is the one screen holding writing that only exists here. It
    // confirms its own close, so the rail does not close it out from under a
    // person; it says why it did nothing and leaves them where they are.
    if (editing && unsaved) {
      say(UNSAVED_WARNING);
      return;
    }
    if (editing) setEditing(null);
    if (id === 'thread') setView('Thread');
    else if (id === 'board') setView('Board');
    else if (id === 'team') setView('Team');
    else if (id === 'history') setView('History');
    else if (id === 'files') setFilesOpen(!filesOpen);
    else if (id === 'engines') openEngineSettings();
    else if (id === 'settings') onOpenSettings();
    else if (id === 'projects') onShowProjects();
  }

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
                {/* The button opening this menu is labelled "Interface detail
                    menu" and held no detail control at all, because Detail was
                    gated on the Workbook. It is kept now, so the label is true. */}
                <p className="caption">Detail</p>
                {(['guided', 'standard', 'technical'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="menuitemradio"
                    aria-checked={settings.detail === d}
                    className={settings.detail === d ? 'on' : ''}
                    onClick={() => {
                      setMenuOpen(false);
                      void saveSettings({ ...settings, detail: d });
                    }}
                  >
                    {titleCase(d)}
                  </button>
                ))}
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
            if (editing && unsaved) {
              say(UNSAVED_WARNING);
              return;
            }
            setEditing(null);
            setSelectedId(id);
            setView('Thread');
          }}
          onNew={() => void newThread()}
          destinations={destinations}
          groups={destinationGroups}
          pinned={pins}
          currentId={currentDestination}
          onDestination={goTo}
          onTogglePin={(id) =>
            setPins(pins.includes(id) ? pins.filter((item) => item !== id) : [...pins, id])
          }
        />
        {editing && (
          <section className="screen on" aria-label="Writing in a file">
            <DocumentEditor
              key={`${projectId}:${editing}`}
              projectId={projectId}
              document={
                documents.find((file) => file.path === editing) ?? {
                  path: editing,
                  kind: 'markdown',
                  size: 0,
                  changedAt: new Date().toISOString(),
                  hasChangesWaiting: false,
                  recorded: false,
                }
              }
              onClose={() => {
                setUnsaved(false);
                setEditing(null);
              }}
              onUnsavedChange={setUnsaved}
              onOpen={(path) => setEditing(path)}
              // `load()` refreshes the listing too: the documents effect runs
              // again on every new state object, so a saved file's new size and
              // changed time arrive without a second fetch from here.
              onSaved={(written) => {
                say(`Saved ${written.path}.`);
                void load().catch(report);
              }}
            />
          </section>
        )}
        {!editing && view === 'Thread' && selected && (
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
              instructionFiles={activeInstructionFiles(state.project.packs, state.instructionFiles)}
              followUps={state.followUps ?? []}
              onError={report}
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
              prepareSources={(m, text, doc) => messageSources(selected, m, text, doc)}
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
        {!editing && view === 'History' && (
          <section className="screen on" aria-label="History">
            <HistoryView
              projectId={projectId}
              entries={state.history}
              sessions={state.sessions}
              needs={state.needs}
              busy={busy}
              detail={settings.detail}
              onError={report}
              onRestored={() => void load().catch(report)}
              onSavedVersion={() => void load().catch(report)}
              onOpenFile={(path) => setEditing(path)}
              // Stopped by session, not by task. The session stop route reads
              // the session and takes the task from it, so a restore is never
              // blocked by a task id this view could not name.
              //
              // Not through `perform`: it reports a failure and swallows it, so
              // a stop that did not happen would look like one that did, and
              // History would go straight on to a restore that meets the same
              // 409 with nothing said about why. This rejects, and the dialog
              // says what went wrong. Busy is still held for the same window.
              onStopWork={async (work) => {
                setBusy(true);
                try {
                  await api(`${base}/work/${work.sessionId}/stop`, 'POST', {});
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            />
          </section>
        )}
        {!editing && view === 'Thread' && !selected && (
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
        {!editing && view === 'Board' && (
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
              onCreateTask={createTask}
              documents={documentsFor.current === projectId ? documents : []}
              documentsLoading={documentsLoading}
              documentsFailure={documentsFailure}
            />
          </section>
        )}
        {!editing && view === 'Team' && (
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
            onEdit={(path) => setEditing(path)}
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
        <SendConfirmation
          kind="task"
          instruction={sendTask.task.description
            ? `${sendTask.task.name}\n${sendTask.task.description}`
            : sendTask.task.name}
          route={sendTask.route}
          sources={sendTask.sources}
          mode="build"
          picker={
            <TaskDocumentSelect
              documents={sendTask.documents}
              value={sendTask.sources.length > 1 ? 'named' : sendTask.sources[0] ?? ''}
              namedSources={sendTask.namedSources}
              onChange={(value) =>
                setSendTask({
                  ...sendTask,
                  sources: value === 'named' ? sendTask.namedSources : value ? [value] : [],
                })
              }
            />
          }
          disabled={
            busy ||
            !online ||
            sendTask.sources.some((source) => !!taskDocumentProblem(source, sendTask.documents))
          }
          onClose={() => setSendTask(null)}
          onSend={() => {
            const pending = sendTask;
            setSendTask(null);
            void dispatchTask(pending.task, pending.route, pending.sources);
          }}
        />
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
