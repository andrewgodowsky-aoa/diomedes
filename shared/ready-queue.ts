/**
 * The Ready queue: which Ready tasks Diomedes starts on its own, in what order, and why the rest
 * are not starting yet (H07).
 *
 * Nothing here starts anything. A start is a Work command admitted by the Work start route's own
 * path (`admitWork` in server/app.ts) with the claim's own `commandId`, exactly as a person's Start
 * and a queued follow-up are, so the consent, service, scope, receipt and approval checks are the
 * same ones and automatic start never has authority a manual Start would not. This module is the
 * pure half: eligibility, fair ordering and the reason each item is waiting, computed from the
 * task, session, Need, change and claim records alone. Pure: no clock, no store, no request, so
 * the server scheduler and the Board read the same answer and it is tested directly
 * (tests/ready-queue.test.ts).
 *
 * Proposed defaults (recorded in docs/implementation/2026-09-24-h07-ready-scheduling.md):
 * - automatic start is off for every project until the person turns it on;
 * - at most one run per project (the Work start path already refuses a second) and two across
 *   every project, manual starts included;
 * - a task whose route sends to a service starts automatically only when that task already has
 *   an admitted start of exactly the same request (route, documents and thread): the confirmation
 *   a person gave names the engine and the documents, so a Ready task never confirmed for them
 *   waits for the person's own Start.
 */
import type { Change, Need, Route, Session, Task } from './types.js';

export const READY_QUEUE_CONTRACT_VERSION = 1 as const;

/** Conservative limits. Per project is 1 because the Work start path allows one run per project. */
export const READY_QUEUE_LIMITS = Object.freeze({ global: 2, perProject: 1 });
export type ReadyQueueLimits = { readonly global: number; readonly perProject: number };

export const MAX_PAUSE_REASON = 200;

/** Why a queue is paused, and since when. Pausing never stops work that is already running. */
export interface QueuePause {
  readonly at: string;
  readonly by: 'you';
  readonly reason: string;
}

/**
 * One automatic start, from the moment it was claimed. The claim is written before admission and
 * carries the Work `commandId` admission will use, so a restart between the two replays the same
 * command and can never start the task twice.
 */
export interface ReadyClaim {
  readonly id: string;
  readonly commandId: string;
  readonly taskId: string;
  readonly route: Route;
  readonly claimedAt: string;
  /** The Ready moment this claim answered. A task that returns to Ready later is a new moment. */
  readonly readyAt: string;
  state: 'claimed' | 'started' | 'refused';
  sessionId?: string;
  settledAt?: string;
  /** The Work start path's own refusal, verbatim, when it refused. */
  reason?: string;
}

/** Saved on the project. Absent on every project written before the Ready queue existed: off. */
export interface ReadyQueueRecord {
  autoStart: boolean;
  autoStartChangedAt: string | null;
  paused: QueuePause | null;
  claims: ReadyClaim[];
}

export const emptyReadyQueue = (): ReadyQueueRecord => ({
  autoStart: false,
  autoStartChangedAt: null,
  paused: null,
  claims: [],
});

const ACTIVE: readonly Session['state'][] = ['queued', 'working', 'waiting'];
export const isActiveSession = (session: Pick<Session, 'state'>) => ACTIVE.includes(session.state);

/**
 * The moment a task entered Ready, or null when it is not Ready in the sense the queue starts:
 * not deleted, `todo`, no active run, no open Need, no change waiting for review, and either
 * never run or moved back to Ready by the person after its last run. A task whose last run was
 * stopped, failed or finished and that the person did not reopen is not started again on its
 * own: Stop means stop. Every task this answers for is in the Board's Ready column
 * (client/workbench/task-evidence.ts; the agreement is tested).
 */
export function readyAt(
  task: Task,
  sessions: readonly Session[],
  needs: readonly Need[] = [],
  changes: readonly Change[] = [],
): string | null {
  if (task.deletedAt || task.state !== 'todo') return null;
  const own = sessions.filter((session) => session.taskId === task.id);
  if (own.some(isActiveSession)) return null;
  if (needs.some((need) => need.taskId === task.id && need.state === 'open')) return null;
  if (changes.some((change) => change.taskId === task.id && change.state === 'waiting')) return null;
  const move = task.moves.filter((item) => !item.undone).at(-1);
  const reopen = move?.to === 'todo' && move.by === 'you' ? move.at : null;
  if (own.length === 0) return reopen && reopen > task.createdAt ? reopen : task.createdAt;
  const last = own
    .map((session) => session.endedAt ?? session.startedAt)
    .reduce((a, b) => (a > b ? a : b));
  return reopen && reopen >= last ? reopen : null;
}

export type ReadyWhy =
  /** Automatic start is off for this project: the person starts Ready work. */
  | 'off'
  | 'paused'
  | 'all-paused'
  /** Claimed by this pass; admission is under way. */
  | 'starting'
  /** First in line and nothing stops it but the next pass. */
  | 'next'
  | 'in-line'
  | 'project-busy'
  | 'awaiting-decision'
  | 'limit'
  /** Held for the person: needs their confirmation, or the Work start path refused it. */
  | 'held';

export interface ReadyItem {
  taskId: string;
  readyAt: string;
  /** Place in this project's line, 1 first; null for a held task, which holds no place. */
  position: number | null;
  why: ReadyWhy;
  /** One short sentence for the row. */
  detail: string;
}

