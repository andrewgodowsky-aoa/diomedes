import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { selectedEngine } from '../../shared/ai-selection';
import { formatOrigin, originForNeed, originForSession } from '../attribution-display';
import type { RememberOffer, ScopeGrantView } from '../../shared/permissions';
import { isRoute, isExternalEngine, routeDisplayName } from '../../shared/engines';
import type { EngineConnection } from '../../shared/engines';
import {
  mayNameDocument,
  selectTaskSources,
  taskDocumentProblem,
  TASK_SOURCE_LIMITS,
} from '../../shared/task-sources';
import { TaskDocumentSelect } from './TaskDocumentSelect';
import type {
  Change,
  Conversation,
  ConsoleView,
  DocumentInfo,
  EngineCatalog,
  ExternalEngine,
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
import { api, listDocuments, readSettings } from '../api';
import { decideFirstTask } from '../first-task-handoff';
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
import { NectoviaMark } from './NectoviaMark';
import { Rail, type RailItem } from './Rail';
import { ThreadView } from './ThreadView';
import { ThreadMenu } from './ThreadMenu';
import { readRecordedArtifacts } from './artifact-evidence';
import { acceptPreview, type PreviewPosition } from './engine-text-preview';
import {
  discardPendingMessage,
  pendingMessage,
  resendPending,
  UnconfirmedMessage,
  type DispatchIdentity,
  type PendingMessage,
} from '../conversation-send';
import type { MessageResult } from '../../shared/conversation';
import {
  directAskBody,
  planThreadSend,
  readThreadRoute,
  sendThreadConversation,
  stopThreadMessage,
} from './thread-send';
import {
  acceptActivity,
  activityTarget,
  rememberRunActivity,
  type ActivityState,
} from './engine-activity';
import { SendConfirmation } from './SendConfirmation';
import { JobCapWarning } from './JobCapWarning';
import { beforeWake, estimateWake, setThreadTier, wakeOverCap, type CapChoice, type CapPrompt } from '../job-cap-gate';
import { PermissionPanel } from './PermissionPanel';
import { CloudSharing } from './CloudSharing';
import { Ledger } from './Ledger';
import { ThreadModelControls } from './WorkStylePicker';
import type { WorkStyle } from '../../shared/work-style';
import { COMPOSER_LABEL } from './Composer';
import { AgentPicker } from './AgentPicker';
import { BoardView } from './BoardView';
import { FilesPane, DEFAULT_WIDTH, clampWidth } from './FilesPane';
import { threadRun, useArtifactHost } from './artifact-panel';
import { saveArtifact } from './artifact-save';
import { boardFor } from './board-model';
import { useStartedWork } from './ProgressBoard';
import { previewLine } from '../../shared/thread-preview';
import { ActivityOverview } from './ActivityOverview';
import { projectActivity, type ActivityRow } from './activity';
import { useAutomationAttention } from './automation-attention';
import { TeamView } from './TeamView';
import { DocumentEditor } from './DocumentEditor';
import { editorDocument, guardEditorExits, leaveEditor, type EditorExit } from './editor-guard';
import type { EverythingItem } from './Everything';
import { DiscoveryPage } from './DiscoveryPage';
import { ReadinessPage } from './ReadinessPage';
import { AutomationsPage } from './AutomationsPage';
import { Palette } from './Palette';
import { WorkspaceMark, WorkspacePanel, useWorkspace } from './Workspaces';
import { applyQuery, buildEntries, type PaletteContext } from './paletteEntries';
import { useTravelOnView } from './motion';
import type { ShellView } from './types';
import type { NewTeamMember, TeamRoutesView } from '../../shared/team-routes';
import './console.css';
import './artifacts.css';
import './nectovia.css';
import './palette.css';
import './motion.css';
import './files.css';
import {
  activeInstructionFiles,
  isPackActive,
  SMALL_BUSINESS_PACK,
  type PackSkill,
} from '../../shared/capability-packs';
import type { ReadConnectorsView } from '../../shared/read-connectors';
import { skillConnectorNote } from './skill-connectors';
import { TextSizeMenuItems } from './TextSizeMenu';

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
   * which is settled exactly once, and `madeAtMs` is when it was taken: the
   * facts it rests on are the host's, and they expire. It chooses; it never
   * sends.
   */
  firstTask?: {
    route: ExternalEngine;
    model: string;
    effort: string | null;
    madeAtMs: number;
    n: number;
  } | null;
  /**
   * Said once the handover above is settled — applied, refused or let go — so
   * that it is never carried into another project, another thread or another
   * day.
   */
  onFirstTaskTaken?: () => void;
  /**
   * A screen to open, asked for from outside the Console (the Diomedes home's
   * Automations row). `n` identifies one request, which is taken once and then
   * said to be taken, so it never reopens the screen on a later visit.
   */
  viewRequest?: { view: ShellView; n: number } | null;
  onViewRequestTaken?: () => void;
}

const emptyTeam: TeamState = { members: [], messages: [], runs: [] };

/**
 * What the rail carries before anybody changes it: the three screens that were
 * already in the view switch and the Files pane that was already in its foot.
 * Every one of them can be taken out. Everything else is one click away in
 * Everything. A stored pin for the retired History screen names nothing any
 * more, and the rail skips it.
 */
