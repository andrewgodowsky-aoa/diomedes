/**
 * The Ready scheduler: the server half of `shared/ready-queue.ts` (H07).
 *
 * It starts Ready work on its own for the projects that turned automatic start on, fairly and
 * within the limits, and nothing else. A start is not a back door into the runtime: the scheduler
 * writes a durable claim that carries a fresh Work `commandId`, then calls the Work start route's
 * own admission path (`admitWork`) with exactly the command a person's Start sends, so the
 * service, consent, sharing, scope, receipt and approval checks are the same ones. Work that asks
 * for a decision stops at its Need exactly as manual work does, and a refusal is recorded on the
 * claim in the start path's own words with no work begun.
 *
 * Crash safety comes from the order of the two writes. The claim is persisted before admission,
 * and admission persists the session with the claim's `commandId` on its receipt. On restart a
 * claim still `claimed` is settled from that receipt when the session exists, or replayed with
 * the same command when it does not, so a task is never started twice.
 *
 * Internal API for later feeders (Automations milestone B): `kick()` asks for a pass, `view()`
 * reads a project's line, and the queue itself is the project's Ready tasks. A feeder enqueues by
 * making a Ready task through the task route's own path; nothing here admits work any other way.
 */
import path from 'node:path';
import { z } from 'zod';
import { selectedEngine } from '../shared/ai-selection.js';
import { routeDisplayName } from '../shared/engines.js';
import {
  MAX_PAUSE_REASON,
  READY_QUEUE_CONTRACT_VERSION,
  READY_QUEUE_LIMITS,
  emptyReadyQueue,
  holdReason,
  isActiveSession,
  planReadyQueue,
  readyAt,
  type QueuePause,
  type ReadyClaim,
  type ReadyPlanInput,
  type ReadyProjectInput,
  type ReadyQueueRecord,
  type ReadyQueueView,
} from '../shared/ready-queue.js';
import type { ProjectState, Route, Task } from '../shared/types.js';
import { ApiError } from './paths.js';
import { HOME_REFUSES_WORK, identifier, jsonWrite, now, readJson, type Store } from './store.js';

export interface ReadySchedulerDeps {
  store: Store;
  /**
   * The Work start route's own admission path, called with the store lock held. The scheduler
   * uses exactly this and re-implements none of its checks.
   */
  admit(projectId: string, command: Record<string, unknown>): Promise<unknown>;
  /** A run the host holds in memory for this project, beyond what its sessions record. */
  running(projectId: string): boolean;
}

const settingsSchema = z.strictObject({
  autoStart: z.boolean().optional(),
  paused: z.boolean().optional(),
  reason: z.string().trim().max(MAX_PAUSE_REASON).optional(),
});
const globalSchema = z.strictObject({
  paused: z.boolean(),
  reason: z.string().trim().max(MAX_PAUSE_REASON).optional(),
});
const globalFileSchema = z.object({
  version: z.literal(1),
  paused: z
    .object({ at: z.string(), by: z.literal('you'), reason: z.string().max(MAX_PAUSE_REASON) })
    .nullable(),
});

const pauseOf = (reason: string | undefined, at: string): QueuePause => ({
  at,
  by: 'you',
  reason: reason?.trim() || 'Paused by you',
});

export class ReadyScheduler {
  private allPaused: QueuePause | null = null;
  private closed = false;
  private pass: Promise<void> | null = null;
  private again = false;
  private readonly onChange = () => this.kick();
  constructor(private deps: ReadySchedulerDeps) {}

  private get store() {
    return this.deps.store;
  }
  private get globalPath() {
    return path.join(this.store.dataDir, 'ready-queue.json');
  }

  /** Reads the global pause, settles what a restart interrupted, and starts listening. */
  async init() {
    const saved = await readJson<unknown>(this.globalPath, () => ({ version: 1, paused: null }));
    const parsed = globalFileSchema.safeParse(saved);
    if (!parsed.success)
      throw new Error('The saved Ready queue pause is unreadable. Nothing was rewritten.');
    this.allPaused = parsed.data.paused;
    this.store.on('change', this.onChange);
    this.store.on('settings', this.onChange);
    this.kick();
    await this.settled();
  }

  async close() {
    this.closed = true;
    this.store.off('change', this.onChange);
    this.store.off('settings', this.onChange);
    await this.settled();
  }

  /** Resolves when no pass is running or due. */
  async settled() {
    while (this.pass) await this.pass;
  }

  private record(state: ProjectState): ReadyQueueRecord {
    state.readyQueue ??= emptyReadyQueue();
    state.readyQueue.claims ??= [];
    return state.readyQueue;
  }

  private projectIds() {
    return this.store.projectIds().filter((id) => !this.store.isHomeProject(id));
  }

  private routeFor(state: ProjectState, task: Task): Route {
    const thread = state.conversations.find((item) => item.taskId === task.id);
    return selectedEngine(this.store.settings, state.project, thread);
  }

