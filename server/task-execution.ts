/**
 * The task inspector's execution view (shared/task-execution.ts): what a Board Start of this
 * task would run with, read through the services the Work start admission uses, and what
 * each of its runs recorded. Read-only.
 *
 * The order below is `admitWork` (server/app.ts) for a Board Start, which sends the route
 * `selectedEngine` picks, the task's default document and the task's own thread: the home
 * and update refusals, the Nectovia refusal, the Settings switch and Cloud sharing, then the
 * profile and Agent resolution that `NativeWorkService.start` runs (`routingFor`, `agentFor`)
 * and the model a route default or WorkStyle asks for. Each refusal is collected rather than
 * thrown, in the host's own words, so the inspector can say every reason a Start would stop
 * and not only the first. The admission still decides; nothing here is a grant.
 */
import { selectedEngine } from '../shared/ai-selection.js';
import type { ProfileResolution } from '../shared/agent-profiles.js';
import { AUTO_AGENT } from '../shared/agents.js';
import { routeDisplayName } from '../shared/engines.js';
import { NECTOVIA_ROUTE } from '../shared/model-api.js';
import type { ReadyQueueView } from '../shared/ready-queue.js';
import {
  TASK_EXECUTION_CONTRACT_VERSION,
  summariseRun,
  type TaskExecutionView,
  type TaskRouteSource,
} from '../shared/task-execution.js';
import type { Conversation, ProjectState, Route, Session } from '../shared/types.js';
import { threadChoosesItsOwnModel, type AgentProfileService } from './agent-profiles.js';
import { requireCloudSharing } from './cloud-sharing.js';
import { NECTOVIA_WORK_REFUSED } from './engines/nectovia.js';
import { withProfile, type NativeStartInput, type NativeWorkService } from './native-work.js';
import { ApiError } from './paths.js';
import { HOME_REFUSES_WORK, type Store } from './store.js';

export interface TaskExecutionDeps {
  store: Store;
  profiles: AgentProfileService;
  nativeWork: Pick<NativeWorkService, 'routingFor' | 'agentFor'>;
  /**
   * The model a start on this route asks for when no profile decides it: the thread's pin,
   * its WorkStyle or the route's saved default (`nativeChoice` in server/app.ts). Throws with
   * the refusal a start would give.
   */
  choice(
    route: Exclude<Route, 'sample'>,
    projectId: string,
    thread: Conversation | null,
  ): { model?: string; effort?: string; selection?: 'automatic' | 'runtime-default' };
  /** The Ready queue as the Board reads it. */
  queue(projectId: string): ReadyQueueView;
  /** A run is in flight in this project that the records may not show yet. */
  running(projectId: string): boolean;
  /** The update refusal `admitWork` gives, or null. */
  updateClosing(): string | null;
}

const ACTIVE: readonly Session['state'][] = ['queued', 'working', 'waiting'];
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'This could not be resolved.';

function routeSource(state: ProjectState, thread: Conversation | null): TaskRouteSource {
  if (thread?.engine) return 'thread';
  if (thread && [...thread.turns].reverse().find((turn) => turn.role !== 'you')?.route)
    return 'thread';
  return state.project.ai ? 'project' : 'settings';
}

