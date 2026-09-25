/**
 * From a saved run to observations (PH-00 contract 2.4, 4.1-4.5).
 *
 * The projector reads the run record the RunService has just committed and the local spend
 * ledger, and hands the exporter metadata-only observations. It never reads a prompt, an answer,
 * a tool argument or result, a path or an error message into anything it builds: every field it
 * sets is a count, a digest, a company-issued id, or a value from a closed set.
 *
 * It runs inside `files.saved`, under the run's write, so it is synchronous, never awaits and
 * never throws (the host wraps it as well). The ledger read is an in-memory copy.
 *
 * Deviation from contract 4.1, recorded in the PH-01 slice record: a loop child's steps hang
 * from the child run's own `delegate` span, and that span hangs from its parent run's span, not
 * from the delegating step's attempt. The parent step id a child records is not always the
 * delegating tool step's id (a second-level delegate records `delegate`, a team child
 * `team:<turn>`), so a run-level parent is the one that always resolves.
 */
import type { HarnessEvent, HarnessRun, StepRecord } from '../../shared/harness.js';
import {
  OBSERVATION_CONTRACT,
  known,
  unknown,
  type AttemptOutcome,
  type CostReconciledObservation,
  type GenerationObservation,
  type Observation,
  type ObservationIds,
  type Observed,
  type ObservedCapability,
  type ObservedStepState,
  type ParkedObservation,
  type SpanObservation,
  type TraceObservation,
  type UsageCountsObserved,
} from '../../shared/observability.js';
import type { VerificationRecord, VerificationView } from '../../shared/verification.js';
import { exposureStepId } from '../harness/model-api-adapter.js';
import { isScriptedAdapter } from '../harness/native-agent.js';
import { TEXT_ADMISSION_STEP, TEXT_DISPATCH_STEP } from '../harness/text-route.js';
import type { ExposureReservation } from '../spend-exposure.js';
import type { ObservationScope } from './eligibility.js';
import type { ObservationExporter } from './exporter.js';
import {
  capabilityOf,
  errorClass,
  errorCode,
  rateCardKeyFor,
  reportedModel,
  requestedModel,
  sessionIdFor,
  spanIdFor,
  toolName,
  traceIdFor,
  uuidFor,
} from './sanitize.js';
import type { ObservationScopes, ResolvedScope } from './scopes.js';

/** What the projector reads from the local spend ledger. */
export interface ObservationLedgerPort {
  list(connectionId: string): readonly ExposureReservation[];
  /** Late costs (PH-02): told, after the write, when an open hold reaches a final cost. */
  onResolved?(listener: ((reservation: ExposureReservation) => void) | null): void;
}

export interface ObservationProjectorOptions {
  readonly scopes: ObservationScopes;
  readonly exporter: ObservationExporter;
  /** The app version. */
  readonly build: string;
  readonly ledger?: ObservationLedgerPort | null;
  /** Emitted uuids remembered for dedupe. */
  readonly seenLimit?: number;
}

export interface ProjectorStats {
  readonly projected: number;
  readonly failures: number;
  readonly unlinkedVerifications: number;
}

const ATTEMPT_END = new Set(['step.succeeded', 'step.failed', 'step.reconcile_required', 'step.cancelled', 'step.retry_wait']);
/** A work loop's plan call: `NativeLoop` calls the model under the key `plan` before any act turn. */
const LOOP_PLAN_STEP = 'model:plan';
const RUN_END: Readonly<Record<string, TraceObservation['outcome']>> = Object.freeze({
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
});
const RUN_STEP_STATE: Readonly<Record<TraceObservation['outcome'], ObservedStepState>> = Object.freeze({
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
});
const TRACKED = 2_000;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const at = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);
const between = (from: string | null | undefined, to: string | null | undefined): Observed<number> => {
  const ms = at(to) - at(from);
  return Number.isFinite(ms) && ms >= 0 ? known(Math.round(ms)) : unknown('not-reported');
};
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null);

