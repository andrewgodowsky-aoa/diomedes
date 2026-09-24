/**
 * Durable controls (H08): Steer, Queue, Stop, Resume, Retry and Fork as six
 * distinct commands with one contract (`shared/work-control.ts`, revision
 * 2026-09-24.1), each with a command identity and a receipt.
 *
 * What this adds is the identity, the availability check and the receipt. It is
 * not a second runtime and it grants nothing:
 *
 * - Queue and Stop are the existing follow-up queue and stop scopes
 *   (`server/work-control.ts`), called exactly as their own routes call them.
 * - Resume and Retry start work only through `admit`, the Work start route's own
 *   admission path, with a Work command identity derived from the control's, so
 *   a restart part-way through replays the same start instead of making a second.
 * - Steer, and any native Resume, Retry or Fork, reach a route only through a
 *   driver the host wired for that route's contract. A contract that declares a
 *   command nobody wired is refused with that said, never approximated.
 * - Fork makes a new task and thread that refer to the origin run. The origin's
 *   task, runs, turns and History are not touched.
 *
 * Every well-formed control aimed at a task that exists leaves a receipt, a
 * refusal included, because what was asked for and not done is part of the
 * account of the task (decision 10). The asker is always the local person; who
 * performed it is Diomedes for a host composition and the route's engine for a
 * native one (decision 8).
 */
import type { AdapterRouteContract } from '../shared/adapter-contract.js';
import { ROUTES } from '../shared/engines.js';
import { workControlProfile, controlNotApplicable } from '../shared/session-controls.js';
import type { Conversation, Route, Session, Task, ThreadPermission } from '../shared/types.js';
import {
  CONTROL_FAMILY,
  MAX_CONTROL_RECEIPTS,
  WORK_CONTROL_CONTRACT_VERSION,
  WORK_CONTROL_REVISION,
  controlPayload,
  controlRequestSchema,
  derivedWorkCommandId,
  followUpWaitLabel,
  type ControlLineage,
  type ControlOutcome,
  type ControlPerformer,
  type ControlReceipt,
  type ControlRefusalCode,
  type ControlRequest,
  type ControlSupport,
  type RouteControlProfile,
  type WorkInputs,
} from '../shared/work-control.js';
import { findCommand, payloadDigest } from './command-admission.js';
import { ROUTE_CONTRACTS } from './harness/route-contract.js';
import { CODEX_ENGINE, FIXTURE_ENGINE } from './harness/approval.js';
import { NATIVE_LOOP_ENGINE } from '../shared/native-loop.js';
import { AWS_MODEL_CONTRACT } from './harness/aws-model-adapter.js';
import { AZURE_MODEL_CONTRACT } from './harness/azure-model-adapter.js';
import { OPENROUTER_MODEL_CONTRACT } from './harness/openrouter-model-adapter.js';
import { VERTEX_MODEL_CONTRACT } from './harness/vertex-model-adapter.js';
import { ApiError } from './paths.js';
import { hash, identifier, now, type Store } from './store.js';
import { UNCERTAIN_AFTER_STOP, type WorkControl } from './work-control.js';

const LIVE = ['queued', 'working', 'waiting'];
const isLive = (session: Session) => LIVE.includes(session.state);

/** The model-API routes' contracts, which live with their adapters rather than in ROUTE_CONTRACTS. */
const MODEL_API_CONTRACTS: Record<string, AdapterRouteContract> = Object.fromEntries(
  [AWS_MODEL_CONTRACT, AZURE_MODEL_CONTRACT, OPENROUTER_MODEL_CONTRACT, VERTEX_MODEL_CONTRACT].map(
    (contract) => [contract.routeId, contract],
  ),
);

/** The Work route a run was admitted on, the way the Work receipt check reads it. */
export function workRouteOf(session: Session): string {
  if (session.route) return session.route;
  if (session.sample) return 'sample';
  if (session.engine.name === FIXTURE_ENGINE || session.engine.name === NATIVE_LOOP_ENGINE) return 'native-fixture';
  if (session.engine.name === CODEX_ENGINE) return 'codex-report';
  return 'codex';
}

/** The adapter contract a Work route answers by, or null when none is registered. */
export function defaultWorkContract(workRoute: string): AdapterRouteContract | null {
  return ROUTE_CONTRACTS[workRoute] ?? MODEL_API_CONTRACTS[workRoute] ?? null;
}

