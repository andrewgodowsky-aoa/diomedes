/**
 * An evaluation as a recorded step.
 *
 * The handoff package is emphatic about one thing and it is right: a real cloud
 * evaluation must not hide inside the native loop's `prepare` or `inspect`
 * hooks. Those are declared pure, zero-cost and application-attributed
 * (`native-agent.ts:196-204`, `:298-305`), and a network call in one of them
 * would be an unrecorded, unbudgeted, misattributed charge — money leaving the
 * company that no usage screen could ever show.
 *
 * So an evaluation goes through the door every other model call goes through:
 * `RunService.step`. Three fields on that intent are load-bearing, and none of
 * them is decoration:
 *
 * - `kind: 'model'` puts it in the budget the run already counts model calls
 *   against, and makes it a model operation for attribution.
 * - `destination: 'external'` routes it through the host's egress authorizer
 *   (`policy.ts:133-139`), which is the only thing that may admit a disclosure.
 * - Together those two also satisfy `needsReconciliation`
 *   (`run-service.ts:171-173`), so an unknown outcome parks for reconciliation
 *   instead of being retried. A retried call that already succeeded upstream is
 *   charged twice and counted once.
 *
 * `maxAttempts: 1` says the same thing again at the attempt policy, and it is
 * where the SDK's own default retry budget is deliberately not trusted.
 *
 * The step id and intent pin the shared state by **digest**, never by value.
 * Copying whole project documents into a run record would put customer content
 * into telemetry, and the record has to stay readable. A digest still gives the
 * property that matters: change the project and it is a different step, so a
 * saved answer to a different question is never replayed as this one's.
 */
import type { HarnessLabel, HarnessPrincipal, Json } from '../../shared/harness.js';
import type { OriginSnapshot } from '../../shared/attribution.js';
import { applicationOrigin, directOrigin } from '../../shared/attribution.js';
import type { EvaluationObservation, EvaluationProfile } from '../../shared/evaluation.js';
import { profileDigest } from '../../shared/evaluation.js';
import { digest } from './policy.js';
import type { RunService } from './run-service.js';
import { runEvaluation, type EvaluationPort } from './evaluation-adapter.js';

/**
 * The permission an evaluation step requires. A principal without it cannot run
 * one, whatever a recommendation or a setting says: `authorize` checks this
 * before any hook sees the intent (`policy.ts:115-116`).
 */
export const EVALUATION_PERMISSION = 'evaluate-with-helper';

export interface RecordEvaluationInput {
  readonly runtime: RunService;
  readonly runId: string;
  readonly owner: string;
  readonly principal: HarnessPrincipal;
  readonly port: EvaluationPort;
  readonly profile: EvaluationProfile;
  /** The shared state. Pinned by digest in the record, never copied into it. */
  readonly state: unknown;
  /**
   * The label for this disclosure. Confidentiality and integrity come from the
   * material actually being sent, and provenance names its sources, so the
   * host's egress check has something real to decide on.
   */
  readonly label: HarnessLabel;
  readonly observedAt: string;
}

/**
 * The step id for one evaluation.
 *
 * Stable for the same question over the same state, so a repeat is a replay and
 * costs nothing. Different when either changes, because `ensure` refuses a
 * changed intent under an existing id ("step intent mismatch; fork instead",
 * `run-service.ts:353-362`) — and re-asking a changed question is the correct
 * behaviour, not an error.
 */
export function evaluationStepId(profile: EvaluationProfile, state: unknown): string {
  return `evaluation:${profile.profileId}:${profile.revision}:${digest(digestOf(state)).slice(0, 12)}`;
}

const digestOf = (state: unknown): string =>
  digest(typeof state === 'string' ? state : JSON.stringify(state ?? null));

/**
 * Ask one bounded evaluation as an admitted, recorded, attributed operation.
 *
 * Returns the validated observation. A saved successful observation is returned
 * without calling the provider again; a refused egress never reaches it at all.
 */
export async function recordEvaluation(
  input: RecordEvaluationInput,
): Promise<EvaluationObservation> {
  const { runtime, runId, owner, principal, port, profile, state } = input;
  const stateDigest = digestOf(state);

  const observed = await runtime.step<EvaluationObservation>(
    runId,
    owner,
    {
      id: evaluationStepId(profile, state),
      version: port.version,
      kind: 'model',
      effect: 'read',
      name: port.id,
      cost: 1,
      // One attempt. An external model call whose outcome is unknown may
      // already have been charged, so it is reconciled rather than repeated.
      maxAttempts: 1,
      permission: EVALUATION_PERMISSION,
      destination: 'external',
      trustedInputRequired: false,
      label: input.label,
      // What identifies this operation, and nothing that identifies its
      // contents. The questions are the product's own; the project is a hash.
      input: {
        provider: port.id,
        requestedModel: port.requestedModel,
        purpose: profile.purpose,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        profileDigest: profileDigest(profile),
        questionIds: profile.questions.map((question) => question.id),
        stateDigest,
      } as Json,
    },
    async ({ signal, reportOrigin }) => {
      const result = await runEvaluation({
        port,
        profile,
        state,
        signal,
        observedAt: input.observedAt,
      });
      // Provenance comes from the adapter and the provider's own metadata, never
      // from the decision itself. A fixed script is an application action: the
      // same rule `isScriptedAdapter` already enforces for model adapters, so a
      // fixture is never presented as a model having answered.
      if (reportOrigin) reportOrigin(originFor(port, result));
      return result as unknown as EvaluationObservation;
    },
    principal,
  );

  return observed;
}

function originFor(port: EvaluationPort, result: EvaluationObservation): OriginSnapshot {
  if (port.scripted) return applicationOrigin();
  return directOrigin({
    engine: port.id,
    requestedModel: result.requestedModel,
    // Null when the provider did not say. Unreported identity stays unreported;
    // it cannot support a version-specific calibration claim later.
    reportedModel: result.actualModel,
    version: port.version,
  });
}