/** A Set that forgets its oldest entries past a limit. */
class Bounded<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly limit: number) {}
  get(key: K) {
    return this.map.get(key);
  }
  has(key: K) {
    return this.map.has(key);
  }
  set(key: K, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K);
  }
  delete(key: K) {
    return this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
}

interface SessionLink {
  readonly traceRootRunId: string;
  readonly scope: ObservationScope;
  readonly capability: ObservedCapability;
  readonly lineageRunId: string | null;
}

/** A generation sent while its hold was still open, waiting for its final cost. */
interface OpenCost {
  readonly ids: ObservationIds;
  readonly scope: ObservationScope;
  readonly capability: ObservedCapability;
}

export type LedgerMatch = { readonly linked: false } | { readonly linked: true; readonly hold: ExposureReservation | null };

export class ObservationProjector {
  private ledger: ObservationLedgerPort | null;
  private readonly cursors = new Bounded<string, number>(TRACKED);
  private readonly seen: Bounded<string, true>;
  private readonly sessions = new Bounded<string, SessionLink>(TRACKED);
  private readonly children = new Bounded<string, Set<string>>(TRACKED);
  private readonly openCosts = new Bounded<string, OpenCost>(TRACKED);
  private projected = 0;
  private failures = 0;
  private unlinkedVerifications = 0;

  constructor(private readonly options: ObservationProjectorOptions) {
    this.ledger = null;
    this.seen = new Bounded(Math.max(1, options.seenLimit ?? 10_000));
    this.attachLedger(options.ledger ?? null);
  }

  /** The ledger exists after the harness does; the app attaches it once it has loaded. */
  attachLedger(ledger: ObservationLedgerPort | null) {
    this.ledger = ledger;
    try {
      ledger?.onResolved?.((hold) => this.onCostResolved(hold));
    } catch {
      this.failures += 1;
    }
  }

  /**
   * A hold that was open when its generation was sent has reached a final cost: one
   * `cost-reconciled` event joined on the generation's span id. Never a second generation.
   */
  onCostResolved(hold: ExposureReservation): void {
    try {
      const open = this.openCosts.get(hold.id);
      if (!open || (hold.state !== 'settled' && hold.state !== 'written-off')) return;
      this.openCosts.delete(hold.id);
      const environment = open.scope.facts.environment;
      const cost = costOf({ linked: true, hold }, false, this.pseudonymKey());
      this.emit(
        {
          kind: 'cost-reconciled',
          contract: OBSERVATION_CONTRACT,
          ids: {
            uuid: uuidFor(environment, `cost|${open.ids.spanId}|${hold.state}`),
            traceId: open.ids.traceId,
            spanId: spanIdFor(environment, `cost|${hold.id}`),
            parentId: open.ids.spanId,
            sessionId: open.ids.sessionId,
          },
          at: new Date(at(hold.resolvedAt) || Date.now()).toISOString(),
          scope: open.scope.facts,
          build: this.options.build,
          capability: open.capability,
          generationSpanId: open.ids.spanId,
          reconciledFrom: hold.reconciledFrom ?? (hold.state === 'written-off' ? 'write-off' : 'response'),
          costState: hold.state,
          cost,
        } satisfies CostReconciledObservation,
        open.scope,
      );
    } catch {
      this.failures += 1;
    }
  }

  /** Synchronous, never throws, never awaits. */
  onRunSaved(run: HarnessRun): void {
    try {
      this.project(run);
    } catch {
      this.failures += 1;
    }
  }

