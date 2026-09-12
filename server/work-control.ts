/**
 * Work control: the server half of `shared/work-control.ts`.
 *
 * Two things live here and nothing else. Three Stops that mean what they say
 * and leave a receipt saying what each one actually did, and a durable
 * follow-up queue whose items are Work commands in their own right.
 *
 * A delivery is not a private back door into the runtime. It calls the Work
 * start route's own admission path with the follow-up's own `commandId`, so the
 * protocol check, the service-enabled check, the consent check, the receipt
 * replay and the scope the task already has are the same ones a person's Start
 * goes through. It mints nothing, widens nothing and substitutes nothing: when
 * the route is gone, the model snapshot no longer matches, the task has no
 * recorded consent for that route or the ordinary start path refuses, the
 * follow-up is marked `rejected` with the reason in plain words and no work
 * begins.
 *
 * `note` is untouched. This is not a steering channel into a running provider
 * turn, and nothing here claims to be one.
 */
import { ApiError } from './paths.js';
import { identifier, now, type Store } from './store.js';
import { ROUTES } from '../shared/engines.js';
import type { Route, Session, Task } from '../shared/types.js';
import {
  MAX_FOLLOW_UPS_PER_TASK,
  WORK_CONTROL_CONTRACT_VERSION,
  editFollowUpSchema,
  followUpWaitLabel,
  nextDeliverable,
  queueFollowUpSchema,
  queuedFollowUps,
  reorderFollowUpsSchema,
  stopSchema,
  type FollowUpCommand,
  type StopReceipt,
  type StopScope,
} from '../shared/work-control.js';
import type { NativeWorkService } from './native-work.js';

/** The one sentence no Stop scope can make untrue. */
export const UNCERTAIN_AFTER_STOP =
  'Provider work already sent can complete and be charged after Stop.';
/** Refused before anything is sent, so the person can start the task themselves. */
export const CONSENT_REQUIRED =
  'This route needs your confirmation before sending; open the task to start it.';

const ACTIVE = ['queued', 'working', 'waiting'];
const isActive = (session: Session) => ACTIVE.includes(session.state);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface DeliveryMoment {
  taskId: string;
  /** The session the task was running has just reached a terminal state. */
  turnEnded: boolean;
  taskDone: boolean;
}

export interface WorkControlDeps {
  store: Store;
  native: NativeWorkService;
  /**
   * The Work start route's own admission path, called with the store lock held.
   * Delivery uses exactly this; it never re-implements a single check.
   */
  admit(projectId: string, command: Record<string, unknown>): Promise<unknown>;
  /**
   * Ends a session the way the existing Stop route does, for every kind of
   * session the host can hold — native, sample or harness.
   */
  stopSession(projectId: string, sessionId: string): Promise<unknown>;
  /** Which routes may still be used. Injected so a withdrawn route is provable. */
  routeAvailable?(route: string): boolean;
  /**
   * The model this thread and route would resolve to now. A follow-up carrying
   * a stale snapshot is refused rather than quietly run on a different model.
   */
  modelFor?(projectId: string, threadId: string | null, route: Route): string | null;
}

