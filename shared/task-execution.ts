/**
 * What starting a task would run with, read before anything is admitted, beside what each of
 * its runs actually ran with.
 *
 * A task's execution is assembled at admission from services that already exist: the route
 * the Board's Start sends (`selectedEngine`), the Agent profile that decides it (H09), the
 * Agent and the person's live grant for the task (`AgentRegistry.resolve`), the model a route
 * default or WorkStyle requests, and Cloud sharing. This view runs those same services and
 * writes nothing, so the task inspector can show the answer before a Start and a person can
 * see why a start would be refused. What a run actually used stays in that run's own record
 * (`Session.agent`, `Session.instructions`, `Session.origin`), summarised in `runs` and never
 * re-resolved.
 *
 * It is never authority. The Work start admission resolves again when it runs and is the only
 * thing that admits work; anything that changed in between (a profile, a setting, a grant)
 * is what the run records. Instructions are not assembled here: reading the project's
 * instruction files is the run's job, and the last run's record says what it sent.
 */
import type { AgentResolution } from './agents.js';
import type { ProfileRouting, RoutingPreference } from './agent-profiles.js';
import type { ReadyItem } from './ready-queue.js';
import type { Route, Session, ThreadPermission } from './types.js';

export const TASK_EXECUTION_CONTRACT_VERSION = 1 as const;

/** Which choice decided the route a Start would take. */
export type TaskRouteSource = 'profile' | 'thread' | 'project' | 'settings';

export const TASK_ROUTE_SOURCE_LABELS: Record<TaskRouteSource, string> = {
  profile: 'A saved profile chose it',
  thread: "This task's thread chose it",
  project: "The project's AI",
  settings: 'The default in Settings',
};

export interface TaskWorker {
  agentId: string;
  agentName: string;
  agentVersion: string;
  agentOrigin: AgentResolution['agentOrigin'];
  /** Whether the person named this Agent or Auto chose it. */
  selection: AgentResolution['agentSelection'];
  compatible: boolean;
  unmet: readonly { requirement: string; detail: string }[];
}

/** One run of this task as its own record says it ran. Never recomputed. */
export interface TaskRunSummary {
  sessionId: string;
  state: Session['state'];
  startedAt: string;
  endedAt: string | null;
  route: string | null;
  /** The Work command that admitted it, when it was admitted with one. */
  commandId: string | null;
  worker: string | null;
  profile: { name: string; revision: number } | null;
  model: { requested: string | null; reported: string | null };
  /** Instruction files this run sent and withheld, from its own delivery record. */
  instructions: { sent: number; withheld: number } | null;
}

export interface TaskExecutionView {
  contractVersion: typeof TASK_EXECUTION_CONTRACT_VERSION;
  projectId: string;
  taskId: string;
  /** The task's own thread, whose choices are this task's, or null before it has one. */
  thread: { id: string; name: string } | null;
  route: {
    id: Route;
    name: string;
    source: TaskRouteSource;
    /** Whether Settings has it on. The sample route needs no switch. */
    on: boolean;
  };
  routing: {
    /** The task's own preference, or null when it follows the project's. */
    task: RoutingPreference | null;
    project: RoutingPreference | null;
    /** Why a saved list does not decide this start, or null when it does or none is saved. */
    inert: string | null;
    outcome: ProfileRouting;
  };
  worker: {
    /** The Agent asked for by the task's thread or its profile; null is Auto. */
    requested: string | null;
    resolved: TaskWorker | null;
    /** Why no worker is shown, when none is. */
    note: string | null;
  };
  /** The model a start would ask for. Null on the sample route, or when it could not be decided. */
  model: {
    requested: string | null;
    effort: string | null;
    selection: 'manual' | 'automatic' | 'runtime-default';
  } | null;
  permission: {
    /** The task thread's permission: show first, or the task's own scope. */
    thread: ThreadPermission;
    /** The Agent's own cap, what the person granted for this task, and the narrower of the two. */
    agentCeiling: string | null;
    granted: string | null;
    effective: string | null;
  };
  /** The task's default document, which a Start sends unless the person changes the selection. */
  document: string | null;
  /** What a Start would be refused with right now, in the host's own words. Empty when none. */
  blockers: string[];
  /** Things said before sending that are not refusals. */
  notes: string[];
  /** Where the task stands in the Ready queue, when automatic start is on and it is Ready. */
  queue: ReadyItem | null;
  /** Newest first. */
  runs: TaskRunSummary[];
}

/** One run's own record, summarised for the inspector's history. */
export function summariseRun(session: Session): TaskRunSummary {
  const delivery = session.instructions;
  return {
    sessionId: session.id,
    state: session.state,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    route: session.route ?? session.receipt?.route ?? null,
    commandId: session.receipt?.commandId ?? null,
    worker: session.agent?.agentName ?? null,
    profile: session.agent?.profile
      ? { name: session.agent.profile.name, revision: session.agent.profile.revision }
      : null,
    model: {
      requested: session.origin?.model.requested ?? session.agent?.requestedModel ?? null,
      reported:
        session.origin?.model.reported ?? (session.engine.verified ? session.engine.model : null),
    },
    instructions: delivery
      ? { sent: delivery.files.length, withheld: delivery.excluded?.length ?? 0 }
      : null,
  };
}