export async function taskExecutionView(
  deps: TaskExecutionDeps,
  projectId: string,
  taskId: string,
): Promise<TaskExecutionView> {
  const { store } = deps;
  const state = store.state(projectId);
  const task = state.tasks.find((item) => item.id === taskId && !item.deletedAt);
  if (!task) throw new ApiError(404, 'This task was not found.');
  // The task's own thread is the one the Board's Start names (Shell `routeForTask`).
  const thread = state.conversations.find((item) => item.taskId === taskId) ?? null;
  const route = selectedEngine(store.settings, state.project, thread);
  const blockers: string[] = [];
  const notes: string[] = [];
  const block = (reason: string) => {
    if (!blockers.includes(reason)) blockers.push(reason);
  };

  if (store.isHomeProject(projectId)) block(HOME_REFUSES_WORK);
  const closing = deps.updateClosing();
  if (closing) block(closing);
  if (route === NECTOVIA_ROUTE) block(NECTOVIA_WORK_REFUSED);
  const document = task.sourceDocument ?? null;
  const sources = route !== 'sample' && document ? [document] : [];
  if (route !== 'sample' && route !== NECTOVIA_ROUTE) {
    if (store.settings.services?.[route] !== true)
      block('Turn the selected engine on in Settings before using it.');
    try {
      requireCloudSharing(state, route, sources);
    } catch (error) {
      block(message(error));
    }
  }

  const own = state.sessions.filter((session) => session.taskId === taskId);
  if (own.some((session) => ACTIVE.includes(session.state)))
    notes.push('This task has a run in progress.');
  else if (
    state.sessions.some((session) => ACTIVE.includes(session.state)) ||
    deps.running(projectId)
  )
    block('This project already has work in progress.');

  const saved = deps.profiles.profiles.savedRouting(projectId);
  const taskPreference = saved.tasks[taskId] ?? null;
  const listed = (taskPreference?.order.length ?? 0) > 0 || (saved.project?.order.length ?? 0) > 0;
  const requestedAgent = thread?.requested?.agent ?? null;
  let outcome: TaskExecutionView['routing']['outcome'] = { outcome: 'none' };
  let inert: string | null = null;
  let resolvedRoute: Route = route;
  let model: TaskExecutionView['model'] = null;
  let worker: TaskExecutionView['worker'] = {
    requested: requestedAgent,
    resolved: null,
    note: null,
  };
  let permission: TaskExecutionView['permission'] = {
    thread: thread?.permission ?? 'show-first',
    agentCeiling: null,
    granted: null,
    effective: null,
  };

  if (route === 'sample') {
    if (listed) inert = 'The sample route runs a scripted worker, so saved profiles do not choose for it.';
    worker = {
      ...worker,
      note: 'The sample route runs a scripted worker. No Agent or model is involved and nothing is sent anywhere.',
    };
  } else if (route !== NECTOVIA_ROUTE) {
    const applies = deps.profiles.applies(projectId, taskId, thread, requestedAgent);
    if (listed && !applies)
      inert = threadChoosesItsOwnModel(thread)
        ? "This task's thread chose its own model or work style, and a saved list does not override that."
        : requestedAgent && requestedAgent !== AUTO_AGENT
          ? "This task's thread named its own worker, and a saved list never replaces who works."
          : null;
    let input: Pick<NativeStartInput, 'engine' | 'requested' | 'agentId' | 'mode'> = {
      engine: route,
      agentId: requestedAgent,
      mode: 'build',
    };
    if (!applies) {
      try {
        input = { ...input, requested: deps.choice(route, projectId, thread) };
      } catch (error) {
        block(message(error));
      }
    }
    let profile: ProfileResolution | undefined;
    try {
      outcome = await deps.nativeWork.routingFor(projectId, taskId, {
        ...(thread ? { threadId: thread.id } : {}),
        agentId: requestedAgent,
      });
    } catch (error) {
      block(message(error));
    }
    if (outcome.outcome === 'refused') block(outcome.reason);
    if (outcome.outcome === 'resolved') {
      profile = outcome.pick;
      input = withProfile(input, profile);
    }
    const engine = input.engine ?? route;
    resolvedRoute = engine;
    if (engine !== route) {
      // The profile's own route: `NativeWorkService.start` checks its switch and its sharing.
      if (store.settings.services?.[engine] !== true)
        block(`Turn ${engine} on in Settings before using it.`);
      try {
        requireCloudSharing(state, engine, sources);
      } catch (error) {
        block(message(error));
      }
    }
    notes.push(
      `Starting sends the instruction and the documents you choose to ${routeDisplayName(engine)}. You confirm before anything is sent.`,
    );
    model = {
      requested: input.requested?.model ?? null,
      effort: input.requested?.effort ?? null,
      selection:
        input.requested?.selection ?? (input.requested?.model ? 'manual' : 'runtime-default'),
    };
    try {
      const resolved = await deps.nativeWork.agentFor(state, taskId, engine, input, profile);
      if (resolved) {
        worker = {
          requested: input.agentId ?? null,
          resolved: {
            agentId: resolved.agentId,
            agentName: resolved.agentName,
            agentVersion: resolved.agentVersion,
            agentOrigin: resolved.agentOrigin,
            selection: resolved.agentSelection,
            compatible: resolved.compatible,
            unmet: resolved.unmet.map((item) => ({ ...item })),
          },
          note: null,
        };
        permission = {
          ...permission,
          agentCeiling: resolved.policy.agentCeiling,
          granted: resolved.policy.granted,
          effective: resolved.policy.effective,
        };
        if (!resolved.compatible)
          block(
            `${resolved.agentName} cannot work through ${engine}: ${resolved.unmet[0]?.detail ?? 'a required capability is missing.'}`,
          );
      }
    } catch (error) {
      block(message(error));
    }
  }

  const queue = deps.queue(projectId);
  return {
    contractVersion: TASK_EXECUTION_CONTRACT_VERSION,
    projectId,
    taskId,
    thread: thread ? { id: thread.id, name: thread.name ?? 'Task thread' } : null,
    route: {
      id: resolvedRoute,
      name: routeDisplayName(resolvedRoute) || resolvedRoute,
      source: outcome.outcome === 'resolved' ? 'profile' : routeSource(state, thread),
      // No Settings switch governs the sample route or the Nectovia route; the Nectovia
      // route's refusal of Work is a blocker above, not a switch that is off.
      on:
        resolvedRoute === 'sample' ||
        resolvedRoute === NECTOVIA_ROUTE ||
        store.settings.services?.[resolvedRoute] === true,
    },
    routing: {
      task: taskPreference ? { order: [...taskPreference.order], fallback: taskPreference.fallback } : null,
      project: saved.project ? { order: [...saved.project.order], fallback: saved.project.fallback } : null,
      inert,
      outcome,
    },
    worker,
    model,
    permission,
    document,
    blockers,
    notes,
    queue: queue.autoStart ? (queue.items.find((item) => item.taskId === taskId) ?? null) : null,
    runs: own
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
      .map(summariseRun),
  };
}