export class WorkControl {
  constructor(private deps: WorkControlDeps) {}
  private get store() {
    return this.deps.store;
  }
  private routeAvailable(route: string) {
    return this.deps.routeAvailable
      ? this.deps.routeAvailable(route)
      : (ROUTES as readonly string[]).includes(route);
  }
  private task(projectId: string, taskId: string): Task {
    const task = this.store
      .state(projectId)
      .tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) throw new ApiError(404, 'This task was not found.');
    return task;
  }
  private item(projectId: string, followUpId: string): Mutable<FollowUpCommand> {
    const found = (this.store.state(projectId).followUps ?? []).find(
      (entry) => entry.id === followUpId,
    );
    if (!found) throw new ApiError(404, 'This follow-up was not found.');
    return found as Mutable<FollowUpCommand>;
  }
  /** Queued items alone can be changed. A delivered or cancelled one is evidence. */
  private editable(item: FollowUpCommand): Mutable<FollowUpCommand> {
    if (item.state !== 'queued')
      throw new ApiError(
        400,
        `This follow-up was already ${item.state}, so it can no longer be changed.`,
      );
    return item as Mutable<FollowUpCommand>;
  }

  list(projectId: string): FollowUpCommand[] {
    return [...(this.store.state(projectId).followUps ?? [])];
  }

  /**
   * The client mints the `commandId`, exactly as `client/work-start.ts` does for
   * a Start, so a double click, a lost response or a reconnect names the same
   * command. A second queue with the same identity returns the record already
   * saved; it never writes a second one.
   */
  async queue(
    projectId: string,
    request: unknown,
    by: 'you' = 'you',
  ): Promise<FollowUpCommand> {
    const parsed = queueFollowUpSchema.safeParse(request);
    if (!parsed.success)
      throw new ApiError(
        400,
        'Provide a valid follow-up: its text, when it should run, and the route to run it on.',
        { code: 'invalid_follow_up' },
      );
    const command = parsed.data;
    const state = this.store.state(projectId);
    const existing = (state.followUps ?? []).find((entry) => entry.commandId === command.commandId);
    if (existing) {
      if (existing.taskId !== command.taskId || existing.text !== command.text.trim())
        throw new ApiError(409, 'This command already names a different follow-up.', {
          code: 'follow_up_command_conflict',
        });
      return structuredClone(existing);
    }
    // One project-scoped command namespace. A Work start, an approval decision
    // or a scope grant already holding this identity refuses here, not later.
    if (this.store.workCommand(projectId, command.commandId))
      throw new ApiError(409, 'This command has already started work.', {
        code: 'work_command_conflict',
      });
    const task = this.task(projectId, command.taskId);
    if (!this.routeAvailable(command.route))
      throw new ApiError(400, `${command.route} is not a route this build can use.`);
    const queued = queuedFollowUps(state.followUps, task.id);
    if (queued.length >= MAX_FOLLOW_UPS_PER_TASK)
      throw new ApiError(
        409,
        `This task already has ${MAX_FOLLOW_UPS_PER_TASK} follow-ups queued. Send or remove one first.`,
      );
    const live =
      state.sessions.find((session) => session.taskId === task.id && isActive(session)) ?? null;
    const record: FollowUpCommand = {
      id: identifier('F'),
      commandId: command.commandId,
      taskId: task.id,
      queuedDuringSessionId: live?.id ?? null,
      text: command.text,
      waitsFor: command.waitsFor,
      route: command.route as Route,
      model: command.model,
      agentId: command.agentId,
      sources: [...command.sources],
      order: (queued.at(-1)?.order ?? 0) + 1,
      queuedAt: now(),
      state: 'queued',
    };
    state.followUps ??= [];
    state.followUps.push(record);
    this.store.addEntry(state, {
      kind: 'follow-up',
      sentence: `You queued a follow-up for ${task.name}, ${followUpWaitLabel(record.waitsFor)}.`,
      actor: by,
      taskId: task.id,
    });
    await this.store.persist(state);
    return structuredClone(record);
  }

  async edit(projectId: string, followUpId: string, patch: unknown): Promise<FollowUpCommand> {
    const parsed = editFollowUpSchema.safeParse(patch);
    if (!parsed.success)
      throw new ApiError(400, 'Provide new follow-up text, when it should run, or both.');
    const item = this.editable(this.item(projectId, followUpId));
    if (parsed.data.text !== undefined) item.text = parsed.data.text;
    if (parsed.data.waitsFor !== undefined) item.waitsFor = parsed.data.waitsFor;
    await this.store.persist(this.store.state(projectId));
    return structuredClone(item as FollowUpCommand);
  }

  /**
   * Removing a queued follow-up cancels it. The record stays, because what was
   * asked for and then withdrawn is part of the account of the task.
   */
  async remove(
    projectId: string,
    followUpId: string,
    by: 'you' | `stop:${StopScope}` = 'you',
  ): Promise<FollowUpCommand> {
    const item = this.editable(this.item(projectId, followUpId));
    item.state = 'cancelled';
    item.cancelledAt = now();
    item.cancelledBy = by;
    await this.store.persist(this.store.state(projectId));
    return structuredClone(item as FollowUpCommand);
  }

  async reorder(projectId: string, request: unknown): Promise<FollowUpCommand[]> {
    const parsed = reorderFollowUpsSchema.safeParse(request);
    if (!parsed.success)
      throw new ApiError(400, 'Send the task and the queued follow-up ids in their new order.');
    const state = this.store.state(projectId);
    const queued = queuedFollowUps(state.followUps, parsed.data.taskId);
    const wanted = parsed.data.order;
    const unique = new Set(wanted);
    if (
      unique.size !== wanted.length ||
      wanted.length !== queued.length ||
      queued.some((item) => !unique.has(item.id))
    )
      throw new ApiError(
        400,
        'Send exactly the follow-ups queued for this task, each once, in their new order.',
      );
    wanted.forEach((followUpId, index) => {
      (this.item(projectId, followUpId) as Mutable<FollowUpCommand>).order = index + 1;
    });
    await this.store.persist(state);
    return queuedFollowUps(this.store.state(projectId).followUps, parsed.data.taskId);
  }

  /**
   * Three Stops. `generation` interrupts the request in flight and nothing
   * else. `task` is today's Stop and additionally cancels the task's queue,
   * because delivering one would restart work the person just stopped.
   * `queued` cancels the queue and touches no session at all.
   */
  async stop(projectId: string, request: unknown): Promise<StopReceipt> {
    const parsed = stopSchema.safeParse(request);
    if (!parsed.success) throw new ApiError(400, 'Choose what to stop, and for which task.');
    const { scope, taskId } = parsed.data;
    const task = this.task(projectId, taskId);
    const live = this.deps.native.liveRun(projectId);
    // Said on every receipt for a Stop that reached a dispatched request, and
    // omitted when there was none. No scope can make it untrue.
    const wasLive = live?.taskId === task.id;
    const sessionId =
      parsed.data.sessionId ??
      (wasLive ? live!.sessionId : null) ??
      ([...this.store.state(projectId).sessions]
        .reverse()
        .find((session) => session.taskId === task.id && isActive(session))?.id ??
        null);
    let acknowledged = false;
    const cancelledFollowUpIds: string[] = [];
    if (scope === 'generation') {
      acknowledged = sessionId ? this.deps.native.interrupt(projectId, sessionId) : false;
    } else {
      if (scope === 'task' && sessionId) {
        const session = this.store
          .state(projectId)
          .sessions.find((item) => item.id === sessionId && isActive(item));
        if (session) {
          await this.deps.stopSession(projectId, sessionId);
          acknowledged = true;
        }
      }
      // Cancelling a queue is local state, so it is always certain.
      if (scope === 'queued') acknowledged = true;
      for (const item of queuedFollowUps(this.store.state(projectId).followUps, task.id)) {
        const mutable = item as Mutable<FollowUpCommand>;
        mutable.state = 'cancelled';
        mutable.cancelledAt = now();
        mutable.cancelledBy = `stop:${scope}`;
        cancelledFollowUpIds.push(item.id);
      }
    }
    const receipt: StopReceipt = {
      contractVersion: WORK_CONTROL_CONTRACT_VERSION,
      scope,
      taskId: task.id,
      sessionId,
      at: now(),
      acknowledged,
      uncertainEffects: wasLive ? [UNCERTAIN_AFTER_STOP] : [],
      cancelledFollowUpIds,
    };
    const state = this.store.state(projectId);
    const current = state.tasks.find((item) => item.id === task.id)!;
    current.stopReceipts = [...(current.stopReceipts ?? []), receipt];
    await this.store.persist(state);
    return structuredClone(receipt);
  }

  /**
   * A prior admitted Start on the same route is the consent record: a non-sample
   * start is refused unless the person confirmed sending to that engine, so its
   * receipt is proof that they did. Route-matched on purpose — the confirmation
   * names the engine, so consent for one route is not consent for another.
   */
  private consented(projectId: string, taskId: string, route: Route) {
    return this.store
      .state(projectId)
      .sessions.some((session) => session.taskId === taskId && session.receipt?.route === route);
  }

  private async reject(projectId: string, followUpId: string, reason: string) {
    const item = this.item(projectId, followUpId);
    if (item.state === 'queued') {
      item.state = 'rejected';
      item.rejectedAt = now();
      item.rejectedReason = reason;
    }
    await this.store.persist(this.store.state(projectId));
    return structuredClone(item as FollowUpCommand);
  }

  /**
   * Called with the store lock held when a session for the task reached a
   * terminal state or the task itself became done. Returns the follow-up it
   * settled, or null when nothing was due — which includes the case where work
   * is still in progress, and which leaves the item queued for the next moment.
   */
  async deliverDue(
    projectId: string,
    moment: DeliveryMoment,
  ): Promise<FollowUpCommand | null> {
    const state = this.store.state(projectId);
    const item = nextDeliverable(state.followUps, moment.taskId, moment);
    if (!item) return null;
    // A delivery must never race a session. Any work in progress in this project
    // leaves the item queued; it is not a reason to reject what the person asked
    // for, and the ordinary start path would refuse it anyway.
    if (this.deps.native.running(projectId) || state.sessions.some(isActive)) return null;
    const task = state.tasks.find((entry) => entry.id === item.taskId && !entry.deletedAt);
    if (!task)
      return this.reject(
        projectId,
        item.id,
        'This task is no longer here, so the follow-up was not sent.',
      );
    if (!this.routeAvailable(item.route))
      return this.reject(
        projectId,
        item.id,
        `The ${item.route} route is no longer available, so this follow-up was not sent.`,
      );
    if (item.waitsFor === 'turn' && task.state === 'done')
      return this.reject(
        projectId,
        item.id,
        'This task finished before the follow-up could be sent, so it was not started.',
      );
    if (!this.consented(projectId, item.taskId, item.route))
      return this.reject(projectId, item.id, CONSENT_REQUIRED);
    const threadId =
      state.conversations.find((conversation) => conversation.taskId === item.taskId)?.id ?? null;
    if (item.model !== null && this.deps.modelFor) {
      // Resolving the thread's model can itself refuse (an engine with nothing
      // selected). That refusal is the reason, and it must not escape into the
      // store's recovery path, where the rejection would be rolled back and the
      // same delivery attempted again on the next write.
      let current: string | null;
      try {
        current = this.deps.modelFor(projectId, threadId, item.route);
      } catch (error) {
        return this.reject(
          projectId,
          item.id,
          error instanceof Error
            ? error.message
            : 'This follow-up could not be matched to a model, so it was not sent.',
        );
      }
      if (current !== item.model)
        return this.reject(
          projectId,
          item.id,
          `This follow-up was saved for ${item.model}, which is not what this thread would use now, so it was not sent.`,
        );
    }
    // The follow-up's own identity, so a restart in the middle of delivery
    // replays the same command instead of starting a second run.
    const command: Record<string, unknown> = {
      protocolVersion: 1,
      commandId: item.commandId,
      taskId: item.taskId,
      route: item.route,
      instruction: item.text,
      sources: [...item.sources],
      consent: true,
      threadId,
      ...(item.agentId ? { agentId: item.agentId } : {}),
    };
    let session: unknown;
    try {
      session = await this.deps.admit(projectId, command);
    } catch (error) {
      // A refusal from the ordinary start path is the rejected reason, verbatim.
      // Delivery never grants: an expired scope, a service turned off or a
      // project already busy all arrive here and stop the follow-up visibly.
      return this.reject(
        projectId,
        item.id,
        error instanceof ApiError || error instanceof Error
          ? error.message
          : 'The follow-up could not be started.',
      );
    }
    const sessionId =
      session && typeof (session as { id?: unknown }).id === 'string'
        ? (session as { id: string }).id
        : undefined;
    const fresh = this.store.state(projectId);
    const delivered = (fresh.followUps ?? []).find(
      (entry) => entry.id === item.id,
    ) as Mutable<FollowUpCommand>;
    delivered.state = 'delivered';
    delivered.deliveredAt = now();
    if (sessionId) delivered.deliveredSessionId = sessionId;
    this.store.addEntry(fresh, {
      kind: 'follow-up',
      sentence: `Diomedes sent your queued follow-up for ${task.name}.`,
      actor: 'diomedes',
      taskId: task.id,
      ...(sessionId ? { sessionId } : {}),
    });
    await this.store.persist(fresh);
    return structuredClone(delivered as FollowUpCommand);
  }
}