  /** A verification recorded after its run: its own span, parented to the run's trace. */
  onVerification(verification: VerificationRecord, view: VerificationView): void {
    try {
      const link = this.sessions.get(verification.sessionId);
      if (!link) {
        this.unlinkedVerifications += 1;
        return;
      }
      if (!(at(verification.startedAt) >= link.scope.boundAt)) return;
      const environment = link.scope.facts.environment;
      const traceId = traceIdFor(environment, link.traceRootRunId);
      const spanId = spanIdFor(environment, `verification|${verification.id}`);
      // The tallies count the person's declared checks, as `declared` does. The check every
      // verification runs itself (`outputs-intact`) is reflected in the state and rule, not here.
      const declaredResults = verification.checks.filter((check) => check.kind !== 'outputs-intact');
      const tally = (outcome: string) => declaredResults.filter((check) => check.outcome === outcome).length;
      this.emit(
        {
          kind: 'span',
          ...this.base(link.scope, link.capability, verification.endedAt, {
            uuid: uuidFor(environment, `verification|${verification.id}`),
            traceId,
            spanId,
            parentId: traceId,
            sessionId: link.lineageRunId ? sessionIdFor(environment, link.lineageRunId) : null,
          }),
          spanKind: 'verification',
          name: 'verification',
          attempt: null,
          stepState: unknown('not-applicable'),
          durationMs: between(verification.startedAt, verification.endedAt),
          effect: unknown('not-applicable'),
          authorization: unknown('not-applicable'),
          verification: known({
            state: view.state,
            rule: view.rule,
            declared: verification.declaredChecks,
            passed: tally('passed'),
            failed: tally('failed'),
            incomplete: tally('incomplete'),
            requestedBy: verification.requestedBy,
          }),
          errorCode: unknown('not-applicable'),
        } satisfies SpanObservation,
        link.scope,
      );
    } catch {
      this.failures += 1;
    }
  }

  stats(): ProjectorStats {
    return { projected: this.projected, failures: this.failures, unlinkedVerifications: this.unlinkedVerifications };
  }

  // --- projection ---------------------------------------------------------------

  private project(run: HarnessRun) {
    const resolved = this.options.scopes.resolve(run);
    if (!resolved) return;
    const from = this.cursors.get(run.id) ?? 0;
    this.cursors.set(run.id, run.lastSeq);
    const isRoot = resolved.traceRootRunId === run.id;
    if (isRoot && run.sessionId)
      this.sessions.set(run.sessionId, {
        traceRootRunId: run.id,
        scope: resolved.scope,
        capability: capabilityOf(run.capabilityId),
        lineageRunId: resolved.lineageRunId,
      });
    if (!isRoot) {
      const siblings = this.children.get(resolved.traceRootRunId) ?? new Set<string>();
      siblings.add(run.id);
      this.children.set(resolved.traceRootRunId, siblings);
    }
    for (const event of run.events) {
      if (event.seq <= from) continue;
      if (!(at(event.at) >= resolved.scope.boundAt)) continue;
      if (event.stepId !== undefined && event.attempt !== undefined && ATTEMPT_END.has(event.type))
        this.attemptEnded(run, resolved, event);
      else if (RUN_END[event.type]) this.runEnded(run, resolved, event, RUN_END[event.type]);
    }
    this.parked(run, resolved);
  }

  private ids(resolved: ResolvedScope, key: string, spanId: string, parentId: string | null): ObservationIds {
    const environment = resolved.scope.facts.environment;
    return {
      uuid: uuidFor(environment, key),
      traceId: traceIdFor(environment, resolved.traceRootRunId),
      spanId,
      parentId,
      sessionId: resolved.lineageRunId ? sessionIdFor(environment, resolved.lineageRunId) : null,
    };
  }

  /** The span a run's own steps hang from: the trace for a root, the run's `delegate` span for a child. */
  private runSpan(resolved: ResolvedScope, runId: string) {
    const environment = resolved.scope.facts.environment;
    return runId === resolved.traceRootRunId
      ? traceIdFor(environment, runId)
      : spanIdFor(environment, `${runId}|run`);
  }

  private base(scope: ObservationScope, capability: ObservedCapability, when: string, ids: ObservationIds) {
    return {
      contract: OBSERVATION_CONTRACT,
      ids,
      at: new Date(at(when)).toISOString(),
      scope: scope.facts,
      build: this.options.build,
      capability,
    } as const;
  }