  /** The planner's input, read from the records alone. */
  private inputs(): ReadyPlanInput {
    const projects: ReadyProjectInput[] = [];
    for (const id of this.projectIds()) {
      const state = this.store.state(id);
      const queue = state.readyQueue ?? emptyReadyQueue();
      const claims = queue.claims ?? [];
      const pending = claims.filter((claim) => claim.state === 'claimed');
      const active = state.sessions.filter(isActiveSession);
      const ready: ReadyProjectInput['ready'][number][] = [];
      for (const task of state.tasks) {
        const moment = readyAt(task, state.sessions, state.needs, state.changes);
        if (moment === null || pending.some((claim) => claim.taskId === task.id)) continue;
        const refused = claims.find(
          (claim) => claim.taskId === task.id && claim.state === 'refused' && claim.readyAt === moment,
        );
        let hold: string | null;
        if (state.project.missing) hold = 'The project folder is missing';
        else
          try {
            const route = this.routeFor(state, task);
            hold = holdReason({
              route,
              routeName: routeDisplayName(route),
              serviceOn: this.store.settings.services?.[route] === true,
              // The confirmation a person gives names the engine, so only a start already
              // admitted for this task on this route is consent to send it there again.
              consented: state.sessions.some(
                (session) => session.taskId === task.id && session.receipt?.route === route,
              ),
              refused: refused?.reason ?? null,
            });
          } catch (error) {
            hold = `Start it yourself: ${error instanceof Error ? error.message : 'no route'}`;
          }
        ready.push({ taskId: task.id, readyAt: moment, createdAt: task.createdAt, ...(hold ? { hold } : {}) });
      }
      const lastClaimAt = claims.reduce<string | null>(
        (latest, claim) => (latest === null || claim.claimedAt > latest ? claim.claimedAt : latest),
        null,
      );
      projects.push({
        id,
        autoStart: queue.autoStart === true,
        paused: queue.paused ?? null,
        running:
          Math.max(active.length, this.deps.running(id) ? 1 : 0) + pending.length,
        awaitingDecision:
          active.some((session) => session.state === 'waiting') ||
          state.needs.some(
            (need) => need.state === 'open' && active.some((session) => session.id === need.sessionId),
          ),
        lastClaimAt,
        ready,
      });
    }
    return { allPaused: this.allPaused, limits: READY_QUEUE_LIMITS, projects };
  }

  /** What the Board shows for one project. Derived on every call; nothing is stored for it. */
  view(projectId: string): ReadyQueueView {
    const state = this.store.state(projectId);
    const queue = state.readyQueue ?? emptyReadyQueue();
    const home = this.store.isHomeProject(projectId);
    const plan = home ? null : planReadyQueue(this.inputs());
    return {
      contractVersion: READY_QUEUE_CONTRACT_VERSION,
      projectId,
      autoStart: queue.autoStart === true,
      paused: queue.paused ?? null,
      allPaused: this.allPaused,
      limits: READY_QUEUE_LIMITS,
      running: plan?.running ?? 0,
      items: plan?.items[projectId] ?? [],
    };
  }