// --- the driver seam other routes plug into ----------------------------------------

/** What a native steer reported. `delivered` means the running turn received it. */
export interface SteerAnswer {
  state: 'delivered' | 'rejected' | 'uncertain';
  detail: string;
  /** Who did it, when the driver knows better than the profile (e.g. the engine's reported model). */
  performedBy?: ControlPerformer;
}
/** What a resume, retry or native fork started. */
export interface StartAnswer {
  sessionId?: string;
  taskId?: string;
  threadId?: string;
  detail?: string;
  /**
   * Who actually did it, when that differs from what the route's profile
   * promised: a native resume the engine could not honour was a fresh start
   * Diomedes composed, and the receipt says so (decision 8).
   */
  performedBy?: ControlPerformer;
  support?: ControlSupport;
  /** The engine's own thread the resume continued or the fork made. */
  nativeThreadId?: string;
  /** The route declined; nothing was started or made. */
  refused?: { code: ControlRefusalCode; reason: string };
}
export interface ContinueContext {
  projectId: string;
  task: Task;
  session: Session;
  inputs: WorkInputs;
  /** The Work command identity the control derived; replaying it replays the start. */
  workCommandId: string;
  /**
   * Starts the run through ordinary Work admission with the recorded inputs and
   * `workCommandId`. A driver that continues a native session still admits here,
   * so the new run has a Work receipt and passes every check a person's Start does.
   */
  start(): Promise<Session>;
}

/**
 * A route's Work-level control mechanism, registered under its contract's route
 * id. Each method present is what makes a `native` declaration offerable; a
 * method absent leaves the control refused with that said. H03 (Claude Code) and
 * H05 (Cursor ACP) plug their live steer and session resume in here.
 */
export interface WorkControlDriver {
  steer?(ctx: {
    projectId: string;
    task: Task;
    session: Session;
    text: string;
    commandId: string;
  }): Promise<SteerAnswer>;
  resume?(ctx: ContinueContext): Promise<StartAnswer>;
  retry?(ctx: ContinueContext): Promise<StartAnswer>;
  fork?(ctx: ContinueContext): Promise<StartAnswer>;
  /** Effects the route knows may have happened for this run and are not confirmed. */
  uncertainEffects?(projectId: string, session: Session): readonly string[];
}

export interface DurableControlsDeps {
  store: Store;
  workControl: WorkControl;
  /** The Work start route's own admission path. Resume and Retry start work only here. */
  admit(projectId: string, command: Record<string, unknown>): Promise<unknown>;
  /** Which contract answers for a run. Defaults to the registered contract for its route. */
  contractFor?(
    projectId: string,
    workRoute: string,
    session: Session | null,
  ): AdapterRouteContract | null;
  /** The model this thread and route would resolve to now. */
  modelFor?(projectId: string, threadId: string | null, route: Route): string | null;
  routeAvailable?(route: string): boolean;
  /**
   * H12: recorded tool effects of this run's harness run whose outcome is uncertain
   * (a crash, takeover or cancel between the effect's intent and its outcome).
   */
  harnessEffects?(projectId: string, session: Session): Promise<readonly string[]>;
}

interface Draft {
  outcome: ControlOutcome;
  detail: string;
  refusal?: { code: ControlRefusalCode; reason: string };
  performedBy?: ControlPerformer | null;
  result?: ControlReceipt['result'];
  lineage?: ControlLineage | null;
  uncertainEffects?: readonly string[];
  revalidated?: readonly string[];
  support?: ControlSupport | null;
  /** A History sentence for work a control started or made. */
  history?: { sentence: string; sessionId?: string; taskId: string };
}

const refused = (code: ControlRefusalCode, reason: string, extra: Partial<Draft> = {}): Draft => ({
  outcome: 'refused',
  detail: reason,
  refusal: { code, reason },
  ...extra,
});

const WIDER: Record<ThreadPermission, number> = { 'show-first': 0, task: 1 };

export class DurableControls {
  private readonly drivers = new Map<string, WorkControlDriver>();
  constructor(private readonly deps: DurableControlsDeps) {}
  private get store() {
    return this.deps.store;
  }