  private attemptEnded(run: HarnessRun, resolved: ResolvedScope, event: HarnessEvent) {
    const step = run.steps.find((item) => item.intent.stepId === event.stepId);
    if (!step || step.intent.stepId === TEXT_ADMISSION_STEP) return;
    if (step.intent.kind !== 'model' && step.intent.kind !== 'tool') return;
    // One observation per attempt: its first ending. A parked attempt a person later cancels is not sent twice.
    const first = run.events.find(
      (item) => item.stepId === event.stepId && item.attempt === event.attempt && ATTEMPT_END.has(item.type),
    );
    if (first?.seq !== event.seq) return;
    const started = run.events.find(
      (item) => item.type === 'step.started' && item.stepId === event.stepId && item.attempt === event.attempt,
    );
    // Only attempts that started after this work was admitted and bound: nothing earlier is uploaded.
    if (!started || !(at(started.at) >= resolved.scope.boundAt)) return;
    const attempt = event.attempt as number;
    const state = event.type.slice('step.'.length) as ObservedStepState;
    const environment = resolved.scope.facts.environment;
    const spanId = spanIdFor(environment, `${run.id}|${step.intent.stepId}|${attempt}`);
    const parentId = this.runSpan(resolved, run.id);
    const capability = capabilityOf(run.capabilityId);
    const common = this.base(resolved.scope, capability, event.at, this.ids(resolved, `attempt|${spanId}|${event.seq}`, spanId, parentId));
    const failure = state === 'succeeded' ? unknown<string>('not-applicable') : errorCode(event.attributes.errorCode);
    // What the step is decides its span, never its origin alone. The host records every registered
    // tool dispatch with an application origin (native-loop.ts, native-agent.ts), so a tool step is
    // always a tool span under its allowlisted name. Only a model step a scripted adapter answered
    // (its reported application origin, or the adapter's own id when a failed attempt reported
    // none) is a scripted step, never a generation.
    const scripted =
      step.intent.kind === 'model' && (step.origin?.mode === 'application' || isScriptedAdapter(step.intent.name ?? ''));

    if (step.intent.kind === 'tool' || scripted) {
      const effect = step.effects?.find((item) => item.attempt === attempt);
      this.emit(
        {
          kind: 'span',
          ...common,
          spanKind: scripted ? 'scripted-step' : 'tool',
          name: scripted ? 'scripted-step' : toolName(step.intent.name),
          attempt,
          stepState: known(state),
          durationMs: between(started.at, event.at),
          effect: effect
            ? known({
                effectClass: effect.effectClass,
                status:
                  effect.status === 'reconciled-applied'
                    ? 'applied'
                    : effect.status === 'reconciled-not-applied'
                      ? 'abandoned'
                      : effect.status,
              })
            : unknown('not-applicable'),
          authorization: effect ? known(authorizationOf(effect.authorization)) : unknown('not-reported'),
          verification: unknown('not-applicable'),
          errorCode: failure,
        } satisfies SpanObservation,
        resolved.scope,
      );
      return;
    }

    const dispatch = step.intent.stepId === TEXT_DISPATCH_STEP;
    const route = resolved.scope.facts.route;
    const managed = resolved.scope.facts.payer === 'managed';
    const match = this.hold(resolved.scope, run.id, step, attempt, dispatch);
    const hold = match.linked ? match.hold : null;
    const output = record(step.output);
    const reported =
      state === 'succeeded'
        ? (step.origin?.model.reported ??
          (dispatch ? (typeof output.model === 'string' && output.model ? output.model : null) : null) ??
          (typeof record(output.transcript).modelId === 'string' ? (record(output.transcript).modelId as string) : null))
        : null;
    // A byo hold still open now settles later: remember where its cost belongs (PH-02 late cost).
    if (!managed && hold && (hold.state === 'pending' || hold.state === 'uncertain'))
      this.openCosts.set(hold.id, { ids: common.ids, scope: resolved.scope, capability });
    this.emit(
      {
        kind: 'generation',
        ...common,
        step: dispatch ? 'text-dispatch' : step.intent.stepId === LOOP_PLAN_STEP ? 'model-plan' : 'model',
        attempt,
        stepState: state,
        outcome: outcomeOf(state, output, match, managed, dispatch),
        errorCode: failure,
        durationMs: between(started.at, event.at),
        requestedModel: resolved.own ? requestedModel(route, resolved.scope.requestedModel) : unknown('not-linked'),
        reportedModel: reportedModel(route, reported),
        usage: usageOf(match, managed),
        cost: costOf(match, managed, this.pseudonymKey()),
        costState: managed ? 'gateway-pending' : hold ? hold.state : 'not-linked',
      } satisfies GenerationObservation,
      resolved.scope,
    );
  }

