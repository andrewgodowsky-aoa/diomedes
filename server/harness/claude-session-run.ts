import { randomUUID } from 'node:crypto';
import type {
  CapabilityManifest,
  HarnessRun,
  Json,
  NativeCheckpoint,
} from '../../shared/harness.js';
import {
  steeringAckSchema,
  type NativeSessionRef,
  type SteeringAck,
} from '../../shared/contract-revision.js';
import type { TextRequest, TextResponse } from '../engines/contract.js';
import {
  claudeCheckpointSchema,
  type ClaudeNativeSession,
  type ClaudeSessionCheckpoint,
  type ClaudeSessionOptions,
} from '../engines/claude-session.js';
import { EngineError } from '../engines/process.js';
import { localHarnessPrincipal } from './bridge.js';
import { digest, HarnessError } from './policy.js';
import { RunService, Suspended, type StepContext, type StepDefinition } from './run-service.js';
import { boundedHistory, carriedRun } from './conversation-history.js';
import { artifactSteps, unrecordedArtifacts } from './artifact-steps.js';
import { repairWriting } from '../plain-writing.js';

/** A first prompt that carries an earlier conversation, laid out as the model-API driver lays out history. */
export const carriedPrompt = (history: string, prompt: string) =>
  `Earlier in this conversation:\n\n${history}\n\n---\n\nThe person's message:\n\n${prompt}`;

export const CLAUDE_SESSION_CAPABILITY: CapabilityManifest = {
  id: 'claude-native-session',
  version: '1',
  label: 'Claude native conversation',
  description: 'An explicitly admitted native Claude conversation with durable turns and no tools.',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 128,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
};
export function validateClaudeNativeCheckpoint(value: NativeCheckpoint): NativeCheckpoint {
  if (value.providerId !== 'claude-code')
    throw new HarnessError('invalid_checkpoint', 'Unknown native checkpoint provider.');
  const parsed = claudeCheckpointSchema.safeParse(value.payload);
  if (!parsed.success)
    throw new HarnessError('invalid_checkpoint', 'Claude recovery metadata is malformed.');
  return { v: 1, providerId: 'claude-code', payload: parsed.data };
}
/**
 * The fields of a provider checkpoint this driver reads. Each transport keeps
 * its own schema (`claudeCheckpointSchema`, `openCodeCheckpointSchema`); the
 * driver never writes into one, it only reads these to decide resume and fork.
 */
export interface SessionCheckpointFacts {
  nativeSessionId: string | null;
  lineageId: string;
  requestedModel: string;
  reportedModel: string | null;
  scopeDigest?: string;
  state: 'idle' | 'busy' | 'uncertain';
}
/**
 * What makes one native conversation driver a Claude one or an OpenCode one.
 * The lifecycle (turn records, replay, fork lineage, recovery) is the same;
 * the engine, its capability, its checkpoint schema and whether it may queue
 * steering are not.
 */
export interface NativeSessionProfile<C extends SessionCheckpointFacts> {
  engine: 'claude-code' | 'opencode' | 'cursor' | 'devin';
  label: string;
  capability: CapabilityManifest;
  /** Validates a saved checkpoint for this engine and returns its payload. Throws `invalid_checkpoint`. */
  parseCheckpoint(value: NativeCheckpoint): C;
  /**
   * `queue`: a message sent while a turn runs is held by Diomedes and sent as the
   * next turn once that one finishes. `none`: steering is refused. Must agree
   * with the route contract's `steer` answer.
   */
  steering: 'queue' | 'none';
  /**
   * What a restart makes of a checkpoint whose turn was running (H05). Without it
   * the run stays parked for reconciliation, as before. With it, the driver
   * reconciles the run from its durable record at startup: `resume` keeps the
   * returned checkpoint for an explicit resume and records the interrupted turn as
   * not completed; `refuse` ends the run with the sentence given. Never resends.
   */
  recoverInterrupted?(
    checkpoint: C,
    interruptedRequestId: string | null,
  ): { resume: C } | { refuse: string };
  /**
   * Open a missing connection before the turn is recorded, and confirm a live one still has its
   * native session. A refusal found there (a fork the engine cannot make, a session it no longer
   * has) was never sent, so it fails the command without a turn step to reconcile. Absent: the
   * connection is opened inside the turn, as the Claude session always has.
   */
  openBeforeTurn?: boolean;
}
export const CLAUDE_SESSION_PROFILE: NativeSessionProfile<ClaudeSessionCheckpoint> = {
  engine: 'claude-code',
  label: 'Claude',
  capability: CLAUDE_SESSION_CAPABILITY,
  parseCheckpoint: (value) => claudeCheckpointSchema.parse(validateClaudeNativeCheckpoint(value).payload),
  // H03: a message sent while Claude Code answers is held and sent as the next turn of the same
  // live session. Mid-turn stdin injection is not proven for this build, so it is never claimed.
  steering: 'queue',
};
export interface ClaudeSessionAdmission {
  location: string;
  version: string;
  model: string;
  accountRoute: string;
}
export type ClaudeConversation = Pick<
  ClaudeNativeSession,
  'turn' | 'interrupt' | 'stop' | 'close' | 'checkpoint' | 'nativeSession'
>;
/**
 * One held steering message and what has happened to it so far. A message a caller is waiting
 * on (H03: a conversation message sent with `queued`) also carries its whole turn, sent as it
 * is once its place comes, and the caller's promise, settled with that turn's own result. A
 * message sent through `steer` (H08) may instead carry `onDelivered`, which shows it and its
 * answer in the conversation. The two never share an entry: a whole queued turn is projected by
 * the caller that waits on it.
 */
type SteerEntry = {
  commandId: string;
  text: string;
  ack: SteeringAck;
  turn?: ClaudeSessionTurn<any>;
  intent?: string;
  promise?: Promise<ClaudeSessionTurnResult>;
  settle?: { resolve(result: ClaudeSessionTurnResult): void; reject(error: unknown): void };
  /**
   * Set once the drain has handed this entry to `request`. It is the running turn from then on:
   * Stop stops it, a retry of a whole turn does not join it, and nothing withdraws or cancels it.
   */
  sending?: boolean;
  /** Shows a sent message and its answer where the person reads the conversation. */
  onDelivered?: SteerOptions['onDelivered'];
};
export interface SteerOptions {
  /**
   * Called once the held message was answered as its own turn, before it reads `delivered`,
   * with that turn's result and the request it was sent as. Idempotent projection only.
   */
  onDelivered?(result: ClaudeSessionTurnResult, input: TextRequest): Promise<void>;
}
/** How many messages may wait behind one running turn, and how many answered ones are kept to read. */
const STEER_QUEUE_LIMIT = 8;
const STEER_HISTORY = 16;
/** A live native conversation of any profile: what `open` returns. */
export interface NativeConversation<C extends SessionCheckpointFacts> {
  turn(input: TextRequest): Promise<TextResponse>;
  interrupt(): Promise<void>;
  /**
   * A person's Stop with escalation (H03): interrupt, wait at most `graceMs` for the turn's own
   * boundary, then end the process. Says which happened. A transport without it is stopped by
   * aborting its turn's signal.
   */
  stop?(graceMs: number): Promise<'interrupted' | 'killed'>;
  close(reason?: unknown): Promise<void>;
  readonly checkpoint: C;
  readonly nativeSession: NativeSessionRef | null;
  /** Set by a transport that can report how it reached its session (a resume that started fresh). */
  readonly continuity?: { origin: string; detail: string | null };
  /** True where every turn may reach its session differently, so each turn reports it (H05). */
  readonly continuityPerTurn?: boolean;
  /** Set by a transport that can confirm, sending nothing, that its native session still exists. */
  verify?(): Promise<void>;
}
const lifetimeReached = () =>
  new EngineError('TIMEOUT', 'The native connection reached its lifetime limit.');
