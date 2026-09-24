/**
 * The one authority for harness runs: state, dispatch, approvals and durable
 * events. Every native model or tool invocation passes through `step`, which
 * applies the mandatory policy, then the optional hooks, then claims the step
 * under the run's lease fence, reserves budget, runs the handler, and commits
 * the observation together with its event in one durable write.
 *
 * What this is not: a document writer (that stays `Store.writeRecorded`), an
 * engine adapter, a scheduler, or a security sandbox. Handlers are trusted
 * host code. Fencing protects the run record; an external effect that already
 * happened needs sink-specific protection or reconciliation, never a guess.
 */
import { randomBytes } from 'node:crypto';
import type { OriginSnapshot } from '../../shared/attribution.js';
import type {
  CapabilityManifest,
  Destination,
  Effect,
  EffectRecord,
  HarnessApproval,
  HarnessBudget,
  HarnessEvent,
  HarnessLabel,
  HarnessPrincipal,
  HarnessRun,
  Json,
  NativeCheckpoint,
  ProviderTranscriptRef,
  StepIntent,
  StepKind,
  StepRecord,
  ToolEffectClass,
} from '../../shared/harness.js';
import { HARNESS_CONTRACT_VERSION } from '../../shared/harness.js';
import {
  authorize,
  canonical,
  copy,
  digest,
  HarnessError,
  units,
  validateLabel,
  validatePrincipal,
} from './policy.js';
import { validateRunId, type RunStore } from './run-store.js';

export class Suspended extends Error {
  constructor(
    readonly reason: 'approval' | 'event',
    message: string,
  ) {
    super(message);
    this.name = 'Suspended';
  }
}

export interface StepDefinition {
  id: string;
  version: string;
  kind?: StepKind;
  effect?: Effect;
  name?: string | null;
  input?: Json;
  cost?: number;
  maxAttempts?: number;
  permission?: string | null;
  approval?: boolean;
  destination?: Destination;
  trustedInputRequired?: boolean;
  label?: HarnessLabel | null;
  /**
   * Host-only provenance for this step, from trustworthy adapter/runtime
   * metadata. Never derived from generated prose or a model-returned JSON
   * self-identification, never part of the intent hash, never a grant.
   * When given it is stored once and never overwritten by later calls.
   */
  origin?: OriginSnapshot;
  /**
   * H12: a typed tool's effect declaration. For every class but `pure`, an
   * effect intent is written in the same durable commit that starts the
   * attempt, before the handler runs, and its outcome is recorded against it.
   * Never part of the intent hash; `ToolRegistry.dispatch` supplies it.
   */
  effectRecord?: {
    tool: string;
    effectClass: ToolEffectClass;
    targets: string[];
    /** A host grant reference, recorded as `host:<ref>`. */
    authorization?: string;
  };
}
export interface StepContext {
  input: Json;
  idempotencyKey: string;
  attempt: number;
  /** The execution generation this attempt was started under. A preview or result that outlives it cannot claim the attempt's identity. */
  fence: number;
  signal: AbortSignal;
  /** Publish ephemeral output only while this exact attempt still owns a live lease. */
  publishPreview: (publish: () => void) => Promise<void>;
  /**
   * Host-only channel for runtime-reported provenance discovered during the
   * handler (for example a transcript model id). Host code calls this with
   * adapter/runtime metadata only; generated text is never parsed here.
   * The service persists the first snapshot and ignores later reports,
   * so replays never relabel an existing step.
   */
  reportOrigin?: (origin: OriginSnapshot) => void;
  /** Atomically saves bounded provider metadata under this exact running attempt. */
  saveNativeCheckpoint?: (checkpoint: NativeCheckpoint, signal?: AbortSignal) => Promise<void>;
}
export type StepHandler<T> = (context: StepContext) => Promise<T> | T;
export type HarnessHook = (context: {
  runId: string;
  step: StepIntent;
  principal: HarnessPrincipal;
}) => Promise<void> | void;

export interface StartInput {
  input?: Json;
  id?: string;
  tenantId: string;
  projectId: string;
  taskId?: string | null;
  sessionId?: string | null;
  capability: CapabilityManifest;
  principal: HarnessPrincipal;
  budget: HarnessBudget;
  /** When given, every tool the capability names must be registered. */
  tools?: { has(name: string): boolean };
}
export interface Decision {
  runId: string;
  stepId: string;
  decision: 'approved' | 'denied';
  decidedBy: string;
  ttlMs: number;
  /** Optional host deadline; IO/queue latency may shorten, never extend, this window. */
  expiresAt?: string;
}

const EFFECTS: Effect[] = ['pure', 'read', 'idempotent', 'non-idempotent'];
const KINDS: StepKind[] = ['model', 'tool', 'transform', 'approval', 'wait'];
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Host-supplied provenance only. Shape-checked here; the readableRun schema re-checks on read. */
function validateOrigin(origin: unknown): asserts origin is OriginSnapshot {
  const o = origin as Partial<OriginSnapshot> | null;
  if (!o || typeof o !== 'object' || o.protocolVersion !== 1)
    throw new HarnessError('invalid_origin', 'A step origin needs protocol version 1.');
  if (o.mode !== 'direct' && o.mode !== 'supervisor' && o.mode !== 'application')
    throw new HarnessError('invalid_origin', 'Unknown origin mode.');
  if (o.engine !== null && o.engine !== undefined) {
    const e = o.engine as { id?: unknown; version?: unknown };
    if (
      typeof e.id !== 'string' ||
      !e.id ||
      (e.version !== null && e.version !== undefined && typeof e.version !== 'string')
    )
      throw new HarnessError('invalid_origin', 'Invalid origin engine.');
  } else if (o.engine !== null && o.engine !== undefined)
    throw new HarnessError('invalid_origin', 'Invalid origin engine.');
  const m = o.model as { requested?: unknown; reported?: unknown; source?: unknown } | null;
  if (
    !m ||
    (m.source !== 'runtime' && m.source !== 'not-recorded') ||
    (m.requested !== null && m.requested !== undefined && typeof m.requested !== 'string') ||
    (m.reported !== null && m.reported !== undefined && typeof m.reported !== 'string')
  )
    throw new HarnessError('invalid_origin', 'Invalid origin model.');
  if (o.worker !== undefined) {
    const w = o.worker as { id?: unknown; name?: unknown };
    if (!w || typeof w.id !== 'string' || !w.id || typeof w.name !== 'string' || !w.name)
      throw new HarnessError('invalid_origin', 'Invalid origin worker.');
  }
  for (const key of ['producerId', 'executorId'] as const) {
    const v = (o as Record<string, unknown>)[key];
    if (v !== undefined && (typeof v !== 'string' || !v))
      throw new HarnessError('invalid_origin', `Invalid origin ${key}.`);
  }
  const route = (o as Record<string, unknown>).accountRoute;
  if (route !== undefined && route !== null && typeof route !== 'string')
    throw new HarnessError('invalid_origin', 'Invalid origin account route.');
}

