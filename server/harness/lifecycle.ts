/**
 * Where governance attaches to work that is already running.
 *
 * The harness already has the places this needs. `RunService.step` applies
 * mandatory policy, then optional hooks, then mandatory policy *again* on the
 * original intent, and hands each hook a deep copy — so a hook can refuse and
 * can record, and cannot widen anything even by accident. That existing shape
 * is the whole reason this file is a hook and a few functions rather than a
 * supervisor with a loop of its own. Adding a poller that watched runs and
 * intervened would be a second scheduler with a second opinion about what is
 * currently permitted, arriving late.
 *
 * Three seams live here, and the third is the one GLM will build on.
 *
 * **The hook** records which rules governed a step, and at effect boundaries
 * re-asks the live services rather than trusting the resolution it was built
 * with. A step that only reads is not stopped by a recheck it does not need;
 * a step that changes something is.
 *
 * **`validateEffect`** is the pre-effect check in the doc's words: canonical
 * action fields, a grant, the resolved route and the expected base. It reports
 * every refusal rather than the first, because a person fixing one and hitting
 * the next is the same interruption twice.
 *
 * **The correction seam** is deliberately narrow. Structured evidence goes out
 * — identifiers, revisions, counts, refusal text the host itself wrote — and
 * what may come back is a change to *this attempt*. A correction may never edit
 * an Agent definition or a business rule, because those are the things somebody
 * reviewed, and a system that quietly rewrites what it was told is no longer
 * governed by it. Persistent failure produces a candidate a person reads. GLM
 * owns the loop; these are the edges it runs between.
 */
import { HarnessError } from './policy.js';
import type { HarnessHook } from './run-service.js';
import type { Effect, StepIntent, StepKind } from '../../shared/harness.js';
import {
  recheckAtEffect,
  type ExecutionResolution,
  type LiveAuthority,
  type PayerKind,
} from '../../shared/execution.js';
import type { LifecycleSurface } from '../../shared/rule-authority.js';
import { evaluatePredicate, type RuleOperation } from '../../shared/predicates.js';

/** Which lifecycle surface a harness step of each kind is standing at. */
export const SURFACE_FOR_STEP: Readonly<Record<StepKind, LifecycleSurface>> = Object.freeze({
  model: 'before-model',
  tool: 'before-tool',
  transform: 'context-assembly',
  approval: 'before-effect',
  wait: 'task-admission',
});

/** Effects that change something outside the run, and therefore need a fresh answer. */
const CHANGES_SOMETHING: readonly Effect[] = Object.freeze(['idempotent', 'non-idempotent']);

export interface GovernanceEntry {
  readonly runId: string;
  readonly stepId: string;
  readonly surface: LifecycleSurface;
  readonly rulesRevision: string;
  readonly governingRuleIds: readonly string[];
  readonly recheckedAuthority: boolean;
}

/**
 * The hook installed with `RunService.use`.
 *
 * It refuses by throwing, which is how the harness already reports a policy
 * denial. It does not return a modified intent, because it is handed a copy and
 * the service re-authorizes the original: a hook that appeared to change
 * something would be lying about its own effect.
 */
export interface GovernanceContext {
  readonly resolution: ExecutionResolution;
  /** Read fresh at each effect boundary. Never a cached snapshot. */
  readonly live: () => Promise<LiveAuthority>;
  readonly record: (entry: GovernanceEntry) => void;
}

export function governanceHook(context: GovernanceContext): HarnessHook {
  return async ({ runId, step }: { runId: string; step: StepIntent }) => {
    const surface = SURFACE_FOR_STEP[step.kind];
    const needsRecheck = CHANGES_SOMETHING.includes(step.effect);
    if (needsRecheck) {
      const result = recheckAtEffect(context.resolution, await context.live());
      if (!result.ok)
        throw new HarnessError('authority_changed', result.reason ?? 'Authority changed.');
    }
    context.record({
      runId,
      stepId: step.stepId,
      surface,
      rulesRevision: context.resolution.rules.revision,
      governingRuleIds: context.resolution.rules.governing.map((item) => item.ruleId),
      recheckedAuthority: needsRecheck,
    });
  };
}

/**
 * The one call that puts governance on a run service.
 *
 * Installing the same context twice is a no-op rather than a second hook. It
 * would otherwise be easy for a restart path and a start path to both install
 * one, and the visible symptom would be duplicated evidence rather than an
 * error — the kind of thing that gets noticed months later in an audit.
 */