  /** Asks for a pass. Cheap when there is nothing to do: no lock is taken unless work is due. */
  kick() {
    if (this.closed) return;
    if (this.pass) {
      this.again = true;
      return;
    }
    let due: boolean;
    try {
      due =
        this.projectIds().some((id) =>
          (this.store.state(id).readyQueue?.claims ?? []).some((claim) => claim.state === 'claimed'),
        ) || planReadyQueue(this.inputs()).claims.length > 0;
    } catch {
      return;
    }
    if (!due) return;
    this.pass = this.store
      .locked(() => this.run())
      .catch((error) =>
        console.error(
          'The Ready queue could not start work:',
          error instanceof Error ? error.message : error,
        ),
      )
      .finally(() => {
        this.pass = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** One pass, with the store lock held: settle what a restart left, then claim what is due. */
  private async run() {
    for (const id of this.projectIds())
      for (const claim of [...(this.store.state(id).readyQueue?.claims ?? [])])
        if (claim.state === 'claimed') await this.admit(id, claim.id);
    if (this.closed) return;
    const plan = planReadyQueue(this.inputs());
    for (const next of plan.claims) {
      if (this.closed) return;
      const state = this.store.state(next.projectId);
      const task = state.tasks.find((item) => item.id === next.taskId && !item.deletedAt);
      if (!task) continue;
      const claimId = identifier('Q');
      const claim: ReadyClaim = {
        id: claimId,
        commandId: `ready:${claimId}`,
        taskId: task.id,
        route: this.routeFor(state, task),
        claimedAt: now(),
        readyAt: next.readyAt,
        state: 'claimed',
      };
      this.record(state).claims.push(claim);
      // Durable before admission: this is the write a restart reads to replay, not repeat.
      await this.store.persist(state);
      await this.admit(next.projectId, claimId);
    }
  }

  /** Admits one claim through the Work start path, or settles it from the receipt it left. */
  private async admit(projectId: string, claimId: string) {
    const find = () =>
      this.record(this.store.state(projectId)).claims.find((claim) => claim.id === claimId)!;
    const claim = find();
    const settle = async (outcome: { sessionId: string } | { reason: string }) => {
      const state = this.store.state(projectId);
      const current = find();
      current.settledAt = now();
      const task = state.tasks.find((item) => item.id === current.taskId);
      const name = task?.name ?? 'a task';
      if ('sessionId' in outcome) {
        current.state = 'started';
        current.sessionId = outcome.sessionId;
        this.store.addEntry(state, {
          kind: 'ready-start',
          sentence: `Diomedes started ${name} from the Ready queue.`,
          actor: 'diomedes',
          taskId: current.taskId,
          sessionId: outcome.sessionId,
        });
      } else {
        current.state = 'refused';
        current.reason = outcome.reason;
        this.store.addEntry(state, {
          kind: 'ready-start',
          sentence: `Diomedes did not start ${name} from the Ready queue: ${outcome.reason}`,
          actor: 'diomedes',
          taskId: current.taskId,
        });
      }
      await this.store.persist(state);
    };
    // A restart after admission: the session holds the claim's command, so it already ran once.
    const admitted = this.store.workCommand(projectId, claim.commandId);
    if (admitted) return settle({ sessionId: admitted.id });
    const state = this.store.state(projectId);
    const task = state.tasks.find((item) => item.id === claim.taskId && !item.deletedAt);
    if (!task) return settle({ reason: 'This task is no longer here.' });
    const thread = state.conversations.find((item) => item.taskId === task.id);
    // Exactly what a person's Start on the Board sends: the task, its route, the task's own
    // default document when one is set, and the thread it runs in.
    const command: Record<string, unknown> = {
      protocolVersion: 1,
      commandId: claim.commandId,
      taskId: task.id,
      route: claim.route,
      sources: claim.route !== 'sample' && task.sourceDocument ? [task.sourceDocument] : [],
      consent: claim.route !== 'sample',
      ...(thread ? { threadId: thread.id } : {}),
    };
    let session: unknown;
    try {
      session = await this.deps.admit(projectId, command);
    } catch (error) {
      return settle({
        reason: error instanceof Error ? error.message : 'The work could not be started.',
      });
    }
    const sessionId = (session as { id?: unknown } | null)?.id;
    if (typeof sessionId === 'string') return settle({ sessionId });
    return settle({ reason: 'The Work start path answered without a session.' });
  }

  /** Turns automatic start or this project's pause on or off. Called with the store lock held. */
  async configure(projectId: string, request: unknown): Promise<ReadyQueueView> {
    const parsed = settingsSchema.safeParse(request);
    if (!parsed.success || (parsed.data.autoStart === undefined && parsed.data.paused === undefined))
      throw new ApiError(400, 'Say whether to start Ready work automatically, or to pause the queue.', {
        code: 'invalid_ready_queue',
      });
    if (this.store.isHomeProject(projectId)) throw new ApiError(409, HOME_REFUSES_WORK);
    {
      const state = this.store.state(projectId);
      const queue = this.record(state);
      const at = now();
      const { autoStart, paused, reason } = parsed.data;
      let changed = false;
      if (autoStart !== undefined && autoStart !== queue.autoStart) {
        queue.autoStart = autoStart;
        queue.autoStartChangedAt = at;
        this.store.addEntry(state, {
          kind: 'ready-queue',
          sentence: autoStart
            ? 'You turned on starting Ready work automatically.'
            : 'You turned off starting Ready work automatically.',
          actor: 'you',
        });
        changed = true;
      }
      if (paused === true && !queue.paused) {
        queue.paused = pauseOf(reason, at);
        this.store.addEntry(state, {
          kind: 'ready-queue',
          sentence: `You paused the Ready queue: ${queue.paused.reason}.`,
          actor: 'you',
        });
        changed = true;
      } else if (paused === false && queue.paused) {
        queue.paused = null;
        this.store.addEntry(state, {
          kind: 'ready-queue',
          sentence: 'You resumed the Ready queue.',
          actor: 'you',
        });
        changed = true;
      }
      if (changed) await this.store.persist(state);
    }
    return this.view(projectId);
  }

  /**
   * Pauses or resumes every project's queue at once. Running work is left alone. Called with the
   * store lock held, so it is ordered against a pass.
   */
  async configureAll(request: unknown): Promise<{ allPaused: QueuePause | null }> {
    const parsed = globalSchema.safeParse(request);
    if (!parsed.success)
      throw new ApiError(400, 'Say whether to pause every Ready queue.', {
        code: 'invalid_ready_queue',
      });
    const next = parsed.data.paused ? (this.allPaused ?? pauseOf(parsed.data.reason, now())) : null;
    await jsonWrite(this.globalPath, { version: 1, paused: next });
    this.allPaused = next;
    this.kick();
    return { allPaused: this.allPaused };
  }

  get globalPause() {
    return this.allPaused;
  }
}