// A provider read can disclose context, consume quota and finish remotely even
// when its acknowledgement is lost. Its effect remains read (no local write),
// but unknown dispatch is never safe to retry without provider reconciliation.
const needsReconciliation = (intent: StepIntent): boolean =>
  intent.effect === 'non-idempotent' ||
  (intent.kind === 'model' && intent.destination === 'external');

const CLASS_EFFECT: Record<ToolEffectClass, { effect: Effect; destinations: Destination[] }> = {
  pure: { effect: 'pure', destinations: ['local', 'external'] },
  read: { effect: 'read', destinations: ['local', 'external'] },
  'idempotent-write': { effect: 'idempotent', destinations: ['local'] },
  'non-idempotent-effect': { effect: 'non-idempotent', destinations: ['local'] },
  'external-send': { effect: 'non-idempotent', destinations: ['external'] },
};
const lastEffect = (step: StepRecord): EffectRecord | undefined => step.effects?.at(-1);
/** A recorded effect that changes the world: its interruption is uncertain whatever the effect. */
const changesWorld = (record: EffectRecord | undefined) =>
  record !== undefined && record.effectClass !== 'pure' && record.effectClass !== 'read';
/**
 * Whether an attempt that ended without an outcome (crash, takeover, cancel)
 * may have changed the world. H12: a recorded write, idempotent or not, is
 * never re-executed on a guess; the sink's reconciler or a person decides.
 */
const interruptedIsUncertain = (step: StepRecord): boolean =>
  needsReconciliation(step.intent) || changesWorld(lastEffect(step));

/**
 * What H08's Retry and Resume must not repeat: every recorded effect whose
 * outcome is uncertain, in a sentence a person can check against History.
 */
export function uncertainEffectsOf(run: HarnessRun): string[] {
  return run.steps.flatMap((step) => {
    const record = lastEffect(step);
    if (record?.status !== 'uncertain') return [];
    const where = record.targets.length ? record.targets.join(', ') : 'its destination';
    return [`The ${record.tool} effect on ${where} may have happened; its outcome was never recorded.`];
  });
}

type StartOutcome =
  | { cached: Json | null }
  | { suspended: 'approval' }
  | { blocked: string; code?: string }
  | { fence: number; attempt: number; key: string; signal: AbortSignal };

export class RunService {
  private hooks: HarnessHook[] = [];
  private queues = new Map<string, Promise<unknown>>();
  /** One in-flight identical write per key, so the same record is made once. See `join`. */
  private joined = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  private readonly clock: () => number;
  private readonly policyVersion: string;
  private readonly redact: (text: string) => string;
  private readonly checkpointValidator?: (checkpoint: NativeCheckpoint) => NativeCheckpoint;
  private readonly authorizeEgress?: (
    runId: string,
    intent: StepIntent,
    principal: HarnessPrincipal,
    phase: 'dispatch' | 'result',
  ) => Promise<void>;