type Connection = {
  session: NativeConversation<SessionCheckpointFacts>;
  writer?: StepContext['saveNativeCheckpoint'];
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
  closing?: Promise<void>;
  /** The lifetime ended while a turn held the connection; it closes when that turn ends. */
  expired?: boolean;
};
/** `ClaudeSessionOptions`, for any profile's checkpoint. */
export interface NativeSessionOptions<C extends SessionCheckpointFacts> {
  observedVersion: string;
  restore?: C;
  fork?: boolean;
  onCheckpoint(checkpoint: C, signal: AbortSignal): Promise<void>;
}
export interface ClaudeSessionTurn<C extends SessionCheckpointFacts = ClaudeSessionCheckpoint> {
  mode: 'start' | 'follow-up' | 'resume' | 'fork';
  runId: string;
  sourceRunId?: string;
  input: TextRequest;
  /**
   * H03: when a turn is already running on this run, wait behind it (`profile.steering`) instead
   * of being refused as busy. The wait is shown in `status` and ends with this turn's own result,
   * or with a refusal saying why it was not sent.
   */
  queued?: boolean;
  admit(signal?: AbortSignal): Promise<ClaudeSessionAdmission>;
  open(
    admission: ClaudeSessionAdmission,
    input: TextRequest,
    options: NativeSessionOptions<C>,
  ): Promise<NativeConversation<C>>;
  preview?(
    context: StepContext,
    stepId: string,
  ): {
    onDelta(text: string): void;
    /** The adapter-facing tool activity sink, fenced to the same attempt as `onDelta`. */
    onToolActivity?: TextRequest['onToolActivity'];
    finish(): Promise<void>;
  };
}
export interface ClaudeSessionTurnResult {
  runId: string;
  response: TextResponse | null;
  interrupted: boolean;
  nativeSession: NativeSessionRef | null;
  /**
   * The answer with its decision block removed, for a conversation message. Derived from
   * `response.text` each time it is returned and never saved: the saved turn keeps the whole
   * answer as evidence.
   */
  answerText?: string;
  /**
   * On the first turn of a lineage "Update this conversation" started, as evidence: the run its
   * prompt carried messages from and how many, never their text. Absent when nothing was carried.
   */
  carried?: { from: string; messages: number };
  /**
   * On a turn that opened its connection, when the transport reports how it reached its
   * session and has something to say: a resume the engine could not honour, which started a
   * fresh native session. Absent on every other turn and on every Claude turn.
   */
  continuity?: { origin: string; detail: string };
  /** Plain writing: what the check found and what code fixed (server/plain-writing.ts). */
  writing?: Json;
  /**
   * H03: set when a person's Stop ended this turn at its own boundary, the session idle and
   * still resumable. A Stop that had to end the process fails the turn as `STOP_FORCED` instead.
   */
  stop?: 'interrupted';
}
/**
 * H03: whether a native conversation can take its next message, read from its durable record
 * after a restart as much as during a visit. `live`: its process is running here. `resumable`:
 * the next message resumes the saved native session. `new`: nothing was saved yet, so the next
 * message starts one. `start-again`: the record says the session cannot be resumed, and why.
 * `cursor` is the run event sequence the read was made at.
 */
export interface SessionContinuity {
  state: 'live' | 'resumable' | 'new' | 'start-again';
  detail: string;
  cursor: number;
}
/**
 * What happened to one conversation message after its answer, in the order it can happen.
 * `action-selected` is the person choosing to start what Diomedes proposed; the two `refused`
 * phases are final, so a refused message is reported on replay and never tried again.
 */
export type InteractionPhaseName =
  | 'decision'
  | 'action-selected'
  | 'task-input'
  | 'task-receipt'
  | 'task-refused'
  | 'work-input'
  | 'work-receipt'
  | 'work-refused';
/** Pure data. The driver saves each as one immutable, pure, zero-cost, local step. */
export interface InteractionPhase {
  phase: InteractionPhaseName;
  sourceMessageId: string;
  body: Json;
}
export const claudeSessionRunId = (projectId: string, commandId: string) =>
  `claude-${digest({ projectId, commandId })}`;
const stepKey = (prefix: string, commandId: string) =>
  `${prefix}:${digest(commandId).slice(0, 40)}`;
const PHASE_PREFIX = 'phase.';
/** The startup reconciliation step that keeps a restart-interrupted session resumable (H05). */
const RECOVER_PREFIX = 'recover:';
/** A `transform` step charges neither the model nor the tool counter, and costs no units. */
const phaseDefinition = (phase: InteractionPhase): StepDefinition => ({
  id: stepKey(`${PHASE_PREFIX}${phase.phase}`, phase.sourceMessageId),
  version: '1',
  kind: 'transform',
  effect: 'pure',
  name: `Interaction ${phase.phase}`,
  input: { phase: phase.phase, sourceMessageId: phase.sourceMessageId, body: phase.body },
  cost: 0,
  // Pure, so an attempt a crash left running is simply made again.
  maxAttempts: 3,
  destination: 'local',
});
/** What a turn saved about the message it answered. `binding` is missing on turns saved before it existed. */
type SavedTurn = {
  prompt?: Json;
  documents?: Json;
  mode?: Json;
  sourceRunId?: Json;
  binding?: Json;
} | null;
const scope = (input: TextRequest, engine: NativeSessionProfile<SessionCheckpointFacts>['engine'] = 'claude-code'): Json => ({
  engine,
  projectId: input.projectId,
  threadId: input.threadId,
  model: input.model,
  accountRoute: input.accountRoute,
  instructions: input.instructions,
});
const terminal = (run: HarnessRun) =>
  ['completed', 'cancelled', 'failed', 'reconcile_required'].includes(run.state);
const waitDefinition = (id: string): StepDefinition => ({
  id,
  version: '1',
  kind: 'wait',
  effect: 'pure',
  input: { reason: 'awaiting-user-input' },
  cost: 0,
  maxAttempts: 2,
  destination: 'local',
});

