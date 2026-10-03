/**
 * Worker rows from this computer's own records (relay plan step 3): a minimal production
 * WorkRowsSource. A read-only projection: work sessions and Team members from the project's state,
 * and H14 workers from the handoff ledger and the RunService's runs. It writes nothing, starts
 * nothing and never opens a file the work touched. A richer source can replace it behind the same
 * interface (shared/work-rows.ts).
 */
import { EXTERNAL_ENGINES, routeDisplayName } from '../../shared/engines.js';
import { MODEL_API_PROVIDERS, NECTOVIA_ROUTE } from '../../shared/model-api.js';
import { isActiveSession } from '../../shared/task-evidence.js';
import type { HandoffEvent, HandoffOpened } from '../../shared/team-delegation.js';
import type { HistoryEntry, Session, Task, TeamMember } from '../../shared/types.js';
import { latestVerification, verificationOf } from '../../shared/verification.js';
import {
  WORK_ROWS_RELAY_LIMIT,
  type WorkerRow,
  type WorkerRowPayer,
  type WorkerRowState,
  type WorkerRowVerification,
  type WorkRowsSnapshot,
  type WorkRowsSource,
} from '../../shared/work-rows.js';

/** How long a finished run stays among the rows. */
export const RECENT_WORK_MS = 30 * 60_000;

/**
 * Who pays for work on a route, as far as the route alone says: Nectovia credits on the Nectovia
 * route, the company's own key on a provider route, the engine's own sign-in for an engine on this
 * computer, this computer for the sample. Anything else is not known.
 */
export function payerOf(route: string | null | undefined): WorkerRowPayer {
  if (!route) return 'unknown';
  if (route === NECTOVIA_ROUTE) return 'nectovia-credits';
  if (route === 'sample') return 'local';
  if ((MODEL_API_PROVIDERS as readonly string[]).includes(route) || route === 'oh-my-pi') return 'your-key';
  if (route === 'codex' || (EXTERNAL_ENGINES as readonly string[]).includes(route)) return 'your-subscription';
  return 'unknown';
}

/** The route a session ran on, as it recorded it. Sample work records none: its `sample` mark says it ran here. */
export const sessionRoute = (session: Pick<Session, 'route' | 'engine' | 'sample'>): string | null =>
  session.route ?? (session.sample ? 'sample' : (session.engine?.name ?? null));

const isEngine = (route: string | null) => route === 'codex' || (route !== null && (EXTERNAL_ENGINES as readonly string[]).includes(route));

const SESSION_STATE: Record<Session['state'], WorkerRowState> = {
  queued: 'queued', working: 'working', waiting: 'waiting', done: 'answered', stopped: 'stopped', failed: 'failed',
};
const RUN_STATE: Record<string, WorkerRowState> = {
  queued: 'queued', running: 'working', waiting: 'waiting', completed: 'answered', failed: 'failed', cancelled: 'stopped', reconcile_required: 'unknown',
};
const ACTIVE_RUN = new Set(['queued', 'running', 'waiting']);
const VERIFICATION: Record<string, WorkerRowVerification> = { verified: 'verified', 'not-verified': 'unverified', failed: 'failed', uncertain: 'unverified' };

const iso = (value: string | null | undefined): string | null => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** A Stop that ended the task's work and names this run, or came after it started: the row says so until the run ends. */
function stopRequested(task: Task | undefined, session: Session): boolean {
  return (task?.stopReceipts ?? []).some(
    (receipt) => receipt.scope === 'task' && (receipt.sessionId === session.id || (receipt.sessionId === null && receipt.at >= session.startedAt)),
  );
}

function verificationFor(session: Session, task: Task | undefined, history: readonly HistoryEntry[]): WorkerRowVerification {
  if (!latestVerification(history, session.id)) return 'not-run';
  return VERIFICATION[verificationOf({ session, task: task ?? null, history }).state] ?? 'unverified';
}

/** What the rows read from a project's state. */
export interface WorkRowsState {
  tasks: readonly Task[];
  sessions: readonly Session[];
  history: readonly HistoryEntry[];
  team?: { members: readonly TeamMember[] } | null;
}