const installed = new WeakMap<object, WeakSet<object>>();

export function installGovernance(
  runs: { use(hook: HarnessHook): void },
  context: GovernanceContext,
): void {
  let contexts = installed.get(runs);
  if (!contexts) {
    contexts = new WeakSet<object>();
    installed.set(runs, contexts);
  }
  if (contexts.has(context)) return;
  contexts.add(context);
  runs.use(governanceHook(context));
}

// --- before an effect ---------------------------------------------------------

/**
 * What authorized this particular write.
 *
 * The kind matters as much as the id. An Agent working under `review` may still
 * write — after a person approved that exact change — but it may never write
 * under a standing scope. Recording only an id would collapse those two into
 * "there was a grant", which is the distinction the whole permission model is
 * about.
 */
export type EffectAuthorization =
  | { readonly kind: 'exact-approval'; readonly id: string }
  | { readonly kind: 'scope-grant'; readonly id: string };

export interface EffectRequest {
  readonly operation: RuleOperation;
  /** Canonical, project-relative names the writer produced. */
  readonly paths: readonly string[];
  readonly routeId: string;
  /** What the proposal was built against, and what is there now. */
  readonly expectedBaseDigest: string | null;
  readonly actualBaseDigest: string | null;
  readonly authorization: EffectAuthorization | null;
}

export interface EffectVerdict {
  readonly ok: boolean;
  readonly refusals: readonly string[];
}

/**
 * The last check before anything is written.
 *
 * `Store.writeRecorded` and `server/trust/scope-grants.ts` still perform the
 * write and still hold their own guarantees; this does not replace either. What
 * it adds is that the four things the harness contract names are checked
 * together and reported together, against the resolution this work was admitted
 * under rather than against whatever the request happens to say.
 */
export function validateEffect(
  request: EffectRequest,
  resolution: ExecutionResolution,
  live: LiveAuthority,
): EffectVerdict {
  const refusals: string[] = [];

  const canonical = evaluatePredicate(
    { kind: 'path', within: ['.'] },
    {
      routeId: request.routeId,
      operation: request.operation,
      capabilities: [],
      paths: request.paths,
      budgetUsd: null,
      surfaces: {
        'tool-name': '',
        'operation-name': request.operation,
        'destination-label': '',
        'output-summary': '',
      },
    },
  );
  if (canonical.detail.includes('canonical')) refusals.push(canonical.detail);
  if (request.paths.length === 0)
    refusals.push('This change names no file, so there is nothing to write.');

  if (!request.authorization)
    refusals.push('Nothing has been approved for this change, so it was not written.');

  if (request.routeId !== resolution.route.routeId)
    refusals.push(
      `This work was admitted to run on ${resolution.route.routeId}, and the change came from ${request.routeId}. Nothing was written.`,
    );

  if (request.expectedBaseDigest !== request.actualBaseDigest)
    refusals.push(
      'The file changed since this was prepared. Nothing was written; look at it again.',
    );

  if (
    resolution.agent.effectivePermission === 'review' &&
    request.authorization?.kind === 'scope-grant'
  )
    refusals.push(
      `${resolution.agent.agentName} works under review, so each change goes to a person rather than being applied from a standing permission.`,
    );

  const recheck = recheckAtEffect(resolution, live);
  if (!recheck.ok && recheck.reason) refusals.push(recheck.reason);

  return { ok: refusals.length === 0, refusals: Object.freeze(refusals) };
}

// --- after an observation -----------------------------------------------------

export type ObservationOutcome = 'succeeded' | 'refused' | 'failed';

/**
 * What a correction loop is given.
 *
 * Identifiers, revisions and counts, plus the refusal sentences the host itself
 * produced. Nothing model-written, nothing from a transcript, no file content
 * and no filenames — a path can name a customer, so paths are counted. A loop
 * that needs the content to decide what to try next is deciding something a
 * person should be deciding.
 */
export interface ObservationEvidence {
  readonly tenantId: string | null;
  readonly organizationId: string | null;
  readonly configurationRevision: number | null;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentDigest: string;
  readonly routeId: string;
  readonly rulesRevision: string;
  readonly governingRuleIds: readonly string[];
  readonly payerKind: PayerKind;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly outcome: ObservationOutcome;
  /** Host-written refusal text. Never a model's explanation of itself. */
  readonly refusals: readonly string[];
  readonly observedTool: string | null;
  readonly pathCount: number;
}