  private runEnded(run: HarnessRun, resolved: ResolvedScope, event: HarnessEvent, outcome: TraceObservation['outcome']) {
    const environment = resolved.scope.facts.environment;
    const capability = capabilityOf(run.capabilityId);
    if (run.id === resolved.traceRootRunId) {
      const traceId = traceIdFor(environment, run.id);
      this.emit(
        {
          kind: 'trace',
          ...this.base(resolved.scope, capability, event.at, this.ids(resolved, `trace|${traceId}|${event.seq}`, traceId, null)),
          outcome,
          durationMs: between(run.createdAt, event.at),
          modelSteps: run.steps.filter((step) => step.intent.kind === 'model').length,
          toolSteps: run.steps.filter((step) => step.intent.kind === 'tool' && step.intent.stepId !== TEXT_ADMISSION_STEP).length,
          childRuns: this.children.get(run.id)?.size ?? 0,
          errorClass: outcome === 'failed' ? errorClass(run.failure?.name) : unknown('not-applicable'),
          loopStop: capability === 'diomedes-loop' ? unknown('not-reported') : unknown('not-applicable'),
        } satisfies TraceObservation,
        resolved.scope,
      );
      return;
    }
    // A loop child: its own span, under its parent run's span.
    const spanId = this.runSpan(resolved, run.id);
    const parentRunId = resolved.parentRunId ?? resolved.traceRootRunId;
    this.emit(
      {
        kind: 'span',
        ...this.base(resolved.scope, capability, event.at, this.ids(resolved, `run|${spanId}|${event.seq}`, spanId, this.runSpan(resolved, parentRunId))),
        spanKind: 'delegate',
        name: capability,
        attempt: null,
        stepState: known(RUN_STEP_STATE[outcome]),
        durationMs: between(run.createdAt, event.at),
        effect: unknown('not-applicable'),
        authorization: unknown('not-applicable'),
        verification: unknown('not-applicable'),
        errorCode: unknown('not-reported'),
      } satisfies SpanObservation,
      resolved.scope,
    );
  }

  /** Once per parking episode: keyed by its first `step.reconcile_required` after the last recovery. */
  private parked(run: HarnessRun, resolved: ResolvedScope) {
    if (run.state !== 'reconcile_required') return;
    let recovered = 0;
    for (const event of run.events)
      if (event.type === 'run.recovered' || event.type === 'run.reconciled') recovered = event.seq;
    const first = run.events.find((event) => event.seq > recovered && event.type === 'step.reconcile_required');
    if (!first || !(at(first.at) >= resolved.scope.boundAt)) return;
    const step = run.steps.find((item) => item.intent.stepId === first.stepId);
    if (!step) return;
    const environment = resolved.scope.facts.environment;
    const spanId = spanIdFor(environment, `${run.id}|parked|${first.seq}`);
    this.emit(
      {
        kind: 'parked',
        ...this.base(
          resolved.scope,
          capabilityOf(run.capabilityId),
          first.at,
          this.ids(resolved, `parked|${spanId}`, spanId, this.runSpan(resolved, run.id)),
        ),
        stepKind: step.intent.kind,
      } satisfies ParkedObservation,
      resolved.scope,
    );
  }

  /** The spend hold for one attempt, joined exactly as the adapter keyed it. */
  private hold(scope: ObservationScope, runId: string, step: StepRecord, attempt: number, dispatch: boolean): LedgerMatch {
    const ledger = this.ledger;
    if (!ledger) return { linked: false };
    let key: string;
    if (dispatch) key = TEXT_DISPATCH_STEP;
    else {
      const input = record(step.intent.input);
      const request = 'request' in input ? record(input.request) : input;
      if (!Array.isArray(request.messages)) return { linked: false };
      key = exposureStepId(request as { messages: never });
    }
    let holds: readonly ExposureReservation[];
    try {
      holds = ledger.list(scope.connectionId);
    } catch {
      return { linked: false };
    }
    const hold =
      [...holds]
        .reverse()
        .find(
          (item) =>
            item.attempt.runId === runId && item.attempt.stepId === key && (!dispatch || item.attempt.attempt === attempt),
        ) ?? null;
    return { linked: true, hold };
  }