/** A capability driver over RunService. Only live transport handles are held here. */
export class ClaudeSessionRuns<C extends SessionCheckpointFacts = ClaudeSessionCheckpoint> {
  private closed = false;
  private sharingPolicy: (projectId: string, documents: readonly string[], priorConversation: boolean) => void = () => {
    throw new HarnessError('cloud_sharing_unconfigured', 'Project cloud sharing is not configured for this native session.');
  };
  /** Whether conversation history may go to Claude Code for this project now. Off until the host says. */
  private historyPolicy: (projectId: string) => boolean = () => false;
  private readonly owner: string;
  private readonly profile: NativeSessionProfile<C>;
  private readonly connections = new Map<string, Connection>();
  private readonly active = new Map<
    string,
    {
      commandId: string;
      intent: string;
      controller: AbortController;
      promise: Promise<ClaudeSessionTurnResult>;
      request: ClaudeSessionTurn<C>;
      /** Set when a person's Stop reached this turn (H03), so its result says it was stopped. */
      stopRequested?: boolean;
      /** The one stop in progress for this turn: a Stop press and a dropped caller share it. */
      stopping?: Promise<'interrupted' | 'killed' | undefined>;
    }
  >();
  /** Messages held while a turn runs, per run, in the order they were sent (`profile.steering`). */
  private readonly steers = new Map<string, SteerEntry[]>();
  private readonly forkLocks = new Set<string>();
  private readonly closing = new Set<Promise<void>>();
  private readonly cleanupFailures: unknown[] = [];
  private readonly lifetimeMs: number;
  /** How long a Stop waits for the turn's own boundary before the process is ended (H03). */
  private readonly stopGraceMs: number;
  constructor(
    private readonly runs: RunService,
    options: { connectionLifetimeMs?: number; profile?: NativeSessionProfile<C>; stopGraceMs?: number } = {},
  ) {
    this.stopGraceMs = options.stopGraceMs ?? 5000;
    this.profile = options.profile ?? (CLAUDE_SESSION_PROFILE as unknown as NativeSessionProfile<C>);
    this.owner = `${this.profile.engine === 'claude-code' ? 'claude' : this.profile.engine}-session-${randomUUID()}`;
    const lifetime = options.connectionLifetimeMs ?? 30 * 60_000;
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 30 * 60_000)
      throw new Error('Native connection lifetime must be positive and at most 30 minutes.');
    this.lifetimeMs = lifetime;
  }
  setSharingPolicy(
    check: (projectId: string, documents: readonly string[], priorConversation: boolean) => void,
    shareHistory: (projectId: string) => boolean = () => false,
  ) {
    this.sharingPolicy = check;
    this.historyPolicy = shareHistory;
  }
  /** Whether a message is being answered on this run right now, in this process. */
  busy(runId: string): boolean {
    return this.active.has(runId);
  }
  /**
   * The earlier conversation a new lineage's first turn starts with, after "Update this
   * conversation": the retired lineage's recent messages, bounded as any history is (draft a.3).
   * A native session cannot resume under new instructions, so this is a transcript in the first
   * prompt, and the session keeps it from then on. Null where history sharing is off for Claude
   * Code at send time, where the carried run cannot be read or gives nothing, and on every later
   * turn. `from` and `messages` are recorded on the turn as evidence; the text never is.
   */
  private async carried(request: ClaudeSessionTurn<C>): Promise<{ text: string; from: string; messages: number } | null> {
    if (request.mode !== 'start' || !request.input.carriedFrom || !this.historyPolicy(request.input.projectId))
      return null;
    const run = await carriedRun(this.runs, request.input);
    if (!run) return null;
    const bounded = boundedHistory([run]);
    const messages = bounded.messages.get(run.id) ?? 0;
    return messages > 0 ? { text: bounded.text, from: run.id, messages } : null;
  }
  private dispose(runId: string, connection: Connection, reason?: unknown): Promise<void> {
    if (connection.closing) return connection.closing;
    if (this.connections.get(runId) === connection) this.connections.delete(runId);
    connection.writer = undefined;
    clearTimeout(connection.timer);
    connection.detach?.();
    const closed = connection.session.close(reason);
    connection.closing = closed;
    this.closing.add(closed);
    void closed.then(
      () => this.closing.delete(closed),
      (error) => {
        this.closing.delete(closed);
        this.cleanupFailures.push(error);
      },
    );
    return closed;
  }

  async get(projectId: string, runId: string): Promise<HarnessRun> {
    const run = await this.runs.get(runId);
    if (run.projectId !== projectId || run.capabilityId !== this.profile.capability.id)
      throw new HarnessError(
        'unknown_run',
        'This native conversation was not found in this project.',
      );
    return run;
  }
  private checkpoint(run: HarnessRun): C | undefined {
    const saved = [...run.steps]
      .reverse()
      .find(
        (step) =>
          (step.intent.kind === 'model' || step.intent.stepId.startsWith(RECOVER_PREFIX)) &&
          step.nativeCheckpoint,
      )?.nativeCheckpoint;
    return saved ? this.profile.parseCheckpoint(saved) : undefined;
  }
  async status(projectId: string, runId: string) {
    const run = await this.get(projectId, runId);
    const checkpoint = this.checkpoint(run);
    return {
      runId,
      state: run.state,
      connected: this.connections.has(runId),
      requestedModel: checkpoint?.requestedModel ?? null,
      reportedModel: checkpoint?.reportedModel ?? null,
      // The read scope the saved session was opened with, read as its restore check reads it:
      // a checkpoint written before read tools existed is text-only. Null with no checkpoint.
      scopeDigest: checkpoint ? (checkpoint.scopeDigest ?? 'text-only') : null,
      nativeSession:
        checkpoint?.nativeSessionId && checkpoint.reportedModel
          ? {
              providerId: this.profile.engine,
              lineageId: checkpoint.lineageId,
              opaqueRef: checkpoint.nativeSessionId,
            }
          : null,
      // Only a profile that holds messages has anything to say here.
      ...(this.profile.steering === 'queue'
        ? { steering: (this.steers.get(runId) ?? []).map((entry) => structuredClone(entry.ack)) }
        : {}),
      busy: this.active.has(runId),
      continuity: this.continuityOf(run, checkpoint),
    };
  }
  /**
   * H03: whether this conversation's next message can reach its native session, from the
   * durable record alone apart from `live`. A turn whose outcome is unknown (a restart while it
   * ran, a Stop that had to end the process, a resume the engine refused) is never resumed, and
   * the answer says so instead of leaving the conversation looking as if it were still running.
   */
  private continuityOf(run: HarnessRun, checkpoint: C | undefined): SessionContinuity {
    const cursor = run.lastSeq;
    const name = this.profile.engine === 'claude-code' ? 'Claude Code' : this.profile.label;
    if (this.connections.has(run.id))
      return { state: 'live', detail: `${name} is running this conversation now; the next message goes to the same session.`, cursor };
    const unfinished = [...run.steps].reverse().find((step) => step.intent.kind === 'model' && step.state !== 'succeeded');
    if (terminal(run) || (checkpoint && checkpoint.state !== 'idle') || unfinished) {
      const restarted = run.events.some((event) => event.type === 'step.reconcile_required' && event.attributes.why === 'exclusive host startup');
      const reason = unfinished?.error?.message
        ? unfinished.error.message
        : restarted
          ? `Diomedes stopped while ${name} was answering, so that answer's outcome is unknown.`
          : run.state === 'cancelled'
            ? 'This conversation was cancelled.'
            : `The last ${name} turn did not finish, so its outcome is unknown.`;
      return { state: 'start-again', detail: `Couldn't resume. ${reason} The next message starts a new session.`, cursor };
    }
    if (checkpoint?.nativeSessionId)
      return { state: 'resumable', detail: `Not running now. The next message resumes the saved ${name} session.`, cursor };
    return { state: 'new', detail: `The next message starts a ${name} session.`, cursor };
  }
  request(request: ClaudeSessionTurn<C>): Promise<ClaudeSessionTurnResult> {
    if (this.closed)
      return Promise.reject(
        new EngineError('SESSION_CLOSED', 'The native runtime is shutting down.'),
      );
    const intent = digest({
      scope: scope(request.input, this.profile.engine),
      prompt: request.input.prompt,
      documents: request.input.documents,
      requestId: request.input.requestId,
      mode: request.mode,
      sourceRunId: request.sourceRunId ?? null,
      binding: request.input.binding ?? null,
    });
    // A queued message asked for again joins its own wait, and never a second copy of it.
    const held = (this.steers.get(request.runId) ?? []).find(
      (entry) => entry.promise && !entry.sending && entry.commandId === request.input.requestId,
    );
    if (held?.promise && (held.ack.state === 'pending' || held.intent === intent)) {
      if (held.intent !== intent)
        return Promise.reject(
          new HarnessError(
            'intent_mismatch',
            'This command was already used for a different message. Send this one as a new message.',
          ),
        );
      return held.promise;
    }
    const pending = this.active.get(request.runId);
    if (pending) {
      if (pending.commandId === request.input.requestId && pending.intent === intent)
        return pending.promise;
      if (request.queued && this.profile.steering === 'queue') return this.queue(request, intent);
      return Promise.reject(
        new EngineError('SESSION_BUSY', 'This conversation already has a turn in progress.'),
      );
    }
    if (this.forkLocks.has(request.runId))
      return Promise.reject(new EngineError('SESSION_BUSY', 'This conversation is being forked.'));
    if (request.mode === 'fork') {
      if (
        !request.sourceRunId ||
        this.active.has(request.sourceRunId) ||
        this.forkLocks.has(request.sourceRunId)
      )
        return Promise.reject(
          new EngineError('SESSION_BUSY', 'Fork requires an idle source conversation.'),
        );
      this.forkLocks.add(request.sourceRunId);
    }
    const controller = new AbortController();
    // H03: the caller going away (a Console Stop ends its own request first) is a Stop, not a
    // shutdown: it goes through the same graceful interrupt and bounded escalation as the Stop
    // route. Only this driver's own controller (shutdown, or a transport that cannot stop
    // gracefully) aborts the turn outright.
    const admitted = { ...request, input: { ...request.input, signal: controller.signal } };
    const caller = request.input.signal;
    const promise = this.drive(admitted).finally(() => {
      caller?.removeEventListener('abort', gone);
      controller.abort();
      this.active.delete(request.runId);
      if (request.sourceRunId) this.forkLocks.delete(request.sourceRunId);
    });
    const entry = {
      commandId: request.input.requestId,
      intent,
      controller,
      promise,
      request,
    };
    this.active.set(request.runId, entry);
    const gone = () => void this.stopActive(request.runId, entry).catch(() => undefined);
    if (caller?.aborted) controller.abort();
    else caller?.addEventListener('abort', gone, { once: true });
    return promise;
  }
  /** The person's text and the first phase, from a committed answer. Pure; nothing is written here. */
  private decide(
    request: ClaudeSessionTurn<C>,
    result: ClaudeSessionTurnResult,
  ): { result: ClaudeSessionTurnResult; phase: InteractionPhase | null } {
    const interaction = request.input.interaction;
    if (!interaction || !result.response) return { result, phase: null };
    const split = interaction.decide(result.response.text);
    return {
      result: { ...result, answerText: split.answerText },
      phase: {
        phase: 'decision',
        sourceMessageId: interaction.sourceMessageId,
        body: split.body,
      },
    };
  }
  /**
   * Reads back the answer a command already has. It never calls `step`, so it charges nothing
   * and cannot be refused for being cancelled, and it never claims a settled run, which would
   * move that run's fence for no reason.
   *
   * The request is compared with what was saved before the answer is returned. The model and
   * the account route are left out of that comparison on purpose: a read reaches no provider,
   * and a person who changed model since must still be able to read what was said. A request
   * that would generate anything still goes through the scope check in `drive`.
   */
  private async replay(
    run: HarnessRun,
    turn: HarnessRun['steps'][number],
    request: ClaudeSessionTurn<C>,
  ): Promise<ClaudeSessionTurnResult> {
    const { input } = request;
    const saved = turn.intent.input as SavedTurn;
    const same =
      saved?.binding !== undefined
        ? saved.binding === input.binding
        : digest({
            prompt: saved?.prompt ?? null,
            documents: saved?.documents ?? null,
            mode: saved?.mode ?? null,
            sourceRunId: saved?.sourceRunId ?? null,
            instructions: (run.input as { instructions?: Json } | null)?.instructions ?? null,
          }) ===
          digest({
            prompt: input.prompt,
            documents: input.documents,
            mode: request.mode,
            sourceRunId: request.sourceRunId ?? null,
            instructions: input.instructions,
          });
    // The same refusal, under the same code, that `RunService` gives a changed intent. This read
    // stands in for the `step` call that used to reach that guard, so it must not answer less.
    if (!same)
      throw new HarnessError(
        'intent_mismatch',
        'This command was already used for a different message. Send this one as a new message.',
      );
    const decided = this.decide(
      request,
      structuredClone(turn.output) as unknown as ClaudeSessionTurnResult,
    );
    // A replay returns exactly what the first request returned, so nothing here marks it as a
    // replay. A settled run is read and left alone: not claimed, not written, not charged. A
    // live one gets the first phase, and the recorded artifacts, a crash may have left unwritten.
    if (!terminal(run)) {
      const sourceMessageId = input.interaction?.sourceMessageId;
      const artifacts = sourceMessageId
        ? unrecordedArtifacts(run, sourceMessageId, this.artifacts(request, run.id, decided.result))
        : [];
      if (decided.phase || artifacts.length)
        await this.append(input.projectId, run.id, decided.phase ? [decided.phase] : [], artifacts);
    }
    return decided.result;
  }
  /** Assumes the lease is held and no wait is open, as it is inside `drive`. */
  private async write(runId: string, projectId: string, phases: readonly InteractionPhase[]) {
    await this.writeSteps(runId, projectId, phases.map(phaseDefinition));
  }
  /** Assumes the lease is held and no wait is open. Each step is pure and records nothing but its input. */
  private async writeSteps(runId: string, projectId: string, definitions: readonly StepDefinition[]) {
    for (const definition of definitions)
      await this.runs.step(runId, this.owner, definition, () => ({ recorded: true }), localHarnessPrincipal(projectId));
  }
  /**
   * The index-only steps that record the artifacts in one answered conversation message
   * (`artifact-steps.ts`): none for a message that is not a conversation message, was not
   * answered, or holds no artifact.
   */
  private artifacts(request: ClaudeSessionTurn<C>, runId: string, result: ClaudeSessionTurnResult): StepDefinition[] {
    const interaction = request.input.interaction;
    if (!interaction || !result.response) return [];
    return artifactSteps({
      runId,
      threadId: request.input.threadId,
      commandId: request.input.requestId,
      sourceMessageId: interaction.sourceMessageId,
      turnStepId: stepKey('turn', request.input.requestId),
      answer: result.answerText ?? result.response.text,
    });
  }
  /**
   * Saves the phases that are not saved yet. A phase already saved with the same body is left
   * alone, so reaching here twice writes once; the same phase with a different body is refused.
   * `extra` steps (a message's recorded artifacts) are written after them when not written yet.
   * When nothing is missing the run is not claimed, woken or parked. A settled run is never
   * written to: the caller reports what the record already says.
   */
  private async append(
    projectId: string,
    runId: string,
    phases: readonly InteractionPhase[],
    extra: readonly StepDefinition[] = [],
  ) {
    const run = await this.get(projectId, runId);
    const missing = phases.filter((phase) => {
      const definition = phaseDefinition(phase);
      const existing = run.steps.find((step) => step.intent.stepId === definition.id);
      if (existing?.state !== 'succeeded') return true;
      if (digest(existing.intent.input) !== digest(definition.input ?? null))
        throw new HarnessError(
          'intent_mismatch',
          'This interaction phase is already recorded with different contents.',
        );
      return false;
    });
    const unwritten = extra.filter(
      (definition) => run.steps.find((step) => step.intent.stepId === definition.id)?.state !== 'succeeded',
    );
    if (!missing.length && !unwritten.length) return;
    if (terminal(run))
      throw new EngineError(
        'RUN_SETTLED',
        'This conversation run is settled. Nothing more can be recorded on it.',
      );
    // After a restart this driver is a new owner. Startup recovery released the old lease, so
    // the claim succeeds; a lease another live process still holds is refused, as it should be.
    // A cancellation that lands after the check above is refused inside the claim itself.
    await this.claimLive(runId);
    await this.resolveWaits(runId, projectId);
    await this.write(runId, projectId, missing);
    await this.writeSteps(runId, projectId, unwritten);
    const last = missing[missing.length - 1];
    await this.park(runId, projectId, last ? `${last.sourceMessageId}:${last.phase}` : `${unwritten[0].id}`);
  }
  /**
   * Saves interaction phases under this driver's own lease. The app never touches a step.
   *
   * Two requests saving the same immutable phases are one write. The second reads the
   * first's result instead of meeting its own step in flight, which is not a conflict but
   * the same fact arriving twice, so identical concurrent requests converge on one record.
   */
  async record(projectId: string, runId: string, phases: readonly InteractionPhase[]) {
    if (this.closed) throw new EngineError('SESSION_CLOSED', 'The native runtime is shutting down.');
    return this.runs.join(`phases:${projectId}:${runId}:${digest(phases)}`, () =>
      this.append(projectId, runId, phases),
    );
  }
  /** The phases saved for one message, in the order they were saved. A read; never a step. */
  async phases(
    projectId: string,
    runId: string,
    sourceMessageId: string,
  ): Promise<InteractionPhase[]> {
    const run = await this.get(projectId, runId);
    return run.steps
      .filter(
        (step) =>
          step.state === 'succeeded' &&
          step.intent.kind === 'transform' &&
          step.intent.stepId.startsWith(PHASE_PREFIX),
      )
      .map((step) => step.intent.input as unknown as InteractionPhase)
      .filter((phase) => phase.sourceMessageId === sourceMessageId)
      .map((phase) => structuredClone(phase));
  }
  /**
   * Which of these runs already holds this command, looking at the newest first. The caller
   * passes every lineage a thread ever had, retired ones included: a message answered before
   * the conversation moved on is still answered. A read; nothing is claimed.
   */
  async locate(
    projectId: string,
    runIds: readonly string[],
    commandId: string,
  ): Promise<{ runId: string; answered: boolean; settled: boolean; dispatched: boolean } | null> {
    const turnId = stepKey('turn', commandId);
    for (const runId of runIds) {
      let run: HarnessRun;
      try {
        run = await this.get(projectId, runId);
      } catch (error) {
        if (error instanceof HarnessError && error.code === 'unknown_run') continue;
        throw error;
      }
      const turn = run.steps.find((step) => step.intent.stepId === turnId);
      // A turn a budget refused was written and never sent: it has no attempt. Nothing was
      // asked of a model, so it is not an unfinished message anywhere.
      if (turn)
        return {
          runId,
          answered: turn.state === 'succeeded',
          settled: terminal(run),
          dispatched: turn.attempt > 0,
        };
    }
    return null;
  }
  private async claimLive(runId: string) {
    try {
      await this.runs.claim(runId, this.owner, 35 * 60_000, { refuseSettled: true });
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'run_settled')
        throw new EngineError(
          'RUN_SETTLED',
          'This conversation run is settled. Nothing more can be recorded on it.',
        );
      throw error;
    }
  }
  /**
   * Commits a child of this conversation inside the run's own writer queue, refusing first a
   * run that is already settled. The Runtime's own terminal transitions take that same queue,
   * so a cancellation, a failed model step or a denial is ordered either before this refusal
   * or after the commit it protects. Process-local ordering, not crash recovery: a child that
   * did commit is found again by its durable receipt.
   *
   * The commit must not record, claim or step this run, and must await no provider, no person
   * and no background work.
   */
  async fenced<T>(projectId: string, runId: string, commit: () => Promise<T>): Promise<T> {
    try {
      return await this.runs.fence(runId, localHarnessPrincipal(projectId), async (run) => {
        if (run.projectId !== projectId || run.capabilityId !== this.profile.capability.id)
          throw new HarnessError(
            'unknown_run',
            'This native conversation was not found in this project.',
          );
        return commit();
      });
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'run_settled')
        throw new EngineError(
          'RUN_SETTLED',
          'This conversation moved on before this was started. Nothing was started.',
        );
      throw error;
    }
  }
  /**
   * Refuses when the conversation run is settled. The admission boundary calls this inside the
   * Store lock, which is the lock the run-cancel route holds while it cancels, so a cancellation
   * is either seen here or comes after the admission it would have stopped.
   */
  async assertLive(projectId: string, runId: string) {
    if (terminal(await this.get(projectId, runId)))
      throw new EngineError(
        'RUN_SETTLED',
        'This conversation moved on before this was started. Nothing was started.',
      );
  }
  /**
   * What the Runtime durably saved for one command's turn. A step that succeeded carrying no
   * response is an interruption the person asked for and the provider acknowledged, not a
   * completed answer, so a later read of that message must not report it as answered either.
   * A turn still running, or one that never finished, has saved nothing to read.
   */
  async turnResult(
    projectId: string,
    runId: string,
    commandId: string,
  ): Promise<{ answered: boolean; interrupted: boolean } | null> {
    const run = await this.get(projectId, runId);
    const turn = run.steps.find((step) => step.intent.stepId === stepKey('turn', commandId));
    if (!turn || turn.state !== 'succeeded') return null;
    const saved = turn.output as { response?: unknown; interrupted?: unknown } | null;
    return {
      answered: saved?.response !== null && saved?.response !== undefined,
      interrupted: saved?.interrupted === true,
    };
  }
  /**
   * What one answered message was sent with, read from its immutable turn: the source files
   * it carried and the origin the Runtime recorded. A projection repaired later is rebuilt
   * from this, never from the files and settings as they stand now.
   */
  async evidence(projectId: string, runId: string, commandId: string) {
    const run = await this.get(projectId, runId);
    const turn = run.steps.find((step) => step.intent.stepId === stepKey('turn', commandId));
    const saved = turn?.intent.input as { documents?: { path: string }[] } | undefined;
    return {
      sources: (saved?.documents ?? []).map((document) => document.path),
      origin: turn?.origin ?? null,
    };
  }
  private async resolveWaits(runId: string, projectId: string) {
    const run = await this.get(projectId, runId);
    for (const step of run.steps.filter((s) => s.state === 'waiting_event'))
      await this.runs.step(
        runId,
        this.owner,
        waitDefinition(step.intent.stepId),
        () => ({ inputReceived: true }),
        localHarnessPrincipal(projectId),
      );
  }
  private async park(runId: string, projectId: string, commandId: string) {
    const run = await this.get(projectId, runId);
    if (
      terminal(run) ||
      run.steps.some((step) => step.state === 'running' || step.state === 'waiting_event')
    )
      return;
    try {
      await this.runs.step(
        runId,
        this.owner,
        waitDefinition(stepKey('input', commandId)),
        () => {
          throw new Suspended('event', 'Waiting for explicit input.');
        },
        localHarnessPrincipal(projectId),
      );
    } catch (error) {
      if (!(error instanceof Suspended && error.reason === 'event')) throw error;
    }
  }
  private async drive(request: ClaudeSessionTurn<C>): Promise<ClaudeSessionTurnResult> {
    const { input, runId } = request;
    const principal = localHarnessPrincipal(input.projectId);
    let run: HarnessRun | undefined;
    try {
      run = await this.get(input.projectId, runId);
    } catch (error) {
      if (!(error instanceof HarnessError && error.code === 'unknown_run')) throw error;
    }
    const turnId = stepKey('turn', input.requestId);
    // A command this run has already answered is read back before anything below can refuse
    // it. The answer is a record, not new work: a settled run, a changed model and a closed
    // process have no bearing on what was already said.
    const answered = run?.steps.find((step) => step.intent.stepId === turnId);
    if (run && answered?.state === 'succeeded') return this.replay(run, answered, request);
    let restore: C | undefined;
    if (!run && request.mode === 'start') {
      run = await this.runs.start({
        id: runId,
        projectId: input.projectId,
        tenantId: principal.tenantId,
        principal,
        capability: this.profile.capability,
        input: scope(input, this.profile.engine),
        budget: { units: 128, modelCalls: 128, toolCalls: 384, wallMs: null },
      });
    } else if (!run && request.mode === 'fork') {
      const parent = await this.get(input.projectId, request.sourceRunId!);
      if (terminal(parent) || digest(parent.input) !== digest(scope(input, this.profile.engine)))
        throw new EngineError(
          'SESSION_MISMATCH',
          'Fork requires the same idle project, thread, model and instructions.',
        );
      restore = this.checkpoint(parent);
      if (!restore?.nativeSessionId || restore.state !== 'idle' || !parent.steps.length)
        throw new EngineError(
          'RECONCILE_REQUIRED',
          'The source native conversation is not ready to fork.',
          true,
        );
      // Empty pure prefix: no provider observations, permissions or hidden state are copied.
      run = await this.runs.fork(parent.id, runId, parent.steps[0].intent.stepId, principal);
    }
    if (!run)
      throw new HarnessError('unknown_run', 'Resume or follow-up needs an existing conversation.');
    if (request.mode === 'fork' && run.parentRunId !== request.sourceRunId)
      throw new EngineError(
        'SESSION_MISMATCH',
        'This fork command belongs to a different source run.',
      );
    if (terminal(run))
      throw new EngineError(
        'RECONCILE_REQUIRED',
        'This run is settled or requires reconciliation; it cannot accept new work.',
        true,
      );
    if (digest(run.input) !== digest(scope(input, this.profile.engine)))
      throw new EngineError('SESSION_MISMATCH', 'The native conversation scope changed.');
    await this.runs.claim(runId, this.owner, 35 * 60_000);
    // An unfinished turn saved before bindings existed keeps the shape it was saved with, or
    // finishing it would be refused as a changed intent.
    const unfinished = run.steps.find((step) => step.intent.stepId === turnId);
    const bound =
      input.binding !== undefined &&
      !(unfinished && (unfinished.intent.input as SavedTurn)?.binding === undefined);
    const turnDefinition: StepDefinition = {
      id: turnId,
      version: '1',
      kind: 'model',
      effect: 'read',
      name: `${this.profile.label} native turn`,
      input: {
        engine: this.profile.engine,
        requestId: input.requestId,
        prompt: input.prompt,
        documents: input.documents,
        mode: request.mode,
        sourceRunId: request.sourceRunId ?? null,
        ...(bound ? { binding: input.binding! } : {}),
        // Which rules the message carried, as evidence (shas and paths, never a body). A turn
        // saved before rules travelled keeps the shape it was saved with, as for `binding`.
        ...(input.rules && !(unfinished && (unfinished.intent.input as { rules?: Json } | null)?.rules === undefined)
          ? { rules: input.rules.record }
          : {}),
      },
      destination: 'external',
      cost: 1,
      maxAttempts: 1,
    };
    // What an adapter is given. The conversation identity is the host's and stays here.
    const wire: TextRequest = { ...input, binding: undefined, interaction: undefined, carriedFrom: undefined };
    if (request.mode === 'fork') {
      const pinned = run.steps.find(
        (step) => step.intent.stepId === 'fork:source',
      )?.nativeCheckpoint;
      if (pinned)
        restore = this.profile.parseCheckpoint(pinned);
      if (!restore)
        throw new EngineError(
          'SESSION_INVALID',
          'This fork has no durable source reference. Start a new fork command.',
        );
      const source = await this.get(input.projectId, request.sourceRunId!);
      if (terminal(source) || digest(this.checkpoint(source)) !== digest(restore))
        throw new EngineError(
          'SESSION_MISMATCH',
          'The fork source changed after admission. Start a new fork command.',
        );
      await this.runs.step(
        runId,
        this.owner,
        {
          id: 'fork:source',
          version: '1',
          kind: 'tool',
          effect: 'read',
          destination: 'local',
          cost: 0,
          maxAttempts: 1,
          input: { sourceRunId: request.sourceRunId!, checkpointHash: digest(restore) },
        },
        async (context) => {
          await context.saveNativeCheckpoint!({
            v: 1,
            providerId: this.profile.engine,
            payload: restore! as unknown as Json,
          });
          return { pinned: true };
        },
        principal,
      );
    }
    if (request.mode === 'start' && run.steps.some((step) => step.intent.kind === 'model'))
      throw new EngineError('SESSION_EXISTS', 'Use follow-up for an existing conversation.');
    restore ??= this.checkpoint(run);
    if (restore && restore.state !== 'idle')
      throw new EngineError('RECONCILE_REQUIRED', 'The native turn outcome is uncertain.', true);
    if (request.mode === 'follow-up' && !this.connections.has(runId))
      throw new EngineError(
        'RESUME_REQUIRED',
        'Explicitly resume this conversation after its process closes.',
      );
    if (request.mode === 'resume' && !restore?.nativeSessionId)
      throw new EngineError(
        'SESSION_INVALID',
        'This conversation has no confirmed native session to resume.',
      );
    await this.resolveWaits(runId, input.projectId);
    const admission = await this.runs.step(
      runId,
      this.owner,
      {
        id: stepKey('admit', input.requestId),
        version: '1',
        kind: 'tool',
        effect: 'read',
        name: 'Native session admission',
        input: { engine: this.profile.engine, model: input.model, accountRoute: input.accountRoute },
        destination: 'local',
        cost: 0,
        maxAttempts: 3,
      },
      () => request.admit(input.signal),
      principal,
    );
    if (request.mode === 'resume' && this.connections.has(runId)) {
      await this.dispose(runId, this.connections.get(runId)!);
    }
    const holder: { owned?: Connection } = {};
    const openNative = () =>
      request.open(
        admission,
        {
          ...wire,
          signal: undefined,
          onDelta: undefined,
          onPreview: undefined,
          onActivity: undefined,
          onToolActivity: undefined,
        },
        {
          observedVersion: admission.version,
          restore,
          fork: request.mode === 'fork',
          onCheckpoint: async (checkpoint, signal) => {
            const writer = holder.owned?.writer;
            if (!writer || this.connections.get(runId) !== holder.owned || signal.aborted)
              throw new HarnessError(
                'stale_attempt',
                'No running attempt owns this checkpoint callback.',
              );
            return writer(
              { v: 1, providerId: this.profile.engine, payload: checkpoint as unknown as Json },
              signal,
            );
          },
        },
      );
    let preopened: NativeConversation<C> | undefined;
    if (this.profile.openBeforeTurn) {
      // Nothing here reaches a model: a refusal is known not sent, so the command fails with no
      // turn step to reconcile, and the same command can be sent again once the cause is fixed.
      const notSent = async (error: unknown): Promise<never> => {
        await this.park(runId, input.projectId, `${input.requestId}:not-sent:${randomUUID()}`).catch(
          () => undefined,
        );
        throw error;
      };
      const live = this.connections.get(runId);
      if (live?.session.verify) {
        try {
          await live.session.verify();
        } catch (error) {
          await this.dispose(runId, live, error).catch(() => undefined);
          await notSent(error);
        }
      } else if (!live) {
        try {
          this.sharingPolicy(input.projectId, input.documents.map((doc) => doc.path), request.mode !== 'start');
          preopened = await openNative();
        } catch (error) {
          await notSent(error);
        }
        if (this.closed || input.signal?.aborted) {
          await preopened!.close();
          throw new EngineError('CANCELLED', 'The native process was stopped before dispatch.');
        }
      }
    }
    let response: ClaudeSessionTurnResult;
    try {
      response = await this.runs.step<ClaudeSessionTurnResult>(
        runId,
        this.owner,
        turnDefinition,
        async (context) => {
          // Carried messages are an earlier conversation reaching the provider, so the same
          // history grant a follow-up needs is required for them, checked here and again below.
          const carried = await this.carried(request);
          const prior = request.mode !== 'start' || carried !== null;
          this.sharingPolicy(input.projectId, input.documents.map((doc) => doc.path), prior);
          const save = context.saveNativeCheckpoint;
          if (!save)
            throw new HarnessError(
              'invalid_checkpoint',
              'The runtime does not support native checkpoints.',
            );
          let connection = this.connections.get(runId);
          const opened = !connection;
          if (!connection) {
            const session = preopened ?? (await openNative());
            preopened = undefined;
            if (this.closed || context.signal.aborted || input.signal?.aborted) {
              await session.close();
              throw new EngineError('CANCELLED', 'The native process was stopped before dispatch.');
            }
            connection = { session };
            const owned = connection;
            holder.owned = owned;
            this.connections.set(runId, connection);
            const endOwned = () => {
              void this.dispose(runId, owned, context.signal.reason);
            };
            context.signal.addEventListener('abort', endOwned, { once: true });
            connection.detach = () => context.signal.removeEventListener('abort', endOwned);
            connection.timer = setTimeout(() => {
              // A turn in flight holds the writer; closing under it would strand its checkpoint.
              if (owned.writer) {
                owned.expired = true;
                return;
              }
              void this.dispose(runId, owned, lifetimeReached());
            }, this.lifetimeMs);
            connection.timer.unref();
          }
          connection.writer = save;
          const preview = request.preview?.(context, turnId);
          try {
            let result: TextResponse | null = null;
            let interrupted = false;
            try {
              this.sharingPolicy(input.projectId, input.documents.map((doc) => doc.path), prior);
              result = await connection.session.turn({
                ...wire,
                // The person's message goes last, so the decision format's "last line" is still
                // this message's own. The turn step keeps the message as sent by the person.
                ...(carried ? { prompt: carriedPrompt(carried.text, input.prompt) } : {}),
                signal: AbortSignal.any([context.signal, ...(input.signal ? [input.signal] : [])]),
                onDelta: preview?.onDelta,
                // Caller-facing frames never reach the adapter; it gets the fenced raw sink.
                onPreview: undefined,
                onActivity: undefined,
                onToolActivity: preview?.onToolActivity,
              });
              if (
                result.projectId !== input.projectId ||
                result.threadId !== input.threadId ||
                result.requestId !== input.requestId ||
                result.version !== admission.version
              )
                throw new EngineError(
                  'IDENTITY_MISMATCH',
                  'The native response did not match this request.',
                  true,
                );
            } catch (error) {
              if (
                error instanceof EngineError &&
                error.code === 'CANCELLED' &&
                connection.session.checkpoint.state === 'idle'
              )
                interrupted = true;
              else throw error;
            }
            await preview?.finish();
            // Plain writing, inside the step so a replay and the next message's history read the
            // same text. Check and fix in code only: a rewrite here would be a second message in the
            // engine's own session, which the person did not send (server/plain-writing.ts).
            let writing: Json | undefined;
            if (result) {
              const repaired = await repairWriting({
                text: result.text,
                options: {
                  userTexts: [input.prompt, ...input.documents.map((doc) => doc.text)],
                  ownerPhrases: input.writing?.phrases ?? [],
                },
              });
              result = { ...result, text: repaired.text };
              writing = repaired.record as unknown as Json;
            }
            context.reportOrigin?.({
              protocolVersion: 1,
              mode: 'direct',
              engine: { id: this.profile.engine, version: admission.version },
              model: {
                requested: input.model,
                reported: connection.session.checkpoint.reportedModel,
                source: connection.session.checkpoint.reportedModel ? 'runtime' : 'not-recorded',
              },
              accountRoute: input.accountRoute,
            });
            return {
              runId,
              response: result,
              ...(writing ? { writing } : {}),
              interrupted,
              ...(interrupted && this.active.get(runId)?.stopRequested ? { stop: 'interrupted' as const } : {}),
              nativeSession: connection.session.nativeSession,
              // What this first turn carried, as evidence on the run: the run and the count only.
              ...(carried ? { carried: { from: carried.from, messages: carried.messages } } : {}),
              // A resume the engine could not honour, said on the turn it happened, and saved with it.
              ...((opened || connection.session.continuityPerTurn) &&
              connection.session.continuity?.detail
                ? {
                    continuity: {
                      origin: connection.session.continuity.origin,
                      detail: connection.session.continuity.detail,
                    },
                  }
                : {}),
            };
          } catch (error) {
            await this.dispose(runId, connection, error);
            throw error;
          } finally {
            connection.writer = undefined;
            if (connection.expired) void this.dispose(runId, connection, lifetimeReached());
          }
        },
        principal,
      );
    } catch (error) {
      const connection = this.connections.get(runId);
      if (connection) await this.dispose(runId, connection, error);
      throw error;
    } finally {
      // Opened ahead of a turn that never took it (refused before its handler ran).
      if (preopened) await preopened.close().catch(() => undefined);
    }
    // The first phase is written here, in the tail a replayed command also reaches, and before
    // the run parks: a crash between the answer and this line is repaired by the next request
    // for the same command, which reads the answer back and arrives here again.
    const decided = this.decide(request, response);
    if (decided.phase) await this.write(runId, input.projectId, [decided.phase]);
    // The answer's artifacts, as index-only evidence, before the run parks (artifact-steps.ts).
    await this.writeSteps(runId, input.projectId, this.artifacts(request, runId, decided.result));
    await this.park(runId, input.projectId, input.requestId);
    return decided.result;
  }
  /**
   * Signals the active turn of this exact command to stop. The run is validated through the
   * same `get` every read uses, so a Stop for a run this project does not own is refused
   * before anything is signalled. The entry is then compared and signalled in one
   * synchronous block: a Stop naming an older command answers `superseded` and can never
   * reach the turn that replaced it. This controller already feeds the admitted turn input
   * through the existing signal merge, so no `session.interrupt()` call is made and the
   * durable `control` receipt path is untouched. `requested` is a transport
   * acknowledgement only; what the turn itself recorded stays the authority, read through
   * `turnResult` and the outcome read.
   */
  async interruptCommand(
    projectId: string,
    runId: string,
    commandId: string,
  ): Promise<{ state: 'requested' | 'idle' | 'superseded'; stop?: 'interrupted' | 'killed' | 'withdrawn' }> {
    await this.get(projectId, runId);
    // H03: a message still waiting behind a running turn is withdrawn; nothing was sent.
    if (await this.withdraw(projectId, runId, commandId)) return { state: 'requested', stop: 'withdrawn' };
    const active = this.active.get(runId);
    if (!active) return { state: 'idle' };
    if (active.commandId !== commandId) return { state: 'superseded' };
    const stop = await this.stopActive(runId, active);
    return { state: 'requested', ...(stop ? { stop } : {}) };
  }
  /** H03: withdraws a message still waiting behind a running turn, and nothing else. */
  async withdraw(projectId: string, runId: string, commandId: string): Promise<boolean> {
    try {
      await this.get(projectId, runId);
    } catch (error) {
      // A lineage whose run was never started holds nothing.
      if (error instanceof HarnessError && error.code === 'unknown_run') return false;
      throw error;
    }
    const held = (this.steers.get(runId) ?? []).find(
      (entry) => entry.commandId === commandId && entry.ack.state === 'pending' && !entry.sending,
    );
    if (!held) return false;
    this.settleSteer(runId, held, 'cancelled', 'Withdrawn by Stop before it was sent.');
    return true;
  }
  /**
   * H03: stops one active turn once, however many ways it is asked. A transport that can stop
   * gracefully is asked to within the grace, and ends its process itself when that does not
   * work, saying which happened. Any other transport, or a turn not dispatched yet, is aborted.
   */
  private stopActive(
    runId: string,
    active: {
      controller: AbortController;
      promise: Promise<ClaudeSessionTurnResult>;
      stopRequested?: boolean;
      stopping?: Promise<'interrupted' | 'killed' | undefined>;
    },
  ): Promise<'interrupted' | 'killed' | undefined> {
    active.stopRequested = true;
    active.stopping ??= (async () => {
      const session = this.connections.get(runId)?.session;
      let stop: 'interrupted' | 'killed' | undefined;
      if (session?.stop)
        stop = await session.stop(this.stopGraceMs).catch((error: unknown) => {
          if (error instanceof EngineError && error.code === 'SESSION_IDLE') return undefined;
          throw error;
        });
      if (!stop) active.controller.abort();
      await active.promise.catch(() => undefined);
      return stop;
    })();
    return active.stopping;
  }
  async control(
    projectId: string,
    runId: string,
    commandId: string,
    command: 'interrupt' | 'close',
  ) {
    const run = await this.get(projectId, runId);
    if (terminal(run) && command === 'close') {
      const connection = this.connections.get(runId);
      if (connection) await this.dispose(runId, connection);
      return { commandId, command, acknowledged: true, turnCompleted: false, nativeSession: null };
    }
    if (terminal(run))
      throw new EngineError('RECONCILE_REQUIRED', 'This run is settled or uncertain.', true);
    await this.runs.claim(runId, this.owner, 35 * 60_000);
    const definition: StepDefinition = {
      id: stepKey('control', commandId),
      version: '1',
      kind: 'tool',
      effect: 'read',
      name: `${this.profile.label} ${command}`,
      input: { command, commandId },
      cost: 0,
      destination: 'local',
      maxAttempts: 1,
    };
    if (
      run.steps.some((step) => step.intent.stepId === definition.id && step.state === 'succeeded')
    )
      return this.runs.step(
        runId,
        this.owner,
        definition,
        () => {
          throw new Error('A control receipt must replay.');
        },
        localHarnessPrincipal(projectId),
      );
    const connection = this.connections.get(runId);
    if (!connection)
      throw new EngineError('SESSION_CLOSED', 'The native process is already closed.');
    if (command === 'interrupt' && !this.active.has(runId))
      throw new EngineError('SESSION_IDLE', 'No native turn is running.');
    if (!this.active.has(runId)) await this.resolveWaits(runId, projectId);
    const receipt = await this.runs.step(
      runId,
      this.owner,
      definition,
      async () => {
        if (command === 'interrupt') await connection.session.interrupt();
        else {
          await this.dispose(runId, connection);
        }
        return {
          commandId,
          command,
          acknowledged: true,
          turnCompleted: false,
          nativeSession: connection.session.nativeSession,
        };
      },
      localHarnessPrincipal(projectId),
    );
    await this.park(runId, projectId, commandId);
    return receipt;
  }
  /**
   * A message for a conversation whose turn is still running (`profile.steering`). The message
   * is held here, in this process, and sent as the next turn of the same native session once
   * the running one finishes; it is never injected into the running turn. If that turn is
   * stopped or fails, every held message is cancelled with that reason and nothing is sent.
   * The acknowledgement says exactly which of those happened: `pending` while it waits,
   * `delivered` once its own turn reached the native session, `cancelled` or `rejected` otherwise.
   * The queue is not durable: a restart cancels what was waiting, and each sent message is a
   * durable turn of its own, found again by its command id.
   */
  async steer(
    projectId: string,
    runId: string,
    commandId: string,
    text: string,
    options: SteerOptions = {},
  ): Promise<SteeringAck> {
    if (this.closed) throw new EngineError('SESSION_CLOSED', 'The native runtime is shutting down.');
    await this.get(projectId, runId);
    if (this.profile.steering !== 'queue')
      throw new EngineError(
        'COMMAND_UNSUPPORTED',
        `This ${this.profile.label} conversation does not accept messages while it is answering.`,
      );
    const queue = this.steers.get(runId) ?? [];
    const existing = queue.find((entry) => entry.commandId === commandId);
    if (existing) {
      if (existing.text !== text)
        throw new HarnessError(
          'intent_mismatch',
          'This command was already used for a different message. Send this one as a new message.',
        );
      return structuredClone(existing.ack);
    }
    const ack = (state: SteeringAck['state'], detail: string, nativeSession: NativeSessionRef | null = null) =>
      steeringAckSchema.parse({ commandId, state, nativeSession, at: new Date().toISOString(), detail });
    const active = this.active.get(runId);
    if (!active)
      return ack('rejected', 'Nothing is being answered in this conversation now. Send this as a message instead.');
    if (queue.filter((entry) => entry.ack.state === 'pending').length >= STEER_QUEUE_LIMIT)
      return ack('rejected', `${STEER_QUEUE_LIMIT} messages are already waiting for this answer to finish.`);
    const entry: SteerEntry = {
      commandId,
      text,
      onDelivered: options.onDelivered,
      ack: ack('pending', 'Waiting for the current answer to finish; it will be sent next, as its own message.'),
    };
    queue.push(entry);
    this.steers.set(runId, queue.slice(-STEER_HISTORY - STEER_QUEUE_LIMIT));
    this.drain(runId, active);
    return structuredClone(entry.ack);
  }
  /**
   * H03: a whole turn that waits behind the running one, for a caller that waits on its answer
   * (a conversation message sent with `queued`). It is held in the same queue `steer` uses, is
   * sent exactly as it was admitted once its place comes, and settles with its own result. If
   * the turn ahead of it is stopped or fails it is refused with that reason, and nothing is sent.
   */
  private queue(request: ClaudeSessionTurn<C>, intent: string): Promise<ClaudeSessionTurnResult> {
    const runId = request.runId;
    const active = this.active.get(runId)!;
    const queue = this.steers.get(runId) ?? [];
    if (queue.filter((entry) => entry.ack.state === 'pending').length >= STEER_QUEUE_LIMIT)
      return Promise.reject(
        new EngineError('STEER_QUEUE_FULL', `${STEER_QUEUE_LIMIT} messages are already waiting for this answer to finish.`),
      );
    let settle!: SteerEntry['settle'];
    const promise = new Promise<ClaudeSessionTurnResult>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const entry: SteerEntry = {
      commandId: request.input.requestId,
      text: request.input.prompt,
      ack: steeringAckSchema.parse({
        commandId: request.input.requestId,
        state: 'pending',
        nativeSession: null,
        at: new Date().toISOString(),
        detail: 'Waiting for the current answer to finish; it will be sent next, as its own message.',
      }),
      turn: request,
      intent,
      promise,
      settle,
    };
    queue.push(entry);
    this.steers.set(runId, queue.slice(-STEER_HISTORY - STEER_QUEUE_LIMIT));
    // The caller going away while it waits withdraws the message; nothing was sent.
    request.input.signal?.addEventListener(
      'abort',
      () => {
        if (entry.ack.state === 'pending' && !entry.sending)
          this.settleSteer(runId, entry, 'cancelled', 'Withdrawn before it was sent.');
      },
      { once: true },
    );
    this.drain(runId, active);
    return promise;
  }
  /**
   * One drain per run. It stops being the drain in the same synchronous step that finds nothing
   * left to send, so a message pushed here is either seen by it or starts a new one.
   */
  private drain(runId: string, active: { promise: Promise<ClaudeSessionTurnResult>; request: ClaudeSessionTurn<C> }) {
    if (this.draining.has(runId)) return;
    this.draining.add(runId);
    const base = active.request;
    void active.promise.then(
      (result) => {
        if (!result.interrupted) return this.sendSteers(runId, base);
        this.cancelSteers(runId, 'The answer it was waiting for was stopped, so this message was not sent.');
        this.draining.delete(runId);
      },
      () => {
        this.cancelSteers(runId, 'The answer it was waiting for did not finish, so this message was not sent.');
        this.draining.delete(runId);
      },
    );
  }
  /** What happened to the messages sent while this conversation was answering. A read. */
  async steering(projectId: string, runId: string): Promise<SteeringAck[]> {
    await this.get(projectId, runId);
    return (this.steers.get(runId) ?? []).map((entry) => structuredClone(entry.ack));
  }
  private readonly draining = new Set<string>();
  private settleSteer(
    runId: string,
    entry: SteerEntry,
    state: SteeringAck['state'],
    detail: string,
    nativeSession: NativeSessionRef | null = null,
    error?: unknown,
  ) {
    // A caller waiting on this message hears a refusal in the same words the queue shows.
    if (entry.settle && (state === 'cancelled' || state === 'rejected'))
      entry.settle.reject(error ?? new EngineError('STEER_CANCELLED', detail));
    entry.ack = steeringAckSchema.parse({
      commandId: entry.commandId,
      state,
      nativeSession,
      at: new Date().toISOString(),
      detail,
    });
    const queue = this.steers.get(runId);
    if (queue) this.steers.set(runId, queue.slice(-STEER_HISTORY - STEER_QUEUE_LIMIT));
  }
  private cancelSteers(runId: string, detail: string) {
    // A message already handed to the engine is not "not sent": its own turn settles it.
    for (const entry of this.steers.get(runId) ?? [])
      if (entry.ack.state === 'pending' && !entry.sending) this.settleSteer(runId, entry, 'cancelled', detail);
  }
  /** Sends the held messages one at a time, each as its own follow-up turn with no documents. */
  private async sendSteers(runId: string, base: ClaudeSessionTurn<C>) {
    for (;;) {
      const entry = (this.steers.get(runId) ?? []).find((item) => item.ack.state === 'pending');
      if (!entry || this.closed) {
        this.draining.delete(runId);
        break;
      }
      if (entry.turn) {
        // A whole queued turn goes as it was admitted, and its caller gets its own result.
        entry.sending = true;
        entry.ack = steeringAckSchema.parse({ ...entry.ack, at: new Date().toISOString(), detail: 'Being sent now.' });
        try {
          const result = await this.request({ ...entry.turn, queued: false });
          const settle = entry.settle!;
          entry.settle = undefined;
          if (result.nativeSession)
            this.settleSteer(
              runId,
              entry,
              'delivered',
              result.interrupted
                ? 'Sent once the answer before it finished, then stopped before it was answered.'
                : 'Sent as the next message once the answer it waited for finished.',
              result.nativeSession,
            );
          else this.settleSteer(runId, entry, 'cancelled', 'This message was stopped before it was sent.');
          settle.resolve(result);
          if (!result.interrupted) continue;
          this.cancelSteers(runId, 'The message before this one was stopped, so this message was not sent.');
        } catch (error) {
          const reason = error instanceof EngineError || error instanceof HarnessError ? error.message : 'It could not be sent.';
          this.settleSteer(runId, entry, 'rejected', reason.slice(0, 2000), null, error);
          this.cancelSteers(runId, 'The message before this one could not be sent, so this message was not sent.');
        }
        this.draining.delete(runId);
        break;
      }
      // From here it is the running turn: a Stop stops it, and nothing withdraws it.
      entry.sending = true;
      try {
        const input: TextRequest = {
          ...base.input,
          requestId: entry.commandId,
          prompt: entry.text,
          documents: [],
          binding: undefined,
          interaction: undefined,
          carriedFrom: undefined,
          signal: undefined,
          onPreview: undefined,
          onActivity: undefined,
        };
        const result = await this.request({
          ...base,
          mode: 'follow-up',
          // Live previews stay with the message a caller is watching; this turn's answer is
          // read from its durable record like any other.
          preview: undefined,
          input,
        });
        if (result.response && !result.interrupted) {
          let detail = 'Sent as the next message once the answer it waited for finished.';
          // Shown in the conversation before it reads delivered, so the thread holds what the
          // native session holds. It was sent either way; a failed projection is said, not hidden.
          if (entry.onDelivered)
            await entry.onDelivered(result, input).catch(() => {
              detail = `${detail} It could not be added to the conversation view.`;
            });
          this.settleSteer(runId, entry, 'delivered', detail, result.nativeSession);
        } else {
          this.settleSteer(runId, entry, 'cancelled', 'This message was stopped before it was answered.');
          this.cancelSteers(runId, 'The message before this one was stopped, so this message was not sent.');
          this.draining.delete(runId);
          break;
        }
      } catch (error) {
        const reason = error instanceof EngineError || error instanceof HarnessError ? error.message : 'It could not be sent.';
        this.settleSteer(runId, entry, 'rejected', reason.slice(0, 2000));
        this.cancelSteers(runId, 'The message before this one could not be sent, so this message was not sent.');
        this.draining.delete(runId);
        break;
      }
    }
    if (this.closed) this.cancelSteers(runId, 'Diomedes closed before this message was sent.');
  }
  async recover(run: HarnessRun) {
    if (run.capabilityId !== this.profile.capability.id || terminal(run)) return;
    const principal = localHarnessPrincipal(run.projectId);
    await this.runs.recover(run.id, principal);
    const decide = this.profile.recoverInterrupted;
    if (!decide) return;
    // Reconciled from the durable record alone (the H01 rule): the saved checkpoint and the
    // event cursor. Nothing is asked of the provider here and nothing is resent.
    const recovered = await this.runs.get(run.id);
    const saved = this.checkpoint(recovered);
    if (recovered.state !== 'reconcile_required' || saved?.state !== 'busy') return;
    const interrupted = recovered.steps.find(
      (step) => step.state === 'reconcile_required' && step.intent.stepId.startsWith('turn:'),
    );
    const requestId = (interrupted?.intent.input as { requestId?: unknown } | undefined)?.requestId;
    const decision = decide(saved, typeof requestId === 'string' ? requestId : null);
    if ('refuse' in decision) {
      await this.runs.cancel(run.id, decision.refuse, principal);
      return;
    }
    const { afterSeq } = await this.runs.reconcileInterrupted(
      run.id,
      principal,
      'Diomedes restarted during this turn. Its answer was not recorded and it was not resent.',
    );
    await this.runs.claim(run.id, this.owner, 60_000);
    await this.runs.step(
      run.id,
      this.owner,
      {
        id: `${RECOVER_PREFIX}${afterSeq}`,
        version: '1',
        kind: 'tool',
        effect: 'read',
        name: `${this.profile.label} restart reconciliation`,
        input: {
          afterSeq,
          interruptedRequestId: typeof requestId === 'string' ? requestId : null,
          nativeSessionId: saved.nativeSessionId,
        },
        destination: 'local',
        cost: 0,
        maxAttempts: 1,
      },
      async (context) => {
        await context.saveNativeCheckpoint!({
          v: 1,
          providerId: this.profile.engine,
          payload: decision.resume as unknown as Json,
        });
        return { resumable: true, afterSeq };
      },
      principal,
    );
    await this.park(run.id, run.projectId, `recovered.${afterSeq}`);
  }
  async closeAll() {
    this.closed = true;
    for (const runId of this.steers.keys())
      this.cancelSteers(runId, 'Diomedes closed before this message was sent.');
    for (const active of this.active.values()) active.controller.abort();
    const closed = await Promise.allSettled(
      [...this.connections].map(([runId, value]) => this.dispose(runId, value)),
    );
    await Promise.allSettled([...this.active.values()].map((value) => value.promise));
    await Promise.allSettled([...this.closing]);
    const failure = closed.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (this.cleanupFailures.length) throw this.cleanupFailures[0];
  }
}