  /** Wire a route's Work-level mechanism, keyed by its contract's route id. */
  registerDriver(contractRouteId: string, driver: WorkControlDriver) {
    this.drivers.set(contractRouteId, driver);
  }

  private contract(projectId: string, workRoute: string, session: Session | null) {
    return this.deps.contractFor
      ? this.deps.contractFor(projectId, workRoute, session)
      : defaultWorkContract(workRoute);
  }

  /** What one run's route offers, as the Console reads it and as `perform` enforces it. */
  profile(projectId: string, workRoute: string, session: Session | null): RouteControlProfile {
    const contract = this.contract(projectId, workRoute, session);
    const driver = contract ? this.drivers.get(contract.routeId) : undefined;
    return workControlProfile(contract, workRoute, {
      steer: Boolean(driver?.steer),
      resume: Boolean(driver?.resume),
      retry: Boolean(driver?.retry),
      fork: Boolean(driver?.fork),
    });
  }

  /** Each of a task's runs with the controls its route offers. */
  profiles(projectId: string, taskId: string): Record<string, RouteControlProfile> {
    const state = this.store.state(projectId);
    return Object.fromEntries(
      state.sessions
        .filter((session) => session.taskId === taskId)
        .map((session) => [session.id, this.profile(projectId, workRouteOf(session), session)]),
    );
  }

  list(projectId: string): ControlReceipt[] {
    return structuredClone(this.store.state(projectId).controlReceipts ?? []);
  }

  receipt(projectId: string, commandId: string): ControlReceipt {
    const found = (this.store.state(projectId).controlReceipts ?? []).find(
      (item) => item.commandId === commandId,
    );
    if (!found)
      throw new ApiError(404, 'This control command was not found.', {
        code: 'control_command_not_found',
      });
    return structuredClone(found);
  }

  /**
   * Perform one control. Called with the store lock held, as every route is.
   * A replay of a command already answered returns its receipt unchanged and
   * performs nothing; the same identity with another payload is refused.
   */
  async perform(projectId: string, body: unknown): Promise<ControlReceipt> {
    const parsed = controlRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'Provide a valid version 1 control: its command id, its task, and what to do.',
        { code: 'invalid_control' },
      );
    const request = parsed.data;
    const digest = payloadDigest(controlPayload(request));
    const state = this.store.state(projectId);
    const previous = findCommand(state, request.commandId);
    if (previous) {
      if (previous.type !== 'control' || previous.digest !== digest)
        throw new ApiError(409, 'This command already names a different request.', {
          code: 'control_command_conflict',
        });
      return structuredClone(previous.subject);
    }
    if ((state.followUps ?? []).some((item) => item.commandId === request.commandId))
      throw new ApiError(409, 'This command already names a different request.', {
        code: 'control_command_conflict',
      });
    if ((state.controlReceipts ?? []).length >= MAX_CONTROL_RECEIPTS)
      throw new ApiError(409, 'This project has reached its saved control limit.', {
        code: 'control_receipt_capacity',
        limit: MAX_CONTROL_RECEIPTS,
      });
    const task = state.tasks.find((item) => item.id === request.taskId && !item.deletedAt);
    if (!task) throw new ApiError(404, 'This task was not found.');
    const sessionId = 'sessionId' in request ? request.sessionId : null;
    const session = sessionId
      ? state.sessions.find((item) => item.id === sessionId && item.taskId === task.id)
      : undefined;
    if (sessionId && !session) throw new ApiError(404, 'This run was not found for this task.');
    const requestedAt = now();
    const draft = await this.dispatch(projectId, request, task, session ?? null);