export function observationEvidence(input: {
  resolution: ExecutionResolution;
  runId: string;
  stepId: string;
  attempt: number;
  outcome: ObservationOutcome;
  refusals: readonly string[];
  observedTool: string | null;
  observedPaths: readonly string[];
}): ObservationEvidence {
  const { resolution } = input;
  return {
    tenantId: resolution.principal.tenantId,
    organizationId:
      resolution.workspace.kind === 'business' ? resolution.workspace.organizationId : null,
    configurationRevision: resolution.configuration?.revision ?? null,
    agentId: resolution.agent.agentId,
    agentVersion: resolution.agent.agentVersion,
    agentDigest: resolution.agent.agentDigest,
    routeId: resolution.route.routeId,
    rulesRevision: resolution.rules.revision,
    governingRuleIds: Object.freeze(resolution.rules.governing.map((item) => item.ruleId)),
    payerKind: resolution.payer.kind,
    runId: input.runId,
    stepId: input.stepId,
    attempt: input.attempt,
    outcome: input.outcome,
    refusals: Object.freeze([...input.refusals]),
    observedTool: input.observedTool,
    pathCount: input.observedPaths.length,
  };
}

// --- what a correction may do -------------------------------------------------

/**
 * The bounds on a correction. Small numbers on purpose: a loop that retries
 * fifteen times has stopped being a correction and started being a different
 * plan, and a different plan is something a person agrees to.
 */
export const CORRECTION_LIMITS = Object.freeze({
  maxAttempts: 3,
  /** How many identical failures before a configuration change is proposed. */
  candidateAfter: 3,
});

/** What a correction is trying to change. Only the first is ever allowed. */
export type CorrectionTarget = 'attempt' | 'agent-definition' | 'business-rule' | 'grant';

export interface CorrectionBounds {
  readonly allowed: boolean;
  readonly reason: string;
}

export function correctionWithinBounds(input: {
  attempt: number;
  changes: readonly { target: CorrectionTarget; what: string }[];
}): CorrectionBounds {
  if (input.attempt >= CORRECTION_LIMITS.maxAttempts)
    return {
      allowed: false,
      reason: `Diomedes has tried this ${CORRECTION_LIMITS.maxAttempts} times and stopped. What it ran into is recorded below.`,
    };
  const durable = input.changes.filter((change) => change.target !== 'attempt');
  if (durable.length > 0)
    return {
      allowed: false,
      reason: `A correction can change how this attempt is made, and nothing else. ${durable[0].target.replace('-', ' ')} is something a person reviewed, and only a person changes it.`,
    };
  return { allowed: true, reason: 'This changes the attempt only.' };
}

/**
 * A configuration change somebody has to read.
 *
 * It is a candidate, and `activated` is a literal `false` in the type so no
 * caller can pass this where an active setup belongs. Staging and activation
 * stay with `server/configuration.ts`, which compares against an expected
 * revision — which is why `basedOnRevision` is recorded here and not inferred
 * later.
 */
export interface ConfigurationCandidate {
  readonly state: 'needs-review';
  readonly activated: false;
  readonly organizationId: string | null;
  readonly basedOnRevision: number | null;
  readonly summary: string;
  readonly observedRefusals: readonly string[];
  readonly occurrences: number;
}

export function correctionCandidate(
  resolution: ExecutionResolution,
  failures: readonly { stepId: string; outcome: ObservationOutcome; refusals: readonly string[] }[],
): ConfigurationCandidate | null {
  const persistent = failures.filter((failure) => failure.outcome !== 'succeeded');
  if (persistent.length < CORRECTION_LIMITS.candidateAfter) return null;
  const refusals = [...new Set(persistent.flatMap((failure) => failure.refusals))];
  return {
    state: 'needs-review',
    activated: false,
    organizationId:
      resolution.workspace.kind === 'business' ? resolution.workspace.organizationId : null,
    basedOnRevision: resolution.configuration?.revision ?? null,
    summary: `This job stopped for the same reason ${persistent.length} times. Review the setup for ${resolution.agent.agentName} and decide whether it should be able to do this.`,
    observedRefusals: Object.freeze(refusals),
    occurrences: persistent.length,
  };
}