  constructor(
    private readonly store: RunStore,
    options: {
      clock?: () => number;
      policyVersion?: string;
      /** Applied to every error message before it is persisted. The host passes its secret scrubber. */
      redact?: (text: string) => string;
      validateNativeCheckpoint?: (checkpoint: NativeCheckpoint) => NativeCheckpoint;
      /** Mandatory host grant check for external steps. Never exposed as a client capability. */
      authorizeEgress?: (
        runId: string,
        intent: StepIntent,
        principal: HarnessPrincipal,
        phase: 'dispatch' | 'result',
      ) => Promise<void>;
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.policyVersion = options.policyVersion ?? 'diomedes-policy-v1';
    this.redact = options.redact ?? ((text) => text);
    this.checkpointValidator = options.validateNativeCheckpoint;
    this.authorizeEgress = options.authorizeEgress;
  }

  private describeError(error: unknown): { name: string; message: string } {
    return {
      name: error instanceof Error ? this.redact(error.name).slice(0, 128) : 'Error',
      message: this.redact(error instanceof Error ? error.message : String(error)).slice(0, 2000),
    };
  }

  /** Optional hooks run after policy, in order, on deep copies. They cannot allow what policy denied. */
  use(hook: HarnessHook) {
    if (typeof hook !== 'function')
      throw new HarnessError('invalid_hook', 'A hook must be a function.');
    this.hooks.push(hook);
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  /** One writer per run inside this process, the same queue idea as `Store.locked`. */
  private serialize<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const result = previous.then(action, action);
    this.queues.set(
      runId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async load(runId: string): Promise<HarnessRun> {
    const run = await this.store.read(validateRunId(runId));
    if (!run) throw new HarnessError('unknown_run', `Unknown run: ${runId}.`);
    for (const step of run.steps)
      if (step.nativeCheckpoint !== undefined) this.validateCheckpoint(step.nativeCheckpoint);
    return run;
  }

  private validateCheckpoint(value: NativeCheckpoint): NativeCheckpoint {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.v !== 1 ||
      typeof value.providerId !== 'string' ||
      !/^[a-z0-9-]{1,80}$/.test(value.providerId) ||
      Object.keys(value).sort().join(',') !== 'payload,providerId,v' ||
      Buffer.byteLength(canonical(value), 'utf8') > 128 * 1024 ||
      !this.checkpointValidator
    )
      throw new HarnessError(
        'invalid_checkpoint',
        'Native checkpoint metadata is invalid or unsupported.',
      );
    return copy(this.checkpointValidator(copy(value)));
  }

  private note(
    run: HarnessRun,
    type: string,
    attributes: HarnessEvent['attributes'],
    stepId?: string,
    attempt?: number,
  ) {
    run.lastSeq += 1;
    run.events.push({
      v: HARNESS_CONTRACT_VERSION,
      seq: run.lastSeq,
      runId: run.id,
      at: this.now(),
      type,
      ...(stepId === undefined ? {} : { stepId }),
      ...(attempt === undefined ? {} : { attempt }),
      attributes,
    });
  }

  /**
   * Settle the open effect intent of an attempt that ended without an outcome:
   * `uncertain` when its step now waits for reconciliation, `abandoned` for a
   * read (which changed nothing) that will simply run again.
   */
  private settleInterrupted(run: HarnessRun, step: StepRecord, why: string) {
    const record = lastEffect(step);
    if (record?.status !== 'intended') return;
    record.status = step.state === 'reconcile_required' ? 'uncertain' : 'abandoned';
    record.outcomeAt = this.now();
    this.note(run, `effect.${record.status}`, { why, tool: record.tool }, step.intent.stepId, record.attempt);
  }

  private async commit(run: HarnessRun) {
    run.updatedAt = this.now();
    await this.store.write(run);
  }

  private guard(run: HarnessRun, owner: string, fence?: number) {
    if (
      run.owner !== owner ||
      (run.leaseExpiresAt ?? 0) <= this.clock() ||
      (fence !== undefined && fence !== run.fence)
    )
      throw new HarnessError('stale_lease', 'stale lease');
  }

  private scope(run: HarnessRun, principal: HarnessPrincipal) {
    validatePrincipal(principal);
    if (run.tenantId !== principal.tenantId)
      throw new HarnessError('tenant_mismatch', 'tenant mismatch');
    if (run.projectId !== principal.projectId)
      throw new HarnessError('project_mismatch', 'project mismatch');
  }

  private controller(runId: string) {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    return controller;
  }

  private intentOf(definition: StepDefinition): StepIntent {
    if (definition.origin !== undefined) validateOrigin(definition.origin);
    const d = {
      kind: 'tool' as StepKind,
      effect: 'pure' as Effect,
      cost: 0,
      maxAttempts: 3,
      approval: false,
      destination: 'local' as Destination,
      trustedInputRequired: false,
      ...definition,
    };
    // Provenance never enters the intent hash: the intent below copies only
    // authority fields, so v1 approvals stay bound to the exact intent while
    // origin stays alongside.
    if (
      typeof d.id !== 'string' ||
      !STEP_ID.test(d.id) ||
      typeof d.version !== 'string' ||
      !d.version
    )
      throw new HarnessError('invalid_step', 'A stable step id and version are required.');
    if (!EFFECTS.includes(d.effect)) throw new HarnessError('invalid_step', 'Unknown effect.');
    if (!KINDS.includes(d.kind)) throw new HarnessError('invalid_step', 'Unknown step kind.');
    units(d.cost, 'Step cost');
    if (units(d.maxAttempts, 'Attempt limit') === 0)
      throw new HarnessError('invalid_step', 'A positive attempt limit is required.');
    if (d.label != null) validateLabel(d.label);
    if (definition.effectRecord !== undefined) {
      const declared = definition.effectRecord;
      const allowed = CLASS_EFFECT[declared?.effectClass as ToolEffectClass];
      if (
        !allowed ||
        allowed.effect !== d.effect ||
        !allowed.destinations.includes(d.destination) ||
        d.kind !== 'tool' ||
        typeof declared.tool !== 'string' ||
        !declared.tool ||
        !Array.isArray(declared.targets) ||
        !declared.targets.every((target) => typeof target === 'string' && target) ||
        (declared.authorization !== undefined && (typeof declared.authorization !== 'string' || !declared.authorization))
      )
        throw new HarnessError('invalid_step', 'The effect declaration does not match the step.');
    }
    const intent: StepIntent = {
      stepId: d.id,
      stepVersion: d.version,
      kind: d.kind,
      effect: d.effect,
      name: d.name ?? null,
      input: copy(d.input ?? null),
      cost: d.cost,
      maxAttempts: d.maxAttempts,
      permission: d.permission ?? null,
      approval: d.approval === true,
      destination: d.destination,
      trustedInputRequired: d.trustedInputRequired === true,
      label: d.label == null ? null : copy(d.label),
      policyVersion: this.policyVersion,
    };
    return copy(intent);
  }

  private ensure(run: HarnessRun, intent: StepIntent, origin?: OriginSnapshot): StepRecord {
    const intentHash = digest(intent);
    const existing = run.steps.find((s) => s.intent.stepId === intent.stepId);
    if (existing) {
      if (existing.intentHash !== intentHash)
        throw new HarnessError('intent_mismatch', 'step intent mismatch; fork instead');
      // Replays never reinterpret: an existing snapshot wins, a legacy record
      // without one stays unknown rather than inventing provenance.
      return existing;
    }
    const record: StepRecord = {
      intent,
      intentHash,
      attempt: 0,
      state: 'pending',
      output: null,
      outputHash: null,
      ...(origin === undefined ? {} : { origin: copy(origin) }),
      leaseFence: 0,
      startedAt: null,
      endedAt: null,
      error: null,
    };
    run.steps.push(record);
    return record;
  }

  async start(input: StartInput): Promise<HarnessRun> {
    validatePrincipal(input.principal);
    const { capability, budget } = input;
    if (!capability || typeof capability.id !== 'string' || !capability.id || !capability.version)
      throw new HarnessError('invalid_capability', 'A capability id and version are required.');
    for (const key of ['units', 'modelCalls', 'toolCalls'] as const)
      units(budget?.[key], `Budget ${key}`);
    if (budget.wallMs !== null) units(budget.wallMs, 'Budget wallMs');
    if (units(capability.maxTurns, 'Capability maxTurns') === 0)
      throw new HarnessError('invalid_capability', 'A positive turn limit is required.');
    for (const key of ['tools', 'requestedPermissions'] as const) {
      const list = capability[key];
      if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && item))
        throw new HarnessError('invalid_capability', `Capability ${key} must be a list of names.`);
    }
    const missing = capability.requestedPermissions.filter(
      (p) => !input.principal.capabilities.includes(p),
    );
    if (missing.length)
      throw new HarnessError(
        'missing_capability',
        `The capability asks for a permission this principal does not hold: ${missing.join(', ')}.`,
      );
    if (input.tools)
      for (const name of capability.tools)
        if (!input.tools.has(name))
          throw new HarnessError('unknown_tool', `Unknown tool named by the capability: ${name}.`);
    if (
      input.tenantId !== input.principal.tenantId ||
      input.projectId !== input.principal.projectId
    )
      throw new HarnessError(
        'scope_mismatch',
        'The principal does not belong to this tenant and project.',
      );
    const id =
      input.id === undefined ? `R${randomBytes(6).toString('hex')}` : validateRunId(input.id);
    const at = this.now();
    const run: HarnessRun = {
      v: HARNESS_CONTRACT_VERSION,
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      capabilityTools: [...new Set(capability.tools)],
      policyVersion: this.policyVersion,
      principal: copy(input.principal),
      ...(input.input === undefined ? {} : { input: copy(input.input) }),
      state: 'queued',
      budget: copy(budget),
      used: { units: 0, modelCalls: 0, toolCalls: 0 },
      owner: null,
      fence: 0,
      leaseExpiresAt: null,
      parentRunId: null,
      forkPoint: null,
      contextRevision: 1,
      transcripts: {},
      result: null,
      failure: null,
      cancelReason: null,
      createdAt: at,
      updatedAt: at,
      steps: [],
      approvals: [],
      events: [],
      lastSeq: 0,
    };
    this.note(run, 'run.created', {
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      taskId: run.taskId,
    });
    await this.store.create(run);
    return copy(run);
  }