export interface ReadyProjectInput {
  id: string;
  autoStart: boolean;
  paused: QueuePause | null;
  /** Runs in progress (active sessions or an in-memory run) plus claims not yet settled. */
  running: number;
  /** A running session here is waiting for the person's decision. */
  awaitingDecision: boolean;
  /** The latest claim's time, for least-recently-served order; null when never served. */
  lastClaimAt: string | null;
  /** Eligible Ready tasks. `hold` carries the reason a task waits for the person. */
  ready: readonly { taskId: string; readyAt: string; createdAt: string; hold?: string }[];
}

export interface ReadyPlanInput {
  allPaused: QueuePause | null;
  limits?: ReadyQueueLimits;
  projects: readonly ReadyProjectInput[];
}

export interface ReadyPlan {
  /** What to claim now, in order. Empty when the plan is only read. */
  claims: { projectId: string; taskId: string; readyAt: string }[];
  items: Record<string, ReadyItem[]>;
  running: number;
  limits: ReadyQueueLimits;
}

const ordinal = (n: number) => `#${n} in line`;

/**
 * Fair order. Every project whose queue is on, unpaused and under its own limit is offered one
 * claim per round, least recently served first (ties by id), until the global limit is reached;
 * within a project the oldest Ready moment goes first. A project served now becomes the most
 * recently served, so while slots keep freeing every waiting project reaches the front: nothing
 * starves. Manual work counts toward both limits.
 */
export function planReadyQueue(input: ReadyPlanInput): ReadyPlan {
  const limits = input.limits ?? READY_QUEUE_LIMITS;
  let running = input.projects.reduce((sum, project) => sum + project.running, 0);
  const lines = new Map(
    input.projects.map((project) => [
      project.id,
      [...project.ready]
        .filter((item) => !item.hold)
        .sort(
          (a, b) =>
            a.readyAt.localeCompare(b.readyAt) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.taskId.localeCompare(b.taskId),
        ),
    ]),
  );
  const used = new Map(input.projects.map((project) => [project.id, project.running]));
  const taken = new Map<string, number>();
  const claims: ReadyPlan['claims'] = [];
  const open = (project: ReadyProjectInput) =>
    project.autoStart && !project.paused && !input.allPaused;
  const order = input.projects
    .filter(open)
    .sort(
      (a, b) =>
        (a.lastClaimAt ?? '').localeCompare(b.lastClaimAt ?? '') || a.id.localeCompare(b.id),
    );
  for (let progress = true; progress && running < limits.global; ) {
    progress = false;
    for (const project of order) {
      if (running >= limits.global) break;
      const line = lines.get(project.id)!;
      const next = taken.get(project.id) ?? 0;
      if ((used.get(project.id) ?? 0) >= limits.perProject || next >= line.length) continue;
      const item = line[next];
      claims.push({ projectId: project.id, taskId: item.taskId, readyAt: item.readyAt });
      taken.set(project.id, next + 1);
      used.set(project.id, (used.get(project.id) ?? 0) + 1);
      running += 1;
      progress = true;
    }
  }

  const items: Record<string, ReadyItem[]> = {};
  for (const project of input.projects) {
    const line = lines.get(project.id)!;
    const claimed = taken.get(project.id) ?? 0;
    const full = (used.get(project.id) ?? 0) >= limits.perProject;
    const rows: ReadyItem[] = line.map((item, index) => {
      const position = index + 1;
      const row = (why: ReadyWhy, detail: string): ReadyItem => ({
        taskId: item.taskId,
        readyAt: item.readyAt,
        position,
        why,
        detail,
      });
      if (!project.autoStart) return row('off', 'Start explicitly to run');
      if (input.allPaused) return row('all-paused', `All queues paused · ${ordinal(position)}`);
      if (project.paused) return row('paused', `Queue paused · ${ordinal(position)}`);
      if (index < claimed) return row('starting', 'Starting now');
      const ahead = index - claimed;
      if (ahead > 0) return row('in-line', ordinal(position));
      if (full)
        return project.awaitingDecision
          ? row('awaiting-decision', 'Next · waits on a decision in this project')
          : row('project-busy', 'Next · waits for this project’s running work');
      if (running >= limits.global)
        return row('limit', `Next · waits for a free slot (${limits.global} running)`);
      return row('next', 'Next · starts shortly');
    });
    for (const item of project.ready)
      if (item.hold)
        rows.push({
          taskId: item.taskId,
          readyAt: item.readyAt,
          position: null,
          why: project.autoStart ? 'held' : 'off',
          detail: project.autoStart ? item.hold : 'Start explicitly to run',
        });
    items[project.id] = rows;
  }
  return { claims, items, running, limits };
}

/**
 * Why a Ready task waits for the person instead of starting on its own, or null when the queue
 * may start it. `consented` is true when the task already has an admitted start of exactly the
 * request the queue would send (same route, documents and thread);
 * `serviceOn` is the Settings switch for it. A refused claim for the same Ready moment holds the
 * task with the Work start path's own words until the person starts or reopens it.
 */
export function holdReason(options: {
  route: Route;
  routeName: string;
  consented: boolean;
  serviceOn: boolean;
  refused?: string | null;
}): string | null {
  if (options.refused) return `Not started automatically: ${options.refused}`;
  if (options.route === 'sample') return null;
  if (!options.serviceOn) return `Start it yourself: ${options.routeName} is off in Settings`;
  if (!options.consented)
    return `Start it yourself: sending to ${options.routeName} needs your confirmation`;
  return null;
}

/** What the Board reads for one project: derived on every request, never stored. */
export interface ReadyQueueView {
  contractVersion: typeof READY_QUEUE_CONTRACT_VERSION;
  projectId: string;
  autoStart: boolean;
  paused: QueuePause | null;
  allPaused: QueuePause | null;
  limits: ReadyQueueLimits;
  /** Runs across every project, manual ones included, against `limits.global`. */
  running: number;
  items: ReadyItem[];
}
