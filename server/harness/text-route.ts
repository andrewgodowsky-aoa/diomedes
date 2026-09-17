/**
 * The external text-route runtime seam.
 *
 * An admitted engine request is a durable run on the host RunService, not a
 * bare function call. `request()` gives the caller's intent a recorded
 * admission step, a fenced external dispatch step and one committed outcome:
 *
 *   text:admission — discovery, installation, version, sign-in, model and
 *     contract checks. A read; a crashed or failed admission can retry under
 *     a later fence because nothing it did can reach the provider.
 *   text:dispatch — the provider transport itself, exactly once. As an
 *     external model step its uncertain outcome parks for reconciliation:
 *     it is never retried silently and never relabelled as safely cancelled.
 *
 * The run id derives from caller intent (`<projectId>-<requestId>`), so a
 * replayed admission — a client retry, a reconnect, a duplicate submit —
 * lands on the same durable record instead of dispatching twice. A replayed
 * step returns its persisted output without invoking its handler again.
 *
 * The runtime owns only the run lifecycle. What admission checks mean and
 * what the provider transport is stay with the caller (`admit`/`send`);
 * authorization stays with the RunService's egress authorizer, which runs
 * again at dispatch and again before a result may commit.
 */
import { HarnessError, digest, copy } from './policy.js';
import type { RunService, StepContext, StepDefinition } from './run-service.js';
import { localHarnessPrincipal } from './bridge.js';
import { isExternalEngine } from '../../shared/engines.js';
import type {
  CapabilityManifest,
  HarnessRun,
  Json,
  StepIntent,
} from '../../shared/harness.js';

export const ENGINE_TEXT_TURN: CapabilityManifest = {
  id: 'engine-text-turn',
  version: '1',
  label: 'External engine text turn',
  description:
    'One admitted external engine request: a durable admission record, one fenced provider dispatch, and a single committed outcome.',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 1,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
};

export const TEXT_ADMISSION_STEP = 'text:admission';
export const TEXT_DISPATCH_STEP = 'text:dispatch';

/** The deterministic run id for one admitted request — replay lands here. */
export const textRunId = (projectId: string, requestId: string) =>
  `${projectId}-${requestId}`;

/**
 * What the caller must supply per request. `intent` is persisted as the run's
 * input and hashed: a replay under the same request id must carry the same
 * intent or it is refused rather than silently re-dispatched.
 */
export interface TextRouteRequest<A, R> {
  readonly runId: string;
  readonly intent: Json;
  readonly signal?: AbortSignal;
  admit(context: StepContext): Promise<A>;
  send(context: StepContext, admission: A): Promise<R>;
}

export interface TextRouteOutcome<R> {
  readonly run: HarnessRun;
  readonly result: R;
  /** Present only when the dispatch step ran in this call (not on a replay). */
  readonly dispatched: boolean;
}

/** `EngineService` holds one of these; the host supplies the instance. */
export type TextDispatch = <A, R>(
  request: TextRouteRequest<A, R>,
) => Promise<TextRouteOutcome<R>>;

const admissionStep = (engine: string): StepDefinition => ({
  id: TEXT_ADMISSION_STEP,
  version: '1',
  kind: 'tool',
  effect: 'read',
  name: 'Engine admission',
  input: { engine },
  cost: 0,
  // Admission is retryable — its effect is a read — but not boundless.
  maxAttempts: 3,
  // Discovery, version and sign-in checks read this machine; nothing the user
  // wrote leaves the host, so admission is a local step. The route's enabled
  // state and account-route selection gate the dispatch step instead.
  destination: 'local',
});

const dispatchStep = (engine: string, requestId: string): StepDefinition => ({
  id: TEXT_DISPATCH_STEP,
  version: '1',
  kind: 'model',
  effect: 'read',
  name: `Dispatch to ${engine}`,
  input: { engine, requestId },
  cost: 1,
  // One dispatch per run, ever. An unknown outcome parks for reconciliation;
  // it is never resent on the strength of a retry.
  maxAttempts: 1,
  destination: 'external',
});