  async get(runId: string): Promise<HarnessRun> {
    return this.load(runId);
  }

  /**
   * Hold one run's writer queue while the caller commits a child of it, and hand it this run
   * as it stands inside that queue. A settled run is refused there, where `cancel`, a failed
   * step, a denial and startup recovery are decided too, so each of those is ordered either
   * before this refusal or after the commit it protects, never between the two.
   *
   * This is process-local ordering, not crash recovery. The callback must not claim, record,
   * step, cancel or fence this run: it would wait on the queue it is already holding. It must
   * await no provider, no person and no background work, and it must already hold whatever
   * outer lock its own commit needs, because that lock is never taken under this one.
   *
   * Nothing here is particular to one runtime: a driver supplies its own run id and adds its
   * own capability scope inside the callback.
   */
  async fence<T>(
    runId: string,
    principal: HarnessPrincipal,
    action: (run: HarnessRun) => Promise<T>,
  ): Promise<T> {
    return this.serialize(runId, async () => {
      const run = await this.load(runId);
      this.scope(run, principal);
      if (['completed', 'cancelled', 'failed', 'reconcile_required'].includes(run.state))
        throw new HarnessError('run_settled', 'This run is settled and admits nothing further.');
      return action(copy(run));
    });
  }

  /**
   * One in-flight call per key, so two callers asking for the same immutable write are one
   * write and the second reads the first's result rather than meeting it in flight. The key
   * is the caller's own: a run and a digest of what is being written.
   */
  join<T>(key: string, action: () => Promise<T>): Promise<T> {
    const joined = this.joined.get(key);
    if (joined) return joined as Promise<T>;
    const running = action().finally(() => {
      if (this.joined.get(key) === running) this.joined.delete(key);
    });
    this.joined.set(key, running);
    return running;
  }

  async events(runId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    units(afterSeq, 'The event cursor');
    return (await this.load(runId)).events.filter((e) => e.seq > afterSeq);
  }