export interface WorkRowsDeps {
  state(projectId: string): WorkRowsState;
  projectIds(): string[];
  /** Calls back with a project id whenever its records change; answers the unsubscribe. */
  onChange(listener: (projectId: string) => void): () => void;
  /** The project's runs in the RunService, read-only: H14 leads and their workers. */
  runs?: (projectId: string) => Promise<readonly { id: string; state: string; taskId: string | null }[]>;
  /** The H14 handoff ledger, read-only. */
  handoffs?: (projectId: string) => Promise<readonly HandoffEvent[]>;
  now?: () => number;
}

/** The rows of one project at one moment, or null when it has nothing to show. */
export async function workRowsOf(deps: WorkRowsDeps, projectId: string): Promise<WorkRowsSnapshot | null> {
  const state = deps.state(projectId);
  const at = (deps.now ?? Date.now)();
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const members = new Map((state.team?.members ?? []).map((member) => [member.slotId, member]));
  const rows: WorkerRow[] = [];
  let rootRunId: string | null = null;
  let taskTitle: string | null = null;

  // H14: the workers of the newest loop still running.
  if (deps.runs && deps.handoffs) {
    const runs = new Map((await deps.runs(projectId).catch(() => [])).map((run) => [run.id, run]));
    const events: readonly HandoffEvent[] = await deps.handoffs(projectId).catch(() => []);
    const opened = events.filter((event): event is HandoffOpened => event.kind === 'opened' && event.role === 'worker');
    const lead = [...opened].reverse().find((event) => ACTIVE_RUN.has(runs.get(event.leadRunId)?.state ?? ''))?.leadRunId ?? null;
    if (lead) {
      rootRunId = lead;
      const leadTask = runs.get(lead)?.taskId;
      taskTitle = (leadTask && tasks.get(leadTask)?.name) || null;
      const settled = new Map<string, string>();
      for (const event of events) if (event.kind === 'settled') settled.set(event.childRunId, event.state);
      for (const event of opened.filter((item) => item.leadRunId === lead)) {
        const runState = runs.get(event.childRunId)?.state ?? settled.get(event.childRunId);
        rows.push({
          rowId: event.childRunId,
          kind: 'h14-worker',
          label: routeDisplayName(event.route) || 'Worker',
          title: event.task,
          state: runState ? (RUN_STATE[runState] ?? 'unknown') : 'working',
          startedAt: iso(event.at),
          verification: 'not-run',
          payer: payerOf(event.route),
        });
      }
    }
  }

  // Work sessions: running first, newest first, then what finished in the last half hour.
  const newest = [...state.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const recent = newest.filter((session) => !isActiveSession(session) && session.endedAt && at - Date.parse(session.endedAt) < RECENT_WORK_MS);
  for (const session of [...newest.filter(isActiveSession), ...recent]) {
    if (rows.some((row) => row.rowId === session.id)) continue;
    const task = tasks.get(session.taskId);
    const member = session.slotId ? members.get(session.slotId) : undefined;
    const route = sessionRoute(session);
    rows.push({
      rowId: session.id,
      kind: member ? 'team-member' : isEngine(route) ? 'external-worker' : 'session',
      label: member?.name || routeDisplayName(route) || 'Work',
      title: task?.name ?? 'Work',
      state: isActiveSession(session) && stopRequested(task, session) ? 'stop-requested' : SESSION_STATE[session.state],
      startedAt: iso(session.startedAt),
      verification: verificationFor(session, task, state.history),
      payer: payerOf(route),
    });
    taskTitle ??= task?.name ?? null;
  }
  if (rows.length === 0) return null;
  return { projectId, rootRunId, taskTitle, rows: rows.slice(0, WORK_ROWS_RELAY_LIMIT), at: new Date(at).toISOString() };
}

/** The production source over the desktop's records. */
export function storeWorkRows(deps: WorkRowsDeps): WorkRowsSource {
  return {
    snapshot: (projectId) => workRowsOf(deps, projectId),
    projects: async () => deps.projectIds(),
    subscribe: (listener) => deps.onChange(listener),
  };
}