export class TextRouteRuntime {
  constructor(
    private readonly runs: RunService,
    private readonly options: {
      /** The durable owner token this driver claims runs under. */
      owner?: string;
      /** Lease TTL for the claim; must outlive a slow provider turn. */
      leaseMs?: number;
    } = {},
  ) {}
  private get owner() {
    return this.options.owner ?? 'text-route';
  }
  private get leaseMs() {
    return this.options.leaseMs ?? 300_000;
  }

  private async find(runId: string): Promise<HarnessRun | null> {
    try {
      return await this.runs.get(runId);
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'unknown_run') return null;
      throw error;
    }
  }

  /**
   * Drive one admitted request through a durable run. Replays return recorded
   * outcomes; parked or settled runs answer from the record, never re-dispatch.
   */
  request = async <A, R>(request: TextRouteRequest<A, R>): Promise<TextRouteOutcome<R>> => {
    const runId = request.runId;
    const projectId = (request.intent as { projectId?: unknown }).projectId;
    if (typeof projectId !== 'string' || !projectId)
      throw new HarnessError('invalid_input', 'A text-route intent must name its project.');
    const engine = (request.intent as { engine?: unknown }).engine;
    if (typeof engine !== 'string' || !isExternalEngine(engine))
      throw new HarnessError('invalid_input', 'A text-route intent must name an external engine.');
    const requestId = (request.intent as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'string' || !requestId)
      throw new HarnessError('invalid_input', 'A text-route intent must name its request.');
    const principal = localHarnessPrincipal(projectId);
    const intentHash = digest(request.intent);
    if (request.signal?.aborted)
      throw new HarnessError('run_cancelled', 'This run was cancelled: the caller cancelled.');

    let run = await this.find(runId);
    if (!run) {
      try {
        run = await this.runs.start({
          id: runId,
          tenantId: principal.tenantId,
          projectId,
          principal,
          capability: ENGINE_TEXT_TURN,
          budget: { units: 1, modelCalls: 1, toolCalls: 1, wallMs: null },
          input: request.intent,
        });
      } catch (error) {
        // A concurrent same-id request created the run first; its record is
        // joined below under the same identity checks as any replay.
        if (!(error instanceof HarnessError && error.code === 'run_exists')) throw error;
        run = await this.runs.get(runId);
      }
    }
    if (run.capabilityId !== ENGINE_TEXT_TURN.id)
      throw new HarnessError(
        'run_id_collision',
        'This run id names a record outside the text-route seam.',
      );
    if (digest(run.input) !== intentHash)
      throw new HarnessError(
        'input_mismatch',
        'This request id already names a different request.',
      );

    // A settled or parked run answers from its record: the request's outcome
    // was already decided, and a replay must not reinterpret it.
    if (run.state === 'completed') {
      const result = (run.result as { response?: unknown } | null)?.response;
      if (result === undefined)
        throw new HarnessError('invalid_run_record', 'A completed run has no recorded response.');
      return { run, result: copy(result) as R, dispatched: false };
    }
    if (run.state === 'cancelled')
      throw new HarnessError(
        'run_cancelled',
        `This run was cancelled: ${run.cancelReason ?? 'the caller cancelled.'}`,
      );
    if (run.state === 'reconcile_required')
      throw new HarnessError(
        'reconcile_required',
        'This request is parked: its provider outcome was never confirmed.',
      );
    if (run.state === 'failed')
      throw new HarnessError(
        'request_failed',
        run.failure?.message ?? 'This request failed. Its record is kept.',
      );

    // Caller cancellation cancels the run, never just the local await: the
    // record must show the request was stopped, and a running dispatch parks
    // rather than pretending its provider effect is known.
    const cancel = () => {
      void this.runs
        .cancel(runId, 'the caller cancelled', principal)
        .catch(() => {});
    };
    request.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.runs.claim(runId, this.owner, this.leaseMs);
      const admission = await this.runs.step<A>(
        runId,
        this.owner,
        admissionStep(engine),
        (context) => request.admit(context),
        principal,
      );
      if (request.signal?.aborted) {
        await this.runs.cancel(runId, 'the caller cancelled', principal);
        throw new HarnessError('run_cancelled', 'This run was cancelled: the caller cancelled.');
      }
      const result = await this.runs.step<R>(
        runId,
        this.owner,
        dispatchStep(engine, requestId),
        (context) => request.send(context, admission),
        principal,
      );
      // `copy` already canonicalizes — a non-JSON provider result throws here,
      // which is the honest failure for a contract violation.
      await this.runs.complete(runId, this.owner, { response: copy(result) as Json });
      const finished = await this.runs.get(runId);
      return { run: finished, result, dispatched: true };
    } catch (error) {
      const current = await this.find(runId);
      if (current?.state === 'reconcile_required')
        throw new HarnessError(
          'reconcile_required',
          `The run is parked for reconciliation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      if (current?.state === 'cancelled')
        throw new HarnessError(
          'run_cancelled',
          `This run was cancelled: ${current.cancelReason ?? 'the caller cancelled.'}`,
        );
      // Record a failure only when this driver still owns the run and no
      // in-flight step under the current fence owns the outcome instead —
      // a blocked, busy or stale attempt already has its honest record.
      if (
        current &&
        ['running', 'queued', 'waiting'].includes(current.state) &&
        current.owner === this.owner &&
        !current.steps.some(
          (s) => s.state === 'running' && s.leaseFence === current.fence,
        )
      ) {
        try {
          await this.runs.fail(runId, this.owner, error);
        } catch {
          /* the record under another owner or lease is the truth */
        }
      }
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', cancel);
    }
  };

  /**
   * Startup recovery for text runs: a dead owner's lease is invalidated and
   * any in-flight dispatch is parked for reconciliation by the RunService's
   * own rules. Called once per run under exclusive host startup.
   */
  async recover(runId: string, run: HarnessRun): Promise<void> {
    if (run.capabilityId !== ENGINE_TEXT_TURN.id) return;
    if (!['running', 'queued', 'waiting'].includes(run.state)) return;
    await this.runs.recover(runId, localHarnessPrincipal(run.projectId));
  }
}

/**
 * The host-side grant check for text-route egress. Wired into the RunService's
 * `authorizeEgress` and re-run at dispatch and again at result commit, so a
 * route disabled mid-flight cannot accept a late answer. Authority here is the
 * current Settings record for the route — enablement and a selected account
 * route — not anything the request or adapter asserts about itself.
 */
export function textDispatchAuthorizer(
  services: () => Record<string, unknown> | undefined,
): (run: HarnessRun, intent: StepIntent, phase: 'dispatch' | 'result') => Promise<void> {
  return async (run, intent, phase) => {
    if (run.capabilityId !== ENGINE_TEXT_TURN.id)
      throw new HarnessError('egress_denied', 'This run is not a text-route run.');
    if (intent.destination !== 'external') return;
    const engine = (intent.input as { engine?: unknown } | null)?.engine;
    if (typeof engine !== 'string' || !isExternalEngine(engine))
      throw new HarnessError('egress_denied', 'The step does not name an external engine route.');
    const settings = services();
    if (settings?.[engine] !== true)
      throw new HarnessError('egress_denied', 'This engine route is not enabled in Settings.');
    // The admitted account route is part of the run's durable input; the
    // setting is re-read at each phase, so a re-selected or cleared route
    // cannot carry a result across.
    const requestRoute = (run.input as { accountRoute?: unknown } | null)?.accountRoute;
    if (
      typeof requestRoute !== 'string' ||
      settings[`${engine}AccountRoute`] !== requestRoute
    )
      throw new HarnessError(
        'egress_denied',
        phase === 'result'
          ? 'This engine route lost its selected account route while the dispatch was in flight.'
          : 'This engine route has no selected account route for this request.',
      );
  };
}