  /**
   * Called only during exclusive host startup, after Store journal recovery and
   * before dispatch. Invalidate the dead process's lease without a timer. Safe
   * effects may retry through their sink's idempotency receipt; unknown effects
   * stay parked. This method is never exposed as an HTTP action.
   */
  async recover(runId: string, principal: HarnessPrincipal): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      this.scope(run, principal);
      if (!['running', 'queued', 'waiting'].includes(run.state)) return;
      run.owner = null;
      run.leaseExpiresAt = null;
      run.fence += 1;
      for (const step of run.steps) {
        if (step.state !== 'running') continue;
        step.state = interruptedIsUncertain(step) ? 'reconcile_required' : 'retry_wait';
        this.note(
          run,
          `step.${step.state}`,
          { why: 'exclusive host startup' },
          step.intent.stepId,
          step.attempt,
        );
        this.settleInterrupted(run, step, 'exclusive host startup');
      }
      run.state = run.steps.some((step) => step.state === 'reconcile_required')
        ? 'reconcile_required'
        : run.steps.some((step) => step.state === 'waiting_approval')
          ? 'waiting'
          : 'queued';
      this.note(run, 'run.recovered', { fence: run.fence });
      await this.commit(run);
      this.controllers.get(runId)?.abort(new HarnessError('stale_lease', 'stale lease'));
      this.controllers.delete(runId);
    });
  }

  /**
   * Reconcile, from the durable record alone, a run whose only unknown outcome is a
   * restart-interrupted conversation turn that touched nothing but the provider's
   * own record (H05): an external model step with a `read` effect. Each such step
   * is recorded `cancelled` — not completed and never resent — with the event
   * cursor the decision was taken at, and the run returns to `queued` for its
   * driver. Any other parked step refuses the whole reconciliation, unchanged.
   * Startup-only, like `recover`.
   */
  async reconcileInterrupted(
    runId: string,
    principal: HarnessPrincipal,
    why: string,
  ): Promise<{ afterSeq: number; steps: string[] }> {
    return this.serialize(runId, async () => {
      const run = await this.load(runId);
      this.scope(run, principal);
      if (run.state !== 'reconcile_required')
        throw new HarnessError('not_reconcilable', 'Only a run parked for reconciliation can be reconciled.');
      const parked = run.steps.filter((step) => step.state === 'reconcile_required');
      if (
        !parked.length ||
        parked.some(
          (step) =>
            step.intent.kind !== 'model' ||
            step.intent.destination !== 'external' ||
            step.intent.effect !== 'read',
        )
      )
        throw new HarnessError(
          'not_reconcilable',
          'Only an interrupted read-only provider turn can be reconciled from the record.',
        );
      const afterSeq = run.lastSeq;
      for (const step of parked) {
        step.state = 'cancelled';
        step.endedAt = this.now();
        this.note(
          run,
          'step.cancelled',
          { why: this.redact(why), afterSeq, resent: false },
          step.intent.stepId,
          step.attempt,
        );
      }
      run.state = 'queued';
      this.note(run, 'run.recovered', { fence: run.fence, reconciled: parked.length });
      await this.commit(run);
      return { afterSeq, steps: parked.map((step) => step.intent.stepId) };
    });
  }

  /** Take or renew the run's lease. A live lease held by someone else is refused. */
  /**
   * `refuseSettled` makes the claim conditional on the run still being live, decided inside
   * this run's own queue, where `cancel` is decided too. A caller that inspected the run and
   * then claims it cannot have a cancellation land between the two and still take the lease.
   */
  async claim(
    runId: string,
    owner: string,
    ttlMs = 60_000,
    options: { refuseSettled?: boolean } = {},
  ): Promise<number> {
    if (!owner || typeof owner !== 'string' || units(ttlMs, 'Lease TTL') === 0)
      throw new HarnessError('invalid_lease', 'An owner and a positive TTL are required.');
    return this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (
        options.refuseSettled &&
        ['completed', 'cancelled', 'failed', 'reconcile_required'].includes(run.state)
      )
        throw new HarnessError('run_settled', 'This run is settled and cannot be claimed.');
      const live = (run.leaseExpiresAt ?? 0) > this.clock();
      if (run.owner && run.owner !== owner && live)
        throw new HarnessError('lease_busy', 'lease busy');
      // A live owner renewing its own lease keeps the fence: the generation
      // changes only when ownership does, so an in-flight step can still commit.
      const renewal = run.owner === owner && live;
      if (!renewal) run.fence += 1;
      run.owner = owner;
      run.leaseExpiresAt = this.clock() + ttlMs;
      if (run.state === 'queued') run.state = 'running';
      this.note(run, renewal ? 'run.lease_renewed' : 'run.claimed', {
        owner,
        fence: run.fence,
        expiresAt: run.leaseExpiresAt,
      });
      await this.commit(run);
      if (!renewal) {
        this.controllers.get(runId)?.abort(new HarnessError('stale_lease', 'stale lease'));
        this.controllers.delete(runId);
      }
      return run.fence;
    });
  }

  /**
   * Execute one step. Completed steps return their persisted observation and
   * never invoke the handler again. A changed intent is refused. An unknown
   * non-idempotent outcome parks the run for reconciliation.
   */
  async step<T = Json>(
    runId: string,
    owner: string,
    definition: StepDefinition,
    handler: StepHandler<T>,
    principal: HarnessPrincipal,
  ): Promise<T> {
    this.scope(await this.load(runId), principal);
    const intent = this.intentOf(definition);
    const checkPolicy = (phase: 'dispatch' | 'result' = 'dispatch') =>
      authorize(
        intent,
        principal,
        this.authorizeEgress
          ? () => this.authorizeEgress!(runId, copy(intent), copy(principal), phase)
          : undefined,
      );
    await checkPolicy();
    for (const hook of this.hooks)
      await hook({ runId, step: copy(intent), principal: copy(principal) });
    await checkPolicy();

    const start: StartOutcome = await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (run.state === 'cancelled')
        throw new HarnessError(
          'run_cancelled',
          `This run was cancelled: ${run.cancelReason ?? ''}`.trim(),
        );
      this.guard(run, owner);
      const before = run.steps.length;
      const s = this.ensure(run, intent, definition.origin);
      let changed = run.steps.length !== before;
      const finish = async (outcome: StartOutcome) => {
        // A replayed observation is a read; only a new record or a state change is written.
        if (changed) await this.commit(run);
        return outcome;
      };
      if (s.state === 'succeeded') return finish({ cached: s.output });
      if (s.state === 'cancelled')
        throw new HarnessError('step_cancelled', 'This step was cancelled.');
      const uncertain = (): StartOutcome =>
        lastEffect(s)?.status === 'uncertain'
          ? {
              blocked: `reconciliation required: the ${lastEffect(s)!.tool} effect may already have happened`,
              code: 'effect_uncertain',
            }
          : { blocked: 'reconciliation required' };
      if (s.state === 'reconcile_required') return finish(uncertain());
      if (s.state === 'running' && s.leaseFence === run.fence)
        return finish({ blocked: 'step already in flight' });
      changed = true;
      if (s.state === 'running' && interruptedIsUncertain(s)) {
        s.state = 'reconcile_required';
        run.state = 'reconcile_required';
        this.note(
          run,
          'step.reconcile_required',
          { why: 'ownership changed while running' },
          s.intent.stepId,
          s.attempt,
        );
        this.settleInterrupted(run, s, 'ownership changed while running');
        return finish(uncertain());
      }
      if (s.state === 'running') this.settleInterrupted(run, s, 'ownership changed while running');
      if (s.attempt >= intent.maxAttempts) {
        changed = false;
        return finish({ blocked: 'attempt limit reached' });
      }
      const declared = definition.effectRecord;
      let authorizedBy = declared?.authorization
        ? `host:${declared.authorization}`
        : intent.permission
          ? `permission:${intent.permission}`
          : 'none';
      if (intent.approval) {
        const now = this.clock();
        const approval = run.approvals.find(
          (a) =>
            a.stepId === intent.stepId &&
            a.decision === 'approved' &&
            a.intentHash === s.intentHash &&
            a.identityGeneration === principal.identityGeneration &&
            Date.parse(a.expiresAt) > now,
        );
        if (!approval) {
          s.state = 'waiting_approval';
          run.state = 'waiting';
          this.note(
            run,
            'step.waiting_approval',
            { intentHash: s.intentHash },
            s.intent.stepId,
            s.attempt,
          );
          return finish({ suspended: 'approval' });
        }
        approval.consumedAt ??= this.now();
        authorizedBy = `approval:${approval.intentHash}`;
      }
      const blockedBy =
        intent.cost > run.budget.units - run.used.units
          ? 'budget exceeded'
          : intent.kind === 'model' && run.used.modelCalls >= run.budget.modelCalls
            ? 'budget exceeded: model calls'
            : intent.kind === 'tool' && run.used.toolCalls >= run.budget.toolCalls
              ? 'budget exceeded: tool calls'
              : null;
      if (blockedBy) {
        changed = run.steps.length !== before;
        return finish({ blocked: blockedBy });
      }
      run.used.units += intent.cost;
      if (intent.kind === 'model') run.used.modelCalls += 1;
      if (intent.kind === 'tool') run.used.toolCalls += 1;
      s.state = 'running';
      s.attempt += 1;
      s.leaseFence = run.fence;
      s.startedAt = this.now();
      s.endedAt = null;
      s.error = null;
      run.state = 'running';
      this.note(
        run,
        'step.started',
        { fence: run.fence, reservedUnits: intent.cost, effect: intent.effect },
        s.intent.stepId,
        s.attempt,
      );
      const key = digest({ runId, stepId: intent.stepId, intentHash: s.intentHash });
      if (declared && declared.effectClass !== 'pure') {
        // The effect intent, durable in this same commit, before the handler can run.
        const record: EffectRecord = {
          v: 1,
          tool: declared.tool,
          effectClass: declared.effectClass,
          attempt: s.attempt,
          inputsDigest: digest(intent.input),
          targets: [...declared.targets],
          idempotencyKey: key,
          principalId: principal.id,
          identityGeneration: principal.identityGeneration,
          authorization: authorizedBy,
          status: 'intended',
          intendedAt: this.now(),
          outcomeAt: null,
          outputHash: null,
          error: null,
          reconciliation: null,
        };
        (s.effects ??= []).push(record);
        this.note(
          run,
          'effect.intended',
          { tool: record.tool, effectClass: record.effectClass, inputsDigest: record.inputsDigest, targets: record.targets, authorization: record.authorization },
          s.intent.stepId,
          s.attempt,
        );
      }
      return finish({
        fence: run.fence,
        attempt: s.attempt,
        key,
        signal: this.controller(runId).signal,
      });
    });

    if ('cached' in start) return start.cached as T;
    if ('suspended' in start) throw new Suspended('approval', 'approval required');
    if ('blocked' in start) throw new HarnessError(start.code ?? 'blocked', start.blocked);

    const signal = start.signal;
    let closed = false;
    const publishPreview = (publish: () => void): Promise<void> =>
      this.serialize(runId, async () => {
        if (closed || signal.aborted) return;
        const run = await this.load(runId);
        try {
          this.guard(run, owner, start.fence);
        } catch (error) {
          if (error instanceof HarnessError && error.code === 'stale_lease') return;
          throw error;
        }
        const step = run.steps.find((item) => item.intent.stepId === intent.stepId);
        if (
          closed ||
          signal.aborted ||
          run.state !== 'running' ||
          step?.state !== 'running' ||
          step.attempt !== start.attempt ||
          step.leaseFence !== start.fence
        )
          return;
        // Check and synchronous publication share the same ownership queue.
        // Preview text never causes a run-store write or a durable event.
        publish();
      });
    let reportedOrigin: OriginSnapshot | undefined;
    const reportOrigin = (origin: OriginSnapshot) => {
      validateOrigin(origin);
      // First report wins within one attempt; replays never reach the handler.
      reportedOrigin ??= copy(origin);
    };
    const saveNativeCheckpoint = (
      checkpoint: NativeCheckpoint,
      writeSignal?: AbortSignal,
    ): Promise<void> =>
      this.serialize(runId, async () => {
        const run = await this.load(runId);
        this.guard(run, owner, start.fence);
        const step = run.steps.find((item) => item.intent.stepId === intent.stepId);
        if (
          closed ||
          signal.aborted ||
          run.state !== 'running' ||
          step?.state !== 'running' ||
          step.attempt !== start.attempt ||
          step.leaseFence !== start.fence
        )
          throw new HarnessError(
            'stale_attempt',
            'A settled or replaced attempt cannot save checkpoint metadata.',
          );
        if (writeSignal?.aborted)
          throw new HarnessError('stale_attempt', 'This checkpoint callback expired.');
        const validated = this.validateCheckpoint(checkpoint);
        step.nativeCheckpoint = validated;
        this.note(
          run,
          'step.checkpointed',
          { providerId: validated.providerId, checkpointHash: digest(validated) },
          step.intent.stepId,
          step.attempt,
        );
        await this.commit(run);
      });
    try {
      signal.throwIfAborted();
      await checkPolicy();
      const output = await handler({
        input: copy(intent.input),
        idempotencyKey: start.key,
        attempt: start.attempt,
        fence: start.fence,
        signal,
        publishPreview,
        reportOrigin,
        saveNativeCheckpoint,
      });
      closed = true;
      const encoded = canonical(output);
      await checkPolicy('result');
      await this.serialize(runId, async () => {
        const run = await this.load(runId);
        this.guard(run, owner, start.fence);
        const s = run.steps.find((item) => item.intent.stepId === intent.stepId)!;
        if (s.state !== 'running' || s.attempt !== start.attempt)
          throw new HarnessError('stale_attempt', 'stale attempt');
        s.state = 'succeeded';
        s.output = JSON.parse(encoded) as Json;
        s.outputHash = digest(s.output);
        // Immutable provenance: only a step without a snapshot gains one, from
        // the host-only channel (definition first, handler report second).
        // Generated output never sets it; a replay never reaches this commit.
        if (s.origin === undefined) {
          const first = reportedOrigin ?? definition.origin;
          if (first !== undefined) {
            validateOrigin(first);
            s.origin = copy(first);
          }
        }
        s.endedAt = this.now();
        this.note(run, 'step.succeeded', { outputHash: s.outputHash }, s.intent.stepId, s.attempt);
        const record = lastEffect(s);
        if (record?.status === 'intended' && record.attempt === s.attempt) {
          record.status = 'applied';
          record.outcomeAt = s.endedAt;
          record.outputHash = s.outputHash;
          this.note(run, 'effect.applied', { tool: record.tool, outputHash: record.outputHash }, s.intent.stepId, s.attempt);
        }
        await this.commit(run);
      });
      return JSON.parse(encoded) as T;
    } catch (error) {
      closed = true;
      // Takeover is an unknown provider outcome, not a user cancellation.
      // Preserve that distinction even if the transport reports AbortError.
      if (
        signal.aborted &&
        signal.reason instanceof HarnessError &&
        signal.reason.code === 'stale_lease'
      )
        throw signal.reason;
      // A replaced owner cannot record a failure either: recovery sees the last
      // durable running record and reconciles any unknown irreversible effect.
      try {
        await this.serialize(runId, async () => {
          const run = await this.load(runId);
          this.guard(run, owner, start.fence);
          const s = run.steps.find((item) => item.intent.stepId === intent.stepId)!;
          if (s.state !== 'running' || s.attempt !== start.attempt) return;
          const waiting =
            error instanceof Suspended &&
            error.reason === 'event' &&
            intent.kind === 'wait' &&
            intent.effect === 'pure' &&
            intent.destination === 'local';
          // A write that timed out may still be finishing: its outcome is not known.
          const timedOut =
            changesWorld(lastEffect(s)) && error instanceof HarnessError && error.code === 'tool_timeout';
          const state = waiting
            ? 'waiting_event'
            : needsReconciliation(intent) || timedOut
              ? 'reconcile_required'
              : 'retry_wait';
          s.state = state;
          s.endedAt = this.now();
          s.error = this.describeError(error);
          const record = lastEffect(s);
          if (record?.status === 'intended' && record.attempt === s.attempt) {
            record.status = state === 'reconcile_required' ? 'uncertain' : 'failed';
            record.outcomeAt = s.endedAt;
            record.error = s.error.message;
            this.note(run, `effect.${record.status}`, { tool: record.tool, errorType: s.error.name }, s.intent.stepId, s.attempt);
          }
          // A failed attempt keeps dispatch-time provenance when the step has
          // none yet; runtime-reported details wait for a successful attempt.
          if (s.origin === undefined && definition.origin !== undefined) {
            validateOrigin(definition.origin);
            s.origin = copy(definition.origin);
          }
          if (state === 'reconcile_required') run.state = 'reconcile_required';
          if (state === 'waiting_event') run.state = 'waiting';
          this.note(run, `step.${state}`, { errorType: s.error.name }, s.intent.stepId, s.attempt);
          await this.commit(run);
        });
      } catch (fencing) {
        if (!(fencing instanceof HarnessError && fencing.code === 'stale_lease')) throw fencing;
      }
      throw error;
    }
  }

  /** Answer a step that is waiting for approval. Binds the decision to the exact intent, the current identity generation and an expiry. */
  async decide(decision: Decision, principal: HarnessPrincipal): Promise<HarnessApproval> {
    if (!decision.decidedBy || typeof decision.decidedBy !== 'string')
      throw new HarnessError('invalid_decision', 'Say who decided.');
    if (decision.decision !== 'approved' && decision.decision !== 'denied')
      throw new HarnessError('invalid_decision', 'A decision is approved or denied.');
    if (units(decision.ttlMs, 'Approval TTL') === 0)
      throw new HarnessError('invalid_decision', 'A positive approval TTL is required.');
    const deadline = Math.min(
      this.clock() + decision.ttlMs,
      decision.expiresAt === undefined ? Infinity : Date.parse(decision.expiresAt),
    );
    if (!Number.isFinite(deadline))
      throw new HarnessError('invalid_decision', 'A valid approval deadline is required.');
    return this.serialize(decision.runId, async () => {
      const run = await this.load(decision.runId);
      this.scope(run, principal);
      const s = run.steps.find((item) => item.intent.stepId === decision.stepId);
      if (!s || s.state !== 'waiting_approval')
        throw new HarnessError('not_waiting', 'Step is not waiting for approval.');
      const now = this.clock();
      if (now >= deadline)
        throw new HarnessError(
          'approval_expired',
          'The approval window expired before its decision could be saved.',
        );
      // The approval binds to the authority current at decision time: the
      // deciding principal's generation. A step consumes it only under that
      // same generation, so a rotation needs a fresh decision, and a fresh
      // decision after a rotation is consumable.
      const approval: HarnessApproval = {
        runId: run.id,
        stepId: s.intent.stepId,
        intentHash: s.intentHash,
        principalId: principal.id,
        identityGeneration: principal.identityGeneration,
        executionGeneration: run.fence,
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        decidedAt: this.now(),
        expiresAt: new Date(deadline).toISOString(),
        consumedAt: null,
      };
      run.approvals = run.approvals.filter((a) => a.stepId !== s.intent.stepId);
      run.approvals.push(approval);
      this.note(
        run,
        'approval.decided',
        {
          decision: approval.decision,
          intentHash: approval.intentHash,
          expiresAt: approval.expiresAt,
          decidedBy: approval.decidedBy,
        },
        s.intent.stepId,
        s.attempt,
      );
      if (decision.decision === 'approved') {
        s.state = 'pending';
      } else {
        s.state = 'cancelled';
        s.endedAt = this.now();
        run.state = 'cancelled';
        run.cancelReason = 'approval denied';
        this.note(run, 'run.cancelled', { reason: run.cancelReason });
        this.controllers.get(run.id)?.abort();
      }
      await this.commit(run);
      return copy(approval);
    });
  }

  /**
   * Stop a run. A step that is running with an effect on the world keeps an
   * unknown outcome: it is parked for reconciliation, never relabelled as
   * cancelled, and the presentation says so. The abort signal is advisory; a
   * handler that ignores it cannot commit afterwards because its step is no
   * longer `running`.
   */
  async cancel(runId: string, reason: string, principal?: HarnessPrincipal): Promise<void> {
    reason = this.redact(reason);
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (principal) this.scope(run, principal);
      if (run.state === 'completed' || run.state === 'cancelled') return;
      run.state = 'cancelled';
      run.cancelReason = reason;
      for (const s of run.steps) {
        if (s.state === 'running' && interruptedIsUncertain(s)) {
          s.state = 'reconcile_required';
          s.endedAt = this.now();
          this.note(
            run,
            'step.reconcile_required',
            { why: 'cancelled while running' },
            s.intent.stepId,
            s.attempt,
          );
          this.settleInterrupted(run, s, 'cancelled while running');
        } else if (
          ['running', 'pending', 'waiting_approval', 'waiting_event', 'retry_wait'].includes(
            s.state,
          )
        ) {
          const wasRunning = s.state === 'running';
          s.state = 'cancelled';
          s.endedAt = this.now();
          if (wasRunning) this.settleInterrupted(run, s, 'cancelled while running');
        }
      }
      this.note(run, 'run.cancelled', { reason });
      await this.commit(run);
    });
    this.controllers.get(runId)?.abort();
    this.controllers.delete(runId);
  }

  /**
   * H12: settle an uncertain effect on evidence. `applied` settles the step as
   * done (its handler never runs again); `not-applied` lets it run once more
   * under the same idempotency key, as a new attempt with a new intent record.
   * The uncertain record keeps who reconciled it and on what evidence; nothing
   * is rewritten. A run parked only for this step becomes queued again, unless
   * it was cancelled.
   */
  async reconcileEffect(
    runId: string,
    stepId: string,
    answer: { resolution: 'applied' | 'not-applied'; by: string; evidence: string; output?: Json },
    principal: HarnessPrincipal,
  ): Promise<EffectRecord> {
    if (answer.resolution !== 'applied' && answer.resolution !== 'not-applied')
      throw new HarnessError('invalid_reconciliation', 'A reconciliation is applied or not-applied.');
    for (const key of ['by', 'evidence'] as const)
      if (typeof answer[key] !== 'string' || !answer[key].trim() || answer[key].length > 2000)
        throw new HarnessError('invalid_reconciliation', `Say ${key === 'by' ? 'who reconciled' : 'on what evidence'}.`);
    return this.serialize(runId, async () => {
      const run = await this.load(runId);
      this.scope(run, principal);
      const s = run.steps.find((item) => item.intent.stepId === stepId);
      const record = s ? lastEffect(s) : undefined;
      if (!s || !record || record.status !== 'uncertain' || s.state !== 'reconcile_required')
        throw new HarnessError('not_uncertain', 'This step has no uncertain effect to reconcile.');
      const at = this.now();
      record.status = answer.resolution === 'applied' ? 'reconciled-applied' : 'reconciled-not-applied';
      record.reconciliation = { by: this.redact(answer.by), evidence: this.redact(answer.evidence), at };
      if (answer.resolution === 'applied') {
        s.state = 'succeeded';
        s.output = copy(answer.output ?? { reconciled: 'applied', evidence: record.reconciliation.evidence });
        s.outputHash = digest(s.output);
        s.error = null;
      } else {
        s.state = 'retry_wait';
      }
      s.endedAt = at;
      this.note(
        run,
        'effect.reconciled',
        { tool: record.tool, resolution: answer.resolution, by: record.reconciliation.by },
        stepId,
        record.attempt,
      );
      if (run.state === 'reconcile_required' && !run.steps.some((item) => item.state === 'reconcile_required')) {
        run.state = 'queued';
        this.note(run, 'run.reconciled', { stepId });
      }
      await this.commit(run);
      return copy(record);
    });
  }

  /** Record the run's result and its completion event in one write. Idempotent once completed. */
  async complete(runId: string, owner: string, result: Json): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (run.state === 'completed') return;
      if (run.state === 'cancelled')
        throw new HarnessError('run_cancelled', 'This run was cancelled and cannot complete.');
      if (
        run.state === 'reconcile_required' ||
        run.steps.some((s) => s.state === 'reconcile_required')
      )
        throw new HarnessError(
          'reconcile_required',
          'A step needs reconciliation before this run can complete.',
        );
      this.guard(run, owner);
      if (run.steps.some((s) => s.state === 'running'))
        throw new HarnessError('step_running', 'A step is still running.');
      run.state = 'completed';
      run.result = copy(result);
      this.note(run, 'run.completed', { resultHash: digest(run.result) });
      await this.commit(run);
    });
    this.controllers.delete(runId);
  }

  /** Record a failure. A run parked for reconciliation keeps that state: the unknown outcome outranks the error. */
  async fail(runId: string, owner: string, error: unknown): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      if (['completed', 'cancelled', 'reconcile_required'].includes(run.state)) return;
      this.guard(run, owner);
      run.state = 'failed';
      run.failure = this.describeError(error);
      this.note(run, 'run.failed', { errorType: run.failure.name });
      await this.commit(run);
    });
    this.controllers.delete(runId);
  }

  /** Keep a provider's opaque transcript reference apart from the run's portable context. */
  async recordTranscript(
    runId: string,
    owner: string,
    providerId: string,
    transcript: ProviderTranscriptRef,
  ): Promise<void> {
    await this.serialize(runId, async () => {
      const run = await this.load(runId);
      this.guard(run, owner);
      run.transcripts[providerId] = copy(transcript);
      run.contextRevision += 1;
      this.note(run, 'transcript.recorded', {
        providerId,
        lineageId: transcript.lineageId,
        prefixHash: transcript.prefixHash,
      });
      await this.commit(run);
    });
  }

  /**
   * A new run from a completed pure prefix of another. The child inherits the
   * observations before `beforeStepId` and nothing else: no lease, no approval,
   * no result. A prefix containing an effect on the world cannot be forked.
   */
  async fork(
    parentId: string,
    childId: string,
    beforeStepId: string,
    principal: HarnessPrincipal,
  ): Promise<HarnessRun> {
    const parent = await this.load(parentId);
    this.scope(parent, principal);
    validateRunId(childId);
    const index = parent.steps.findIndex((s) => s.intent.stepId === beforeStepId);
    if (index < 0) throw new HarnessError('unknown_fork_point', 'Unknown fork point.');
    const prefix = parent.steps.slice(0, index);
    if (prefix.some((s) => s.state !== 'succeeded' || s.intent.effect !== 'pure'))
      throw new HarnessError('impure_prefix', 'Forks require a completed pure prefix.');
    const at = this.now();
    const child: HarnessRun = {
      ...copy(parent),
      id: childId,
      state: 'queued',
      used: {
        units: prefix.reduce((sum, s) => sum + s.intent.cost, 0),
        modelCalls: prefix.filter((s) => s.intent.kind === 'model').length,
        toolCalls: prefix.filter((s) => s.intent.kind === 'tool').length,
      },
      owner: null,
      fence: 0,
      leaseExpiresAt: null,
      parentRunId: parent.id,
      forkPoint: beforeStepId,
      // A fork is its own lineage: no provider transcript, no context revision, carries over.
      contextRevision: 1,
      transcripts: {},
      result: null,
      failure: null,
      cancelReason: null,
      createdAt: at,
      updatedAt: at,
      steps: copy(prefix).map(({ nativeCheckpoint: _checkpoint, ...step }) => step),
      approvals: [],
      events: [],
      lastSeq: 0,
    };
    this.note(child, 'run.forked', {
      parentRunId: parent.id,
      forkPoint: beforeStepId,
      inheritedObservations: prefix.map((s) => s.intent.stepId),
    });
    await this.store.create(child);
    return copy(child);
  }
}