    const fresh = this.store.state(projectId);
    const workRoute = session
      ? workRouteOf(session)
      : request.control === 'queue'
        ? request.route
        : null;
    const profile = workRoute ? this.profile(projectId, workRoute, session ?? null) : null;
    const threadId =
      session?.threadId ??
      fresh.conversations.find((conversation) => conversation.taskId === task.id)?.id ??
      null;
    const receipt: ControlReceipt = {
      contractVersion: WORK_CONTROL_CONTRACT_VERSION,
      contractRevision: WORK_CONTROL_REVISION,
      id: identifier('CR'),
      commandId: request.commandId,
      family: CONTROL_FAMILY[request.control],
      payloadDigest: digest,
      control: request.control,
      requestedBy: { actor: 'you', via: 'local-client' },
      requestedAt,
      target: {
        taskId: task.id,
        sessionId: session?.id ?? draft.result?.stop?.sessionId ?? null,
        threadId,
      },
      route: {
        workRoute,
        contractRouteId: profile?.contractRouteId ?? null,
        support:
          draft.support !== undefined
            ? draft.support
            : (profile?.controls[request.control].support ?? null),
      },
      outcome: draft.outcome,
      detail: draft.detail,
      refusal: draft.refusal ?? null,
      performedBy: draft.outcome === 'refused' ? null : (draft.performedBy ?? { kind: 'diomedes' }),
      result: draft.result ?? {},
      lineage: draft.lineage ?? null,
      uncertainEffects: [...(draft.uncertainEffects ?? [])],
      revalidated: [...(draft.revalidated ?? [])],
      settledAt: now(),
    };
    fresh.controlReceipts ??= [];
    fresh.controlReceipts.push(receipt);
    if (draft.history)
      this.store.addEntry(fresh, {
        kind: 'control',
        sentence: draft.history.sentence,
        actor: 'you',
        taskId: draft.history.taskId,
        ...(draft.history.sessionId ? { sessionId: draft.history.sessionId } : {}),
      });
    await this.store.persist(fresh);
    return structuredClone(receipt);
  }

  private async dispatch(
    projectId: string,
    request: ControlRequest,
    task: Task,
    session: Session | null,
  ): Promise<Draft> {
    switch (request.control) {
      case 'queue':
        return this.queue(projectId, request, task);
      case 'stop':
        return this.stop(projectId, request, task, session);
    }
    // Every other control names a run; the schema requires it.
    const run = session!;
    const workRoute = workRouteOf(run);
    const profile = this.profile(projectId, workRoute, run);
    const offered = profile.controls[request.control];
    if (offered.support === null)
      return refused(
        'unsupported',
        request.control === 'steer'
          ? `${offered.note} Queue the message to send it after this turn.`
          : offered.note,
      );
    const notApplicable = controlNotApplicable(request.control, run.state);
    if (notApplicable) return refused('not-applicable', notApplicable);
    const driver = profile.contractRouteId ? this.drivers.get(profile.contractRouteId) : undefined;
    const performer: ControlPerformer =
      offered.support === 'native' && profile.engine
        ? { kind: 'engine', engine: profile.engine.id, version: profile.engine.version }
        : { kind: 'diomedes' };
    switch (request.control) {
      case 'steer':
        return this.steer(projectId, request, task, run, driver!, performer);
      case 'resume':
      case 'retry':
        return this.continueRun(projectId, request, task, run, offered.support, driver, performer);
      case 'fork':
        return this.fork(projectId, request, task, run, offered.support, driver, performer);
    }
  }

  private async steer(
    projectId: string,
    request: Extract<ControlRequest, { control: 'steer' }>,
    task: Task,
    session: Session,
    driver: WorkControlDriver,
    performer: ControlPerformer,
  ): Promise<Draft> {
    let answer: SteerAnswer;
    try {
      answer = await driver.steer!({
        projectId,
        task,
        session,
        text: request.text,
        commandId: request.commandId,
      });
    } catch (error) {
      // Sent and not answered: whether the running turn saw it is not known.
      return {
        outcome: 'uncertain',
        detail: `The route did not confirm the steer: ${error instanceof Error ? error.message : String(error)}`,
        performedBy: performer,
      };
    }
    if (answer.state === 'rejected')
      return refused('route-refused', answer.detail || 'The route did not accept the steer.');
    return {
      outcome: answer.state === 'delivered' ? 'applied' : 'uncertain',
      detail: answer.detail,
      performedBy: answer.performedBy ?? performer,
      history: {
        sentence: `You steered ${task.name} while it ran.`,
        sessionId: session.id,
        taskId: task.id,
      },
    };
  }

  private async queue(
    projectId: string,
    request: Extract<ControlRequest, { control: 'queue' }>,
    task: Task,
  ): Promise<Draft> {
    try {
      const followUp = await this.deps.workControl.queue(projectId, {
        protocolVersion: 1,
        commandId: derivedWorkCommandId(request.commandId),
        taskId: task.id,
        text: request.text,
        waitsFor: request.waitsFor,
        route: request.route,
        model: request.model,
        agentId: request.agentId,
        sources: [...request.sources],
      });
      return {
        outcome: 'queued',
        detail: `Queued to send ${followUpWaitLabel(followUp.waitsFor)}.`,
        support: 'host',
        result: { followUpId: followUp.id },
      };
    } catch (error) {
      if (error instanceof ApiError && error.status !== 500)
        return refused('admission-refused', error.message);
      throw error;
    }
  }

  private async stop(
    projectId: string,
    request: Extract<ControlRequest, { control: 'stop' }>,
    task: Task,
    session: Session | null,
  ): Promise<Draft> {
    const state = this.store.state(projectId);
    const target =
      session ??
      [...state.sessions].reverse().find((item) => item.taskId === task.id && isLive(item)) ??
      null;
    if (request.scope === 'generation' && target) {
      const profile = this.profile(projectId, workRouteOf(target), target);
      if (!profile.stopScopes.includes('generation')) {
        const contract = this.contract(projectId, workRouteOf(target), target);
        return refused(
          'unsupported',
          contract
            ? `This route cannot stop only the request in flight: ${contract.commands.interrupt.note}`
            : 'This route cannot stop only the request in flight.',
        );
      }
    }
    const stop = await this.deps.workControl.stop(projectId, {
      scope: request.scope,
      taskId: task.id,
      sessionId: request.sessionId,
    });
    const cancelled = stop.cancelledFollowUpIds.length;
    const cancelledSentence = cancelled
      ? ` ${cancelled} queued ${cancelled === 1 ? 'follow-up was' : 'follow-ups were'} cancelled.`
      : '';
    const outcome: ControlOutcome = stop.acknowledged
      ? 'applied'
      : stop.uncertainEffects.length
        ? 'uncertain'
        : cancelled
          ? 'applied'
          : 'refused';
    const profile = target ? this.profile(projectId, workRouteOf(target), target) : null;
    const performer: ControlPerformer =
      request.scope === 'generation' && profile?.engine
        ? { kind: 'engine', engine: profile.engine.id, version: profile.engine.version }
        : { kind: 'diomedes' };
    if (outcome === 'refused')
      return refused('nothing-to-stop', 'Nothing was running or queued to stop.', {
        result: { stop },
        support: 'host',
      });
    return {
      outcome,
      detail: stop.acknowledged
        ? `Stopped ${request.scope === 'generation' ? 'the request' : request.scope === 'task' ? 'the task' : 'the queued follow-ups'}.${cancelledSentence}`
        : `The stop was sent and not confirmed.${cancelledSentence}`,
      performedBy: performer,
      support: request.scope === 'generation' ? (profile?.engine ? 'native' : 'host') : 'host',
      result: { stop },
      uncertainEffects: stop.uncertainEffects,
    };
  }

  /**
   * Effects that may have happened for this run and are not confirmed: an
   * approved write whose outcome was never recorded or that met outside edits,
   * an unconfirmed effect a Stop recorded, and whatever the route's driver knows.
   * Provider work that may still be charged is not one of them: it changes
   * nothing in the world a retry would change again.
   */
  async uncertainEffects(projectId: string, session: Session): Promise<string[]> {
    const state = this.store.state(projectId);
    const effects: string[] = [];
    for (const need of state.needs.filter((item) => item.sessionId === session.id)) {
      if (need.execution?.state === 'pending')
        effects.push(
          `The approved change “${need.what}” was being written and its outcome is not recorded.`,
        );
      if (need.execution?.state === 'conflicted')
        effects.push(
          `Some of the approved change “${need.what}” may have been written while outside edits were kept.`,
        );
    }
    const task = state.tasks.find((item) => item.id === session.taskId);
    for (const receipt of task?.stopReceipts ?? [])
      if (receipt.sessionId === session.id)
        for (const effect of receipt.uncertainEffects)
          if (effect !== UNCERTAIN_AFTER_STOP && !effects.includes(effect)) effects.push(effect);
    const contract = this.contract(projectId, workRouteOf(session), session);
    const driver = contract ? this.drivers.get(contract.routeId) : undefined;
    for (const effect of driver?.uncertainEffects?.(projectId, session) ?? [])
      if (!effects.includes(effect)) effects.push(effect);
    for (const effect of (await this.deps.harnessEffects?.(projectId, session)) ?? [])
      if (!effects.includes(effect)) effects.push(effect);
    return effects;
  }

  /** The attempt a run is: 1 for an original, n + 1 for a retry of attempt n. */
  private attemptOf(projectId: string, sessionId: string): number {
    const receipt = (this.store.state(projectId).controlReceipts ?? []).find(
      (item) =>
        item.control === 'retry' && item.result.sessionId === sessionId && item.lineage?.attempt,
    );
    return receipt?.lineage?.attempt ?? 1;
  }

  private consented(projectId: string, taskId: string, route: string) {
    return this.store
      .state(projectId)
      .sessions.some((item) => item.taskId === taskId && item.receipt?.route === route);
  }

  /** The run's thread: the one it recorded, else its task's thread (a sample run records none). */
  private thread(projectId: string, session: Session): Conversation | undefined {
    const state = this.store.state(projectId);
    return session.threadId
      ? state.conversations.find((item) => item.id === session.threadId)
      : state.conversations.find((item) => item.taskId === session.taskId);
  }

  /**
   * The checks a Resume or Retry re-runs before it asks for anything. They
   * return a refusal or the plain list of what was checked. None of them grants:
   * a run is never resumed with more authority than it had when it stopped.
   */
  private async revalidate(
    projectId: string,
    control: 'resume' | 'retry',
    task: Task,
    session: Session,
    inputs: WorkInputs,
  ): Promise<Draft | string[]> {
    const checked: string[] = [];
    const workRoute = workRouteOf(session);
    const available = this.deps.routeAvailable
      ? this.deps.routeAvailable(workRoute)
      : (ROUTES as readonly string[]).includes(workRoute);
    if (!available)
      return refused('admission-refused', `The ${workRoute} route is no longer available.`);
    checked.push(`Route: ${workRoute} is still available.`);
    if (workRoute !== 'sample' && !this.consented(projectId, task.id, workRoute))
      return refused(
        'consent-required',
        'This route needs your confirmation before sending; start the task yourself instead.',
      );
    if (workRoute !== 'sample') checked.push('Sending: you confirmed this route for this task.');
    // Permission: the thread's current setting may be the same or narrower, never wider.
    const recorded: ThreadPermission = session.permission ?? 'show-first';
    const thread = this.thread(projectId, session);
    const current: ThreadPermission = thread?.permission ?? recorded;
    if (control === 'resume' && WIDER[current] > WIDER[recorded])
      return refused(
        'permission-widened',
        'This thread now lets work go ahead for the whole task, which the stopped run did not have. Start new work so the wider permission is chosen in the open.',
      );
    checked.push(
      current === 'task'
        ? 'Permission: the first OK covers the rest of the task, as it did before.'
        : 'Permission: every change waits for your OK.',
    );
    const recordedModel = session.origin?.model.requested ?? null;
    if (recordedModel !== null && this.deps.modelFor) {
      let model: string | null;
      try {
        model = this.deps.modelFor(
          projectId,
          this.thread(projectId, session)?.id ?? null,
          workRoute as Route,
        );
      } catch (error) {
        return refused(
          'model-changed',
          error instanceof Error
            ? error.message
            : 'The model for this thread could not be resolved.',
        );
      }
      if (model !== recordedModel)
        return refused(
          'model-changed',
          `This run used ${recordedModel}, which is not what this thread would use now, so it was not ${control === 'resume' ? 'resumed' : 'retried'}.`,
        );
      checked.push(`Model: ${recordedModel}, as before.`);
    }
    // Inputs: the same documents, and for a resume the same versions of them.
    const snapshot = this.store
      .state(projectId)
      .history.find((entry) => entry.sessionId === session.id && entry.kind === 'saved-version');
    const changed: string[] = [];
    for (const source of inputs.sources) {
      const text = await this.store.current(projectId, source);
      if (text === null)
        return refused(
          'inputs-changed',
          `${source} is no longer in the project, so this run cannot ask for the same thing.`,
        );
      const before = snapshot?.files.find((file) => file.path === source)?.before ?? null;
      if (before !== null && hash(text) !== before) changed.push(source);
    }
    if (changed.length && control === 'resume')
      return refused(
        'inputs-changed',
        `${changed.join(', ')} changed since this run stopped. Retry to run again on the current ${changed.length === 1 ? 'version' : 'versions'}.`,
      );
    if (inputs.sources.length)
      checked.push(
        changed.length
          ? `Sources: ${changed.join(', ')} changed since the original run; this attempt reads the current version.`
          : `Sources: ${inputs.sources.length === 1 ? 'the document is' : 'the documents are'} unchanged.`,
      );
    return checked;
  }

  private async continueRun(
    projectId: string,
    request: Extract<ControlRequest, { control: 'resume' | 'retry' }>,
    task: Task,
    session: Session,
    support: ControlSupport,
    driver: WorkControlDriver | undefined,
    performer: ControlPerformer,
  ): Promise<Draft> {
    const control = request.control;
    const workCommandId = derivedWorkCommandId(request.commandId);
    const lineage: ControlLineage = {
      kind: control,
      originTaskId: task.id,
      originSessionId: session.id,
      ...(control === 'retry' ? { attempt: this.attemptOf(projectId, session.id) + 1 } : {}),
    };
    const verb = control === 'resume' ? 'Resumed' : 'Retried';
    const started = (
      sessionId: string | undefined,
      detail?: string,
      revalidated: string[] = [],
      answer: StartAnswer = {},
    ) =>
      ({
        outcome: 'applied',
        detail:
          detail ??
          (control === 'resume'
            ? `Resumed as a new run${sessionId ? ` (${sessionId})` : ''} that continues ${session.id}.`
            : `Retried as attempt ${lineage.attempt}${sessionId ? ` (${sessionId})` : ''}, with the same inputs as ${session.id}.`),
        performedBy: answer.performedBy ?? performer,
        ...(answer.support ? { support: answer.support } : {}),
        result: {
          ...(sessionId ? { sessionId } : {}),
          ...(answer.nativeThreadId ? { nativeThreadId: answer.nativeThreadId } : {}),
        },
        lineage,
        revalidated,
        history: {
          sentence:
            control === 'resume'
              ? `You resumed ${task.name}.`
              : `You retried ${task.name} (attempt ${lineage.attempt}).`,
          ...(sessionId ? { sessionId } : {}),
          taskId: task.id,
        },
      }) satisfies Draft;
    // A restart between the start and this receipt: the start already happened
    // under the derived identity, so the receipt is written and nothing is sent.
    const already = this.store
      .state(projectId)
      .sessions.find((item) => item.receipt?.commandId === workCommandId);
    if (already) return started(already.id, `${verb}; the run it started was already recorded.`);
    const inputs = session.inputs;
    if (!inputs)
      return refused(
        'inputs-unrecorded',
        `This run was recorded before its inputs were kept, so it cannot be ${control === 'resume' ? 'resumed' : 'retried'} with the same ones. Start the task again instead.`,
      );
    const effects = await this.uncertainEffects(projectId, session);
    if (effects.length)
      return refused(
        'uncertain-effects',
        `${control === 'resume' ? 'Resume' : 'Retry'} is blocked: something this run did may already have happened. Check History, then start new work if it is still needed.`,
        { uncertainEffects: effects },
      );
    const checks = await this.revalidate(projectId, control, task, session, inputs);
    if (!Array.isArray(checks)) return checks;
    const context: ContinueContext = {
      projectId,
      task,
      session,
      inputs,
      workCommandId,
      start: async () => {
        const result = await this.deps.admit(projectId, {
          protocolVersion: 1,
          commandId: workCommandId,
          taskId: task.id,
          route: workRouteOf(session),
          ...(inputs.instruction ? { instruction: inputs.instruction } : {}),
          sources: [...inputs.sources],
          consent: true,
          threadId: this.thread(projectId, session)?.id ?? null,
          ...(inputs.agentId ? { agentId: inputs.agentId } : {}),
        });
        return result as Session;
      },
    };
    let answer: StartAnswer;
    try {
      if (support === 'native' || control === 'resume') {
        const native = control === 'resume' ? driver?.resume : driver?.retry;
        if (!native)
          return refused('unsupported', `This route has no ${control} wired to Work runs.`);
        answer = await native(context);
      } else {
        const next = await context.start();
        answer = { sessionId: next.id };
      }
    } catch (error) {
      // Ordinary admission refused, verbatim: a service turned off, work already
      // in progress, a sharing record that no longer covers a document.
      if (error instanceof ApiError && error.status < 500)
        return refused('admission-refused', error.message, { revalidated: checks });
      throw error;
    }
    if (answer.refused)
      return refused(answer.refused.code, answer.refused.reason, { revalidated: checks });
    return started(answer.sessionId, answer.detail, checks, answer);
  }

  private async fork(
    projectId: string,
    request: Extract<ControlRequest, { control: 'fork' }>,
    task: Task,
    session: Session,
    support: ControlSupport,
    driver: WorkControlDriver | undefined,
    performer: ControlPerformer,
  ): Promise<Draft> {
    const lineage: ControlLineage = {
      kind: 'fork',
      originTaskId: task.id,
      originSessionId: session.id,
    };
    if (support === 'native') {
      if (!driver?.fork || !session.inputs)
        return refused('unsupported', 'This route has no fork wired to Work runs.');
      let answer: StartAnswer;
      try {
        answer = await driver.fork({
          projectId,
          task,
          session,
          inputs: session.inputs,
          workCommandId: derivedWorkCommandId(request.commandId),
          start: () => Promise.reject(new ApiError(409, 'A native fork starts its own run.')),
        });
      } catch (error) {
        if (error instanceof ApiError && error.status < 500)
          return refused('route-refused', error.message);
        throw error;
      }
      if (answer.refused) return refused(answer.refused.code, answer.refused.reason);
      if (!answer.taskId && answer.nativeThreadId) {
        // The engine branched its own thread; the new task and thread that carry
        // the branch are made here, exactly as a host fork makes them.
        const made = this.forkTask(projectId, task, session);
        return {
          ...made,
          detail: `${answer.detail ?? `Forked from ${session.id}.`} ${made.detail}`,
          performedBy: answer.performedBy ?? performer,
          result: { ...made.result, nativeThreadId: answer.nativeThreadId },
          lineage,
        };
      }
      return {
        outcome: 'applied',
        detail: answer.detail ?? `Forked from ${session.id}.`,
        performedBy: answer.performedBy ?? performer,
        result: {
          ...(answer.sessionId ? { sessionId: answer.sessionId } : {}),
          ...(answer.taskId ? { taskId: answer.taskId } : {}),
          ...(answer.threadId ? { threadId: answer.threadId } : {}),
          ...(answer.nativeThreadId ? { nativeThreadId: answer.nativeThreadId } : {}),
        },
        lineage,
      };
    }
    return { ...this.forkTask(projectId, task, session), performedBy: performer, lineage };
  }

  /**
   * A new task and thread that refer to the origin run. The origin's records are
   * read, never written; nothing is copied from its history, and no run starts
   * until the person starts one.
   */
  private forkTask(
    projectId: string,
    task: Task,
    session: Session,
  ): Draft & { result: { taskId: string; threadId: string } } {
    const state = this.store.state(projectId);
    const origin =
      this.thread(projectId, session) ??
      state.conversations.find((conversation) => conversation.taskId === task.id);
    const forked = this.store.createTask(state, {
      name: `Fork of ${task.name}`.slice(0, 200),
      description: session.inputs?.instruction ?? task.description,
      ...(session.inputs?.sources[0] ? { sourceDocument: session.inputs.sources[0] } : {}),
    });
    const stamped = now();
    const thread: Conversation = {
      id: identifier('C'),
      attachedTo: { kind: 'task', ref: forked.id },
      turns: [],
      name: `Thread for ${forked.name}`.slice(0, 120),
      createdAt: stamped,
      updatedAt: stamped,
      taskId: forked.id,
      helper: null,
      // Authority is never carried into a new lineage: the fork starts at the
      // narrowest permission, and the person widens it there if they want to.
      permission: 'show-first',
      mode: origin?.mode ?? 'build',
      ...(origin?.engine
        ? { engine: origin.engine }
        : session.route
          ? { engine: session.route }
          : {}),
      ...(origin?.requested ? { requested: structuredClone(origin.requested) } : {}),
    };
    state.conversations.push(thread);
    return {
      outcome: 'applied',
      detail: `Forked into ${forked.name}, from ${session.id}. Nothing runs until you start it.`,
      result: { taskId: forked.id, threadId: thread.id },
      history: {
        sentence: `You forked ${task.name} into ${forked.name}.`,
        taskId: forked.id,
      },
    };
  }
}