  private pseudonymKey() {
    return this.options.scopes.operator.pseudonymKey;
  }

  private emit(observation: Observation, scope: ObservationScope) {
    if (this.seen.has(observation.ids.uuid)) return;
    this.seen.set(observation.ids.uuid, true);
    this.projected += 1;
    this.options.exporter.enqueue(observation, scope);
  }
}

// --- pure mappings ------------------------------------------------------------------

function authorizationOf(value: string): 'approval' | 'permission' | 'host' | 'none' {
  if (value.startsWith('approval:')) return 'approval';
  if (value.startsWith('permission:')) return 'permission';
  if (value.startsWith('host:')) return 'host';
  return 'none';
}

/**
 * What one model attempt came to. A failed model-API step parks whatever was sent, so a failure
 * is read from the hold: none was made, it was released, it settled, or it is still open.
 */
export function outcomeOf(
  state: ObservedStepState,
  output: Record<string, unknown>,
  match: LedgerMatch,
  managed: boolean,
  dispatch: boolean,
): AttemptOutcome {
  if (state === 'succeeded') {
    if (dispatch) return 'answered-final';
    return record(output.response).type === 'tool' ? 'answered-tool-call' : 'answered-final';
  }
  if (state === 'cancelled') return 'cancelled';
  if (!match.linked) return 'unknown-outcome';
  const hold = match.hold;
  // The managed gateway can hold or charge where this machine made no hold of its own.
  if (!hold) return managed ? 'unknown-outcome' : 'refused-before-send';
  if (hold.state === 'released') return 'not-charged';
  if (hold.state === 'settled' || hold.state === 'written-off') return 'answer-not-used';
  return 'unknown-outcome';
}

export function usageOf(match: LedgerMatch, managed: boolean): Observed<UsageCountsObserved> {
  if (!match.linked) return unknown('not-linked');
  const usage = match.hold?.usage;
  if (!usage) return managed ? unknown('cost-pending') : unknown('not-reported');
  const inputTokens = count(usage.inputTokens);
  const cacheReadTokens = count(usage.cacheReadTokens);
  const cacheWriteTokens = count(usage.cacheWriteTokens);
  const outputTokens = count(usage.outputTokens);
  const reasoningTokens = count(usage.reasoningTokens);
  if (inputTokens === null || cacheReadTokens === null || cacheWriteTokens === null || outputTokens === null || reasoningTokens === null)
    return unknown('usage-refused');
  if (cacheReadTokens + cacheWriteTokens > inputTokens || reasoningTokens > outputTokens) return unknown('usage-refused');
  return known({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens });
}

/**
 * Settled (or written-off) list-price micro-USD, with its rate card as a keyed digest. A managed
 * call's cost is the gateway's settlement, which PH-02 reads; until then it is `cost-pending`.
 */
export function costOf(
  match: LedgerMatch,
  managed: boolean,
  key: Uint8Array | null,
): Observed<{ readonly microUsd: number; readonly rateCardKey: string }> {
  if (managed) return unknown('cost-pending');
  if (!match.linked || !match.hold) return unknown('not-linked');
  const hold = match.hold;
  if (hold.state === 'pending') return unknown('cost-pending');
  if (hold.state === 'uncertain') return unknown('cost-uncertain');
  if (hold.state === 'released') return unknown('not-applicable');
  // A write-off accepts the call as spent at its ceiling unless a figure was recorded.
  const micro = count(hold.state === 'written-off' ? (hold.settledMicroUsd ?? hold.maxMicroUsd) : hold.settledMicroUsd);
  if (micro === null || !key) return unknown('cost-uncertain');
  return known({ microUsd: micro, rateCardKey: rateCardKeyFor(key, hold.rateCardVersion) });
}