const DEFAULT_PINS = ['thread', 'board', 'team', 'files'];

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
  viewRequest,
  onViewRequestTaken,
}: ShellProps) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ShellView>('Thread');
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  /** A team wake's job-cap question, and how to answer the wake waiting on it. */
  const [capPrompt, setCapPrompt] = useState<(CapPrompt & { answer(choice: CapChoice): void }) | null>(null);
  const [workspace, setWorkspace] = useWorkspace(report);
  const [mode, setMode] = useState<Mode>('ask');
  // The playbook a person picked for their next message in one thread. It lives here, not in
  // the composer, because the send is made here; `n` refills the composer on each pick.
  const [skillDraft, setSkillDraft] = useState<{
    skill: PackSkill;
    threadId: string;
    n: number;
  } | null>(null);
  // The approved read connectors, read each time a playbook is picked, so its launch can say
  // which of them cover what it reads. An unreadable answer shows nothing rather than a guess.
  const [skillConnectors, setSkillConnectors] = useState<ReadConnectorsView | null>(null);
  useEffect(() => {
    if (!skillDraft) return;
    let alive = true;
    void api<ReadConnectorsView>('/ai/read-connectors').then(
      (view) => {
        if (alive) setSkillConnectors(view);
      },
      () => {
        if (alive) setSkillConnectors(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [skillDraft?.n]);
  const [route, setRoute] = useState<Route>(selectedEngine(settings));
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [previewNeed, setPreviewNeed] = useState<Need | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [cloudSharingOpen, setCloudSharingOpen] = useState(false);
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
  const [teamRoutes, setTeamRoutes] = useState<TeamRoutesView | null>(null);
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
  // The file being written in, on the main stage. Every way off it goes
  // through one gate (editor-guard.ts): the editor lets the person go when no
  // writing would be lost and asks when some would (DIO-85). `editingNow` is
  // read by exits that run again once the gate has let them through, before
  // this component has rendered the editor away.
  const [editing, setEditing] = useState<string | null>(null);
  const editorExit = useRef<EditorExit | null>(null);
  const editingNow = useRef(editing);
  editingNow.current = editing;
  useEffect(
    () =>
      guardEditorExits((then) => {
        if (editingNow.current === null) return then();
        const leave = () => {
          editingNow.current = null;
          setEditing(null);
          then();
        };
        if (editorExit.current) editorExit.current(leave);
        else leave();
      }),
    [],
  );
  // Navigation handed out below (the palette's, the header's) leaves the editor first.
  const leavingEditor =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A) =>
      leaveEditor(() => run(...args));
  const [openPath, setOpenPath] = useState<string | null>(null);
  // One exact version open in Files by identity (a Thread reference or a file's version list).
  const [openVersion, setOpenVersion] = useState<{ path: string; sha: string } | null>(null);
  // Files attached to one thread's next message. They go with that thread only.
  const [attached, setAttached] = useState<{ threadId: string; files: DocumentInfo[] } | null>(null);
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
    /** Tool calls on the same run, applied by `acceptActivity`. */
    activity: ActivityState | null;
  } | null>(null);
  // Live tool calls for work runs in this project, by request id (a work run's
  // session id). Ephemeral: a run card shows them only while the run is live.
  const [runActivity, setRunActivity] = useState<Record<string, ActivityState>>({});
  const askControl = useRef<AbortController | null>(null);
  const askThreadId = useRef<string | null>(null);
  const askEngine = useRef<Route | null>(null);
  // The one command a conversation send was issued, so its Stop names that command and no other.
  const askIssued = useRef<DispatchIdentity | null>(null);
  // Bumped when a conversation send ends, so the thread's unconfirmed message is read again.
  const [pendingTick, setPendingTick] = useState(0);
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
  // What the add-member form may offer, read when Team opens: routes that can carry the
  // team tools, whether each is connected, and the models it reported.
  useEffect(() => {
    if (view !== 'Team' || !teamAvailable) return;
    let alive = true;
    api<TeamRoutesView>(`/projects/${projectId}/team/routes`)
      .then((value) => {
        if (alive) setTeamRoutes(value);
      })
      .catch(() => {
        if (alive) setTeamRoutes(null);
      });
    return () => {
      alive = false;
    };
  }, [view, projectId, teamAvailable, team.members.length]);
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
    setOpenVersion(null);
    setAttached(null);
    setDocuments([]);
    setDocumentsFailure(null);
    void load().catch(report);
  }, [load, report]);
  // After the reset above, so a request made on the way in is what shows.
  const takenView = useRef<number | null>(null);
  useEffect(() => {
    if (!viewRequest || viewRequest.n === takenView.current) return;
    takenView.current = viewRequest.n;
    setView(viewRequest.view);
    onViewRequestTaken?.();
  }, [viewRequest, onViewRequestTaken]);
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
          activity: null,
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
    // Live tool calls: the ask on screen owns frames that carry its exact
    // request, run and thread; any other frame in this project may belong to a
    // work run's card, found by its session id. Narration only, never saved.
    const onEngineActivity = (ev: Event) => {
      let data: unknown;
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      const target = activityTarget(data, {
        projectId: currentId.current,
        ask:
          streamingId.current != null &&
          streamingRunId.current != null &&
          askThreadId.current != null
            ? {
                requestId: streamingId.current,
                runId: streamingRunId.current,
                threadId: askThreadId.current,
              }
            : null,
      });
      if (target.kind === 'ask') {
        const requestId = target.requestId;
        setStreaming((prev) => {
          if (!prev || prev.requestId !== requestId) return prev;
          const activity = acceptActivity(prev.activity, data);
          return activity === prev.activity ? prev : { ...prev, activity };
        });
      } else if (target.kind === 'run') {
        setRunActivity((prev) => rememberRunActivity(prev, data));
      }
    };
    es.addEventListener('engine-activity', onEngineActivity as EventListener);
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
      askIssued.current = null;
      streamingId.current = null;
      streamingRunId.current = null;
      streamingPosition.current = null;
      setStreaming(null);
      setRunActivity({});
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
  // Automation attention (Milestone B) joins Needs you as its own rows.
  const automationNeeds = useAutomationAttention(projectId, `${state?.history.length ?? 0}:${view}`);
  const activity = useMemo(() => {
    if (!state) return null;
    const projected = projectActivity(state, Date.now(), automationNeeds);
    return projected.working.length ||
      projected.needsYou.length ||
      projected.readyForReview.length ||
      projected.finishedRecently.length
      ? projected
      : null;
  }, [state, automationNeeds]);

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
  // The thread's progress board: its attached plan's tasks and the work its
  // conversation started, counted from records only (board-model.ts). The
  // tasks and session events reload `state`, so the board moves with them.
  const started = useStartedWork(projectId, selected, state?.tasks, state?.sessions);
  const board = useMemo(
    () =>
      state && selected
        ? boardFor({
            projectId,
            thread: selected,
            started,
            tasks: state.tasks,
            sessions: state.sessions,
            needs: state.needs,
            changes: state.changes,
          })
        : null,
    [projectId, selected, started, state],
  );
  // What the thread's conversation runs recorded about its artifacts, read once one is open.
  const lineageRuns = selected?.lineages?.map((lineage) => lineage.runId) ?? [];
  // The third column also hosts the artifact panel: a chip in the thread opens
  // it, and Files and the panel keep their own state behind one another.
  const artifactHost = useArtifactHost({
    reset: projectId,
    scope: selected?.id ?? null,
    turns: selected?.turns,
    filesOpen,
    setFilesOpen,
    filesWidth,
    onSave: (record) => saveArtifact(projectId, record),
    onShowFile: (path) => openDocument(path),
    session: threadRun(state?.sessions, selected),
    board,
    boardTitle: state && selected ? threadName(selected, state) : undefined,
    recorded:
      selected && lineageRuns.length > 0
        ? {
            key: `${selected.id}|${lineageRuns.join(',')}|${selected.turns.length}`,
            read: (signal) => readRecordedArtifacts(projectId, lineageRuns, signal),
          }
        : null,
  });
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
  /**
   * A run of the selected thread's task is in flight. One value, read by the
   * two pickers and by the guard inside `pick()`, so no caller can be looking
   * at a different answer than the one that refuses.
   */
  const selectedLive = selectedTask ? liveByTask(selectedTask.id) !== null : false;
  /**
   * The same three facts, kept current at every render. An answer that arrives
   * after an await — the first-task handover re-reads the host before it
   * applies anything — must be decided against the thread that is selected
   * now, not the one that was selected when the read began.
   */
  const current = useRef<{ thread: Conversation | null; live: boolean; busy: boolean }>({
    thread: null,
    live: false,
    busy: false,
  });
  current.current = { thread: selected ?? null, live: selectedLive, busy };
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
  const selectedOffers =
    selected && state
      ? (state.rememberedApprovals?.offers ?? []).filter((offer) => {
          const need = state.needs.find((n) => n.id === offer.needId);
          return offer.state === 'open' && !!need && threadOwnsNeed(selected, need, state);
        })
      : [];
  // Live text shows only for the exact selected thread: cross-thread events
  // never render elsewhere.
  const streamingForSelected =
    selected && streaming && streaming.threadId === selected.id
      ? {
          requestId: streaming.requestId,
          text: streaming.text,
          engine: streaming.engine,
          activity: streaming.activity?.lines,
        }
      : undefined;
  // A conversation message this thread sent and never had confirmed, read from the shared claim
  // whenever a send ends or another thread is opened. Unreadable storage reads as none.
  const unconfirmedMessage = useMemo(() => {
    if (!selected) return null;
    try {
      return pendingMessage(projectId, selected.id);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selected?.id, pendingTick]);
  // Tool calls for this project's work runs, by session id, as ThreadView reads them.
  const runActivityLines = useMemo(
    () =>
      Object.fromEntries(Object.entries(runActivity).map(([id, value]) => [id, value.lines])),
    [runActivity],
  );
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

  /**
   * One handover from Settings: the route and model a connection test verified
   * become a thread's choice through the same call the Picker makes, the cursor
   * goes into the composer, and nothing is sent.
   *
   * The offer was gated on four facts of the host's when it was drawn, and used
   * to be applied without asking any of them again — to whatever thread was
   * selected whenever a Console next mounted, over a run in flight and over an
   * explicit choice. So the host is read again here, `decideFirstTask` re-runs
   * that gate against what it now says, and the answer is carried out: applied,
   * given a thread of its own, or let go. An expired offer goes quietly; one
   * whose route moved says so.
   */
  const takenStart = useRef(0);
  const openedForStart = useRef('');
  const [startPass, setStartPass] = useState(0);
  useEffect(() => {
    if (!firstTask || firstTask.n === takenStart.current) return;
    if (!state || state.project.id !== projectId) return;
    // A write of the Console's own is in flight. Nothing is claimed and nothing
    // is read: this runs again when that write finishes.
    if (busy) return;
    // This project has threads and none of them is selected yet, so the Console
    // is still settling. Deciding now would open a thread nobody needed; the
    // dependencies below bring this back when one is selected. A carried ask is
    // already opening one for the same reason.
    if (!selected && (threads.length > 0 || openedForAsk.current === projectId)) return;
    // Claimed before the reads below, so a re-render while they are in flight
    // cannot start a second pass at the same handover.
    takenStart.current = firstTask.n;
    const handover = firstTask;
    let cancelled = false;
    /**
     * Give the handover back unsettled. `again` is for a pass that acted on
     * something — it asks for one more pass, because the dependency it is
     * waiting on may already have changed while this one was in flight. A pass
     * that acted on nothing takes the quiet form and waits for a real change,
     * which is what keeps two of these from chasing each other.
     */
    const release = (again = true) => {
      takenStart.current = 0;
      if (again) setStartPass((n) => n + 1);
    };
    void (async () => {
      let connection: EngineConnection | null = null;
      let storedModel = '';
      try {
        const [status, saved] = await Promise.all([
          api<{ connections: EngineConnection[] }>('/ai/status'),
          readSettings(),
        ]);
        connection = status.connections.find((c) => c.engine === handover.route) ?? null;
        const model = saved.services?.[`${handover.route}Model`];
        storedModel = typeof model === 'string' ? model : '';
      } catch {
        // The host could not be read. That is not a reason to apply a choice
        // made against an older answer; the decision below says so.
        connection = null;
      }
      if (cancelled || currentId.current !== projectId) return;
      // Read now, not from the render this pass began in.
      const { thread, live, busy: writing } = current.current;
      const decision = decideFirstTask({
        pending: {
          route: handover.route,
          model: handover.model,
          effort: handover.effort,
          madeAtMs: handover.madeAtMs,
          n: handover.n,
        },
        now: Date.now(),
        connection,
        storedModel,
        thread: thread
          ? { live, busy: writing, requested: thread.requested ?? null }
          : null,
      });
      if (decision.kind === 'wait') {
        release();
        return;
      }
      if (decision.kind === 'new-thread') {
        const key = `${projectId}:${handover.n}`;
        // One thread per handover. This one already has its own and is waiting
        // for it to arrive, so nothing is opened and nothing is chased.
        if (openedForStart.current === key) {
          release(false);
          return;
        }
        openedForStart.current = key;
        await newThread();
        if (cancelled) return;
        release();
        return;
      }
      if (decision.kind === 'drop') {
        if (decision.sentence) say(decision.sentence);
        onFirstTaskTaken?.();
        return;
      }
      setView('Thread');
      // The guard lives in `pick()`, so this can still be refused by something
      // that changed in the moment between the decision and the call.
      const applied = pick({ model: decision.model, effort: decision.effort }, decision.route, thread, live);
      if (!applied) {
        say('This thread changed while Nectovia was checking it, so nothing was selected.');
        onFirstTaskTaken?.();
        return;
      }
      rootRef.current
        ?.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${COMPOSER_LABEL}"]`)
        ?.focus();
      say(`This thread uses ${decision.model}. Write your first task.`);
      onFirstTaskTaken?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [firstTask?.n, state, projectId, selected?.id, threads.length, busy, startPass]);

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
  /**
   * Launch a playbook: an empty thread is reused, otherwise a new one opens, in the skill's
   * Mode, with the composer filled and the skill shown beside it. Nothing is sent: the person
   * reads, edits and presses Send, and the playbook itself travels in the instruction channel.
   */
  async function launchSkill(skill: PackSkill) {
    await perform(async () => {
      let target = selected && selected.turns.length === 0 ? selected : null;
      if (!target) target = await api<Conversation>(`${base}/threads`, 'POST', {});
      if ((target.mode ?? 'ask') !== skill.mode)
        await api(`${base}/threads/${target.id}`, 'PUT', { mode: skill.mode });
      await load();
      setSelectedId(target.id);
      setMode(skill.mode);
      setView('Thread');
      setSkillDraft((prev) => ({ skill, threadId: target.id, n: (prev?.n ?? 0) + 1 }));
    });
  }
  async function turnOnSkills() {
    await perform(async () => {
      await api(`/projects/${projectId}/packs/${SMALL_BUSINESS_PACK.id}/activate`, 'POST', {});
      await load();
      say(`${SMALL_BUSINESS_PACK.name} skills are on for this project.`);
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
  /**
   * A thread's WorkStyle. It never changes the mode, the permission or the route. Picking one
   * clears a pinned model, because a pin outranks every style and the choice would do nothing;
   * the Agent stays.
   */
  function pickStyle(style: WorkStyle | null) {
    if (!selected || selectedLive || current.current.busy) return;
    const thread = selected;
    const agent = thread.requested?.agent ?? null;
    const unpin = thread.requested?.model
      ? { requested: agent ? { model: null, effort: null, agent } : null }
      : {};
    void perform(async () => {
      await api(`${base}/threads/${thread.id}`, 'PUT', { workStyle: style, ...unpin });
      await load();
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
  /** An exact-model profile (H09) replaces the thread's own Agent and model pick. */
  function pickProfile(profileId: string) {
    if (!selected) return;
    void setRequested(selected, { model: null, effort: null, profile: profileId }, route);
  }
  /**
   * One thread's route and model, changed through the one guard every caller
   * passes. The refusal used to live in the Picker's own menu, which the
   * first-task handover called straight past: it could change the route of a
   * thread with a run in flight. It is here now, so a second caller cannot step
   * around it, and it answers whether the change was made.
   *
   * The thread is a parameter because a caller that waited on the host has to
   * act on the thread that is selected now, not the one its render closed over.
   */
  function pick(
    requested: Conversation['requested'],
    engine: string,
    thread: Conversation | null = selected ?? null,
    live: boolean = selectedLive,
  ): boolean {
    if (!thread || !isRoute(engine)) return false;
    if (live || current.current.busy) return false;
    setRoute(engine);
    // Changing the model must not silently change the worker.
    const agent = thread.requested?.agent ?? null;
    const next = agent
      ? { model: requested?.model ?? null, effort: requested?.effort ?? null, agent }
      : requested;
    void setRequested(thread, next as Conversation['requested'], engine);
    return true;
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
  // Errors reach the add-member form, which says them in place, so this skips perform().
  async function addMember(input: NewTeamMember) {
    await api(`${base}/team/members`, 'POST', input);
    await load();
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
      // A wake whose job will likely pass its cap asks first; nothing wakes until a choice.
      const threadId = member.threadId;
      const decided = threadId
        ? await beforeWake({
            estimate: () => estimateWake(projectId, member.slotId),
            ask: (prompt) => new Promise<CapChoice>((answer) => setCapPrompt({ ...prompt, answer })),
            upgrade: (tier) => setThreadTier(projectId, threadId, tier),
          })
        : 'wake';
      if (decided === 'cancel') return;
      if (decided === 'over') await wakeOverCap(projectId, member.slotId);
      else await api(`${base}/team/members/${encodeURIComponent(member.slotId)}/wake`, 'POST', {});
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
  // Remembered approvals (D5): the exact approval is given first and stays
  // the evidence; remembering its pattern is a second, explicit request.
  async function rememberNeed(need: Need) {
    await perform(async () => {
      await decideApproval(projectId, need, 'go-ahead');
      await api(`${base}/permissions/remembered`, 'POST', { needId: need.id });
      await load();
    });
  }
  async function answerOffer(offer: RememberOffer, accept: boolean) {
    await perform(async () => {
      await api(
        `${base}/permissions/remembered/offers/${encodeURIComponent(offer.id)}/${accept ? 'accept' : 'decline'}`,
        'POST',
        {},
      );
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
  /**
   * One request from a thread, whichever path carries it. `transport` sends it and answers the
   * conversation's result, or null for the direct request path; everything around it — the
   * live text, Stop, the refresh and the errors — is the same for both, so a turn looks the
   * same on screen whichever path it took.
   */
  async function deliver(
    thread: Conversation,
    route: Route,
    transport: (control: AbortController) => Promise<MessageResult | null>,
    onSent?: () => void,
  ) {
    askControl.current?.abort();
    const control = new AbortController();
    askControl.current = control;
    askThreadId.current = thread.id;
    askEngine.current = route;
    askIssued.current = null;
    const dropPreview = () => {
      streamingId.current = null;
      streamingRunId.current = null;
      streamingPosition.current = null;
      setStreaming((prev) => (prev && prev.threadId === thread.id ? null : prev));
    };
    await perform(async () => {
      try {
        const result = await transport(control);
        onSent?.();
        await load();
        // The persisted turn is in; drop the ephemeral text if still ours.
        dropPreview();
        if (result?.interrupted)
          report(new Error('Request stopped. The provider may still consume usage.'));
      } catch (e) {
        dropPreview();
        if (control.signal.aborted || isAbortError(e)) {
          report(new Error('Request stopped. The provider may still consume usage.'));
          return;
        }
        // The message may have been accepted; it stays on the thread to be sent again, which
        // reads what the record says, or discarded.
        if (e instanceof UnconfirmedMessage) await load().catch(() => undefined);
        throw e;
      } finally {
        if (askControl.current === control) {
          askControl.current = null;
          askThreadId.current = null;
          askIssued.current = null;
        }
        setPendingTick((n) => n + 1);
      }
    });
  }
  async function send(
    thread: Conversation,
    mode: Mode,
    text: string,
    route: Route,
    failing?: { document?: string; text?: string },
    sources?: string[],
    skill?: string,
    readAccess?: import('../../shared/read-access').ReadAccess,
  ) {
    await deliver(
      thread,
      route,
      async (control) => {
        // The route is the host's to say: the owner's tier map, else the thread's own route.
        // A tier that cannot run is refused here, in the host's words, before anything is sent.
        const plan = planThreadSend(
          await readThreadRoute(projectId, thread.id, control.signal),
          mode,
          skill,
        );
        if (plan.kind === 'refuse') throw new Error(plan.reason);
        // The composer confirmed (and named) the route it last read. A route that moved since
        // is never sent to under that confirmation.
        if (plan.route !== route)
          throw new Error(
            `This thread now runs on ${routeDisplayName(plan.route)}, not ${routeDisplayName(route)}. Nothing was sent. Send again to use it.`,
          );
        askEngine.current = plan.route;
        if (plan.kind === 'conversation')
          return sendThreadConversation({
            projectId,
            threadId: thread.id,
            text,
            mode: plan.mode,
            paths: sources ?? [],
            signal: control.signal,
            onClaim: (identity) => {
              if (askControl.current === control) askIssued.current = identity;
            },
          });
        await api(
          `${base}/ask`,
          'POST',
          directAskBody({ thread, mode, text, route: plan.route, failing, sources, skill, readAccess }),
          control.signal,
        );
        return null;
      },
      skill ? () => setSkillDraft((prev) => (prev?.threadId === thread.id ? null : prev)) : undefined,
    );
  }
  /** Send again, for the conversation message this thread holds unconfirmed. Never a new command. */
  function resendUnconfirmed(thread: Conversation, saved: PendingMessage) {
    void deliver(thread, route, async (control) => {
      // Only the live answer's name reads this; the host decides where the saved command runs.
      const view = await readThreadRoute(projectId, thread.id, control.signal).catch(() => null);
      if (view && isRoute(view.route)) askEngine.current = view.route;
      return resendPending(projectId, thread.id, saved.commandId, control.signal, (identity) => {
        if (askControl.current === control) askIssued.current = identity;
      });
    });
  }
  function discardUnconfirmed(thread: Conversation, saved: PendingMessage) {
    void perform(async () => {
      await discardPendingMessage(projectId, thread.id, saved.commandId);
      setPendingTick((n) => n + 1);
      await load();
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
    const task = taskOf(thread);
    const description = task ? `${task.name}\n${task.description ?? ''}` : '';
    // Listing the project walks its whole folder, which can take seconds. A
    // message and task that name no document by its file ending cannot select
    // one, so they skip the walk and send at once.
    if (!mayNameDocument(`${text}\n${description}`)) return sources;
    const listed = (await listDocuments(projectId)).documents;
    const named = selectTaskSources({ name: text, description }, listed);
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
    const control = askControl.current;
    const issued = askIssued.current;
    // A direct request is abandoned as before. A conversation message the host holds is
    // interrupted by its command, so the send returns the recorded, stopped turn.
    if (!issued) return control?.abort();
    void stopThreadMessage(issued, () => control?.abort());
  }

  // Conversation shows no Ledger, so a Need that waits outside the open thread
  // is reached from the top bar instead: its thread opens, or, for work started
  // without one, its task's thread, and the Need scrolls into view.
  function reviewElsewhere(need: Need) {
    const owner = state?.conversations.find((c) => threadOwnsNeed(c, need, state)) ?? null;
    const task = need.taskId ? state?.tasks.find((t) => t.id === need.taskId) : undefined;
    if (owner) {
      setSelectedId(owner.id);
      setView('Thread');
    } else if (task) openTaskThread(task);
    scrollToNeed(need);
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
    setOpenVersion(null);
    setOpenPath(path);
    setFilesOpen(true);
    artifactHost.showFiles();
  }
  /** A sent message's file, at the version it named; the current file when none is recorded. */
  function openReference(reference: { path: string; sha: string | null }) {
    if (!reference.sha) return openDocument(reference.path);
    setOpenPath(null);
    setOpenVersion({ path: reference.path, sha: reference.sha });
    setFilesOpen(true);
    artifactHost.showFiles();
  }
  /** A row is a way back into the record it came from, never a new action. */
  function openActivityRow(row: ActivityRow) {
    if (row.view === 'Automations') {
      setView('Automations');
      return;
    }
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
    // The last turn as one plain line: a fence reads as its artifact's title,
    // never as its source. A turn with no line to give (a list) says nothing yet.
    const preview = previewLine(c.turns.at(-1)?.text ?? '', 60);
    return {
      id: c.id,
      name: threadName(c, state),
      time: time(threadTime(c)).toLowerCase(),
      sub: task ? task.name : preview || 'Nothing said yet',
    };
  });
  const openTasks = state.tasks.filter((t) => t.state !== 'done').length;

  /**
   * Everywhere the Console can go, in one list, because the rail and the
   * flyout have to agree about what exists and only one of them should be
   * holding the list.
   *
   * One row carries `unavailableReason` and opens nothing. It is here rather
   * than hidden because a person asking "can it do X" deserves the answer
   * "not yet, and here is why" instead of silence:
   *
   * - Automations held a reserved place here until Milestone A built the
   *   screen behind it (owner decisions 2026-09-19, 2026-09-20 and D4 of
   *   2026-09-24). It now opens, and sits with the workspace's own rows.
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
      id: 'files',
      label: 'Files',
      hint: "Read and write in this project's documents.",
    },
    {
      id: 'discovery',
      label: 'Discovery',
      hint: 'What this business does, gathered from public sources you can check.',
    },
    {
      id: 'readiness',
      label: 'Readiness',
      hint: 'What is in place before work starts, and what is still missing.',
    },
    {
      id: 'automations',
      label: 'Automations',
      hint: 'What runs for this business, what it last did, and what needs you.',
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
      hint: 'How much Nectovia explains, what it may do on its own, and how it looks.',
    },
    {
      id: 'projects',
      label: 'Projects',
      hint: 'Leave this project and open another one.',
    },
  ];
  const destinationGroups = [
    { heading: 'In this project', ids: ['thread', 'board', 'team', 'files'] },
    { heading: 'Nectovia', ids: ['automations', 'engines', 'settings', 'projects'] },
    { heading: 'Not ready yet', ids: ['connections'] },
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
        : view === 'Automations'
          ? 'automations'
          : 'thread';

  function goTo(id: string) {
    // The editor is the one screen holding writing that may exist only here, so
    // the rail leaves it through its gate and comes back here once it may.
    // Files only shows or hides the pane beside the editor, like the palette's
    // Open file, so it leaves nothing and passes no gate.
    if (id === 'files') return artifactHost.toggleFiles();
    if (editingNow.current !== null) return leaveEditor(() => goTo(id));
    if (id === 'thread') setView('Thread');
    else if (id === 'board') setView('Board');
    else if (id === 'team') setView('Team');
    else if (id === 'discovery') setView('Discovery');
    else if (id === 'readiness') setView('Readiness');
    else if (id === 'automations') setView('Automations');
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
    skills: {
      active: isPackActive(state.project.packs, SMALL_BUSINESS_PACK.id),
      name: SMALL_BUSINESS_PACK.name,
      list: SMALL_BUSINESS_PACK.skills,
    },
    members: team.members,
    catalogs,
    integrations,
    projects,
    currentProjectId: projectId,
    currentThread: selected,
    policy,
    view,
    consoleView: settings.view ?? 'architect',
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
      reviewTask: leavingEditor((task: Task) => {
        openTaskThread(task);
        const need =
          task.needId != null
            ? (waiting.find((n) => n.id === task.needId) ?? null)
            : (waiting.find((n) => n.taskId === task.id) ?? null);
        if (need) scrollToNeed(need);
      }),
      routeTask: (task, to) =>
        void perform(async () => {
          await api(`${base}/tasks/${task.id}`, 'PUT', { assignedTo: to });
          await load();
        }),
      reopenTask: (task) => void moveTask(task, 'todo'),
      openBoard: leavingEditor(() => setView('Board')),
      openTeam: leavingEditor(() => setView('Team')),
      setRequested: (requested) => {
        if (selected) void setRequested(selected, requested);
      },
      messageMember: leavingEditor(focusTeamComposer),
      stopMember: (m) => void stopMember(m),
      wakeMember: (m) => void wakeMember(m),
      selectThread: leavingEditor((id: string) => {
        setSelectedId(id);
        setView('Thread');
      }),
      setView: leavingEditor((v: ShellView) => setView(v)),
      setConsoleView: (v) => void saveSettings({ ...settings, view: v }),
      openProject: (p) => onOpenProject(p),
      openDocument,
      launchSkill: leavingEditor((skill: PackSkill) => void launchSkill(skill)),
      turnOnSkills: () => void turnOnSkills(),
    },
  };
  const paletteEntries = (query: string) => applyQuery(buildEntries(paletteCtx), query);

  // The two views (shared/types.ts ConsoleView). Conversation hides the Ledger,
  // the pinned rail destinations and the worker picker; everything stays
  // reachable from Everything, Ctrl K and the ··· menu.
  const conversation = settings.view === 'conversation';
  const elsewhere = conversation
    ? waiting.filter((n) => !(selected && view === 'Thread' && threadOwnsNeed(selected, n, state)))
    : [];
  const chooseView = (next: ConsoleView) => {
    setMenuOpen(false);
    if (settings.view !== next) void saveSettings({ ...settings, view: next });
  };

  return (
    <div
      ref={rootRef}
      className={`console${conversation ? ' conversation' : ''}${!online ? ' disconnected' : ''}`}
    >
      <header className="top">
        <NectoviaMark />
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
          {elsewhere.length > 0 && (
            <button type="button" className="needs-elsewhere" onClick={() => leaveEditor(() => reviewElsewhere(elsewhere[0]))}>
              {elsewhere.length === 1 ? 'Something needs your OK' : `${elsewhere.length} things need your OK`}
            </button>
          )}
          {selected && !conversation && (
            <AgentPicker
              projectId={projectId}
              thread={selected}
              mode={mode}
              route={route}
              live={selectedLive}
              busy={busy}
              onPick={pickAgent}
              onPickProfile={pickProfile}
            />
          )}
          {selected && (
            <ThreadModelControls
              projectId={projectId}
              thread={selected}
              mode={mode}
              route={route}
              live={selectedLive}
              integrations={integrations}
              settings={settings}
              busy={busy}
              onPick={pick}
              onStyle={pickStyle}
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
          {!conversation && (
            <button type="button" onClick={() => setCloudSharingOpen(true)}>
              Cloud sharing
            </button>
          )}
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
                <p className="caption">View</p>
                {(
                  [
                    ['conversation', 'Conversation'],
                    ['architect', 'Architect'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={(settings.view ?? 'architect') === id}
                    className={(settings.view ?? 'architect') === id ? 'on' : ''}
                    onClick={() => chooseView(id)}
                  >
                    {label}
                  </button>
                ))}
                {conversation && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setCloudSharingOpen(true);
                    }}
                  >
                    Cloud sharing
                  </button>
                )}
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
                <TextSizeMenuItems
                  settings={settings}
                  choose={(scale) => {
                    setMenuOpen(false);
                    void saveSettings({
                      ...settings,
                      appearance: { ...settings.appearance, readingScale: scale },
                    });
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        className={`stage${artifactHost.stageClass}`}
        style={artifactHost.stageStyle}
      >
        <Rail
          top={<WorkspaceMark view={workspace} onOpen={() => setWorkspacesOpen(true)} />}
          items={railItems}
          selectedId={selectedId}
          onSelect={(id) =>
            leaveEditor(() => {
              setSelectedId(id);
              setView('Thread');
            })
          }
          onNew={() => leaveEditor(() => void newThread())}
          destinations={destinations}
          groups={destinationGroups}
          pinned={conversation ? [] : pins}
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
              // No guessed kind: until the listing says what this file is, the
              // editor reads nothing and takes no typing (DIO-87).
              document={editorDocument(documents, editing, documentsFailure)}
              // Close has already asked, and a rescue copy's writing is on disk
              // in the copy, so these two leave without the gate.
              onClose={() => setEditing(null)}
              exits={editorExit}
              // A file the listing cannot be read for, or does not have, can
              // be looked for again: `load()` makes a new state, which lists again.
              listing={{ loading: documentsLoading, refresh: () => void load().catch(report) }}
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
        {!editing && view === 'Discovery' && (
          <section className="screen on" aria-label="Discovery">
            <DiscoveryPage projectId={projectId} />
          </section>
        )}
        {!editing && view === 'Readiness' && (
          <section className="screen on" aria-label="Readiness">
            <ReadinessPage projectId={projectId} />
          </section>
        )}
        {!editing && view === 'Automations' && (
          <section className="screen on" aria-label="Automations">
            <AutomationsPage
              projectId={projectId}
              onOpenTask={(taskId) => {
                const task = state.tasks.find((item) => item.id === taskId);
                if (task) openTaskThread(task);
              }}
              onOpenBoard={(taskId) => {
                const thread = state.conversations.find((item) => item.taskId === taskId);
                if (thread) setSelectedId(thread.id);
                setView('Board');
              }}
              onOpenDocument={openDocument}
              onOpenProject={(id) => {
                const target = projects.find((item) => item.id === id);
                if (target) onOpenProject(target);
                else say('Open that project from Projects to see this run.');
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
              onOpenInFiles={openDocument}
              followUps={state.followUps ?? []}
              controlReceipts={state.controlReceipts ?? []}
              onOpenTask={(taskId) => {
                const target = state.tasks.find((item) => item.id === taskId);
                if (target) openTaskThread(target);
              }}
              reviewComments={state.reviewComments ?? []}
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
              menu={
                <ThreadMenu
                  projectId={projectId}
                  threadId={selected.id}
                  revision={selected.turns.length}
                  onUpdated={() => void load()}
                />
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
              skill={
                skillDraft?.threadId === selected.id && (mode === 'ask' || mode === 'plan')
                  ? {
                      name: skillDraft.skill.name,
                      starter: skillDraft.skill.starter,
                      n: skillDraft.n,
                      connectors: (() => {
                        const note = skillConnectorNote(skillDraft.skill, skillConnectors);
                        return note && { text: note.text, onAdd: note.offerAdd ? openEngineSettings : undefined };
                      })(),
                    }
                  : null
              }
              onClearSkill={() => setSkillDraft(null)}
              attachments={attached?.threadId === selected.id ? attached.files : []}
              onAttachments={(files) => setAttached({ threadId: selected.id, files })}
              attachable={async () => (await listDocuments(projectId)).documents}
              onOpenFile={openDocument}
              onOpenReference={openReference}
              onSend={(m, text, r, failing, sources, readAccess) =>
                void send(
                  selected,
                  m,
                  text,
                  r,
                  failing,
                  sources,
                  skillDraft?.threadId === selected.id && (m === 'ask' || m === 'plan')
                    ? skillDraft.skill.id
                    : undefined,
                  readAccess,
                )
              }
              onResolve={(n, res, allow) => void resolveNeed(n, res, allow)}
              onRemember={(n) => void rememberNeed(n)}
              rememberOffers={selectedOffers}
              onAnswerOffer={(offer, accept) => void answerOffer(offer, accept)}
              onPreview={setPreviewNeed}
              onStopSession={(id) => void stopSession(id)}
              onOpenBoard={() => setView('Board')}
              streaming={streamingForSelected}
              runActivity={runActivityLines}
              onCancelText={cancelAsk}
              unconfirmed={
                unconfirmedMessage
                  ? {
                      text: unconfirmedMessage.input.text,
                      onResend: () => resendUnconfirmed(selected, unconfirmedMessage),
                      onDiscard: () => discardUnconfirmed(selected, unconfirmedMessage),
                    }
                  : null
              }
              artifacts={artifactHost.selection.index}
              onOpenArtifact={(record) => artifactHost.selection.open(record)}
              openArtifactKey={artifactHost.selection.openKey}
            />
            {!conversation && <Ledger
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
            />}
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
            {!conversation && <Ledger
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
            />}
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
              teamRoutes={teamRoutes}
              onAddMember={teamAvailable ? addMember : undefined}
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
            onEdit={(path) => path !== editing && leaveEditor(() => setEditing(path))}
            hidden={artifactHost.shown !== 'files'}
            switcher={artifactHost.switcher}
            onOpenInPanel={artifactHost.openFile}
            history={state.history}
            openVersion={openVersion}
            onOpenVersion={setOpenVersion}
            onAttach={
              selected && view === 'Thread'
                ? (path) => {
                    const file = documents.find((item) => item.path === path);
                    if (!file) return;
                    const current = attached?.threadId === selected.id ? attached.files : [];
                    if (!current.some((item) => item.path === path))
                      setAttached({ threadId: selected.id, files: [...current, file] });
                  }
                : undefined
            }
          />
        )}
        {artifactHost.pane}
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
          onOpenAutomations={() => {
            setWorkspacesOpen(false);
            setView('Automations');
          }}
        />
      )}
      {capPrompt && (
        <JobCapWarning
          copy={capPrompt.copy}
          onUpgrade={() => {
            setCapPrompt(null);
            capPrompt.answer('upgrade');
          }}
          onGoOver={() => {
            setCapPrompt(null);
            capPrompt.answer('over');
          }}
          onCancel={() => {
            setCapPrompt(null);
            capPrompt.answer('cancel');
          }}
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
      {cloudSharingOpen && (
        <CloudSharing
          key={projectId}
          projectId={projectId}
          projectName={project.name}
          onClose={() => setCloudSharingOpen(false)}
          onSaved={() => {
            void load().catch(report);
            setCloudSharingOpen(false);
          }}
        />
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
