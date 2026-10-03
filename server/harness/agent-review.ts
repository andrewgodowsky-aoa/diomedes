/** Task-bound review over the existing evaluation step, Trust and root spend ledger. */
import { createHash } from 'node:crypto';
import {
  agentReviewGrantSchema, INVENTORY_REVIEW_MAX_INPUT_TOKENS, INVENTORY_REVIEW_PROFILE,
  type AgentReviewGrant,
} from '../../shared/agent-review.js';
import type { EvaluationObservation, EvaluationProfile } from '../../shared/evaluation.js';
import { profileDigest } from '../../shared/evaluation.js';
import { serializedRequestTokens } from '../../shared/evaluation-wire.js';
import type { HarnessLabel, HarnessPrincipal, HarnessRun, Json, StepIntent } from '../../shared/harness.js';
import type { SpendExposure } from '../spend-exposure.js';
import { isDenial, refOf, requireCapability, requireGenuine, type PrincipalRef } from '../trust/index.js';
import { providerQuestions, type EvaluationPort } from './evaluation-adapter.js';
import { EVALUATION_PERMISSION, evaluationStepId, recordEvaluation } from './evaluation.js';
import { copy, digest, HarnessError, joinLabels, validateLabel, validatePrincipal } from './policy.js';
import type { RunService } from './run-service.js';
import type { ResolveHarnessAuthority } from './trust-port.js';

type ReviewPhase = 'dispatch' | 'result';
export interface AgentReviewAdmission {
  readonly grant: AgentReviewGrant;
  readonly authorityRef: PrincipalRef;
  readonly dataPolicyDigest: string;
}
export interface AgentReviewMaterial {
  readonly sources: readonly { readonly sourceId: string; readonly text: string; readonly label: HarnessLabel }[];
  readonly report: { readonly text: string; readonly label: HarnessLabel };
}
export interface AgentReviewHost {
  readonly scopedLedger: SpendExposure;
  readonly currentAuthority: ResolveHarnessAuthority;
  resolveAdmission(grantId: string, phase: ReviewPhase): Promise<AgentReviewAdmission | null>;
  resolveProfile(profileId: string): Promise<EvaluationProfile>;
  resolveMaterial(grant: AgentReviewGrant, phase: ReviewPhase): Promise<AgentReviewMaterial>;
  resolveTransport(request: AgentReviewTransportRequest): Promise<AgentReviewTransport>;
}
export interface AgentReviewTransportRequest {
  readonly grant: AgentReviewGrant;
  readonly stepId: string;
  readonly stateDigest: string;
  readonly maxInputTokens: typeof INVENTORY_REVIEW_MAX_INPUT_TOKENS;
}
export interface AgentReviewTransportBinding {
  readonly grantId: string;
  readonly rootRunId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly rootJobId: string;
  readonly stepId: string;
  readonly route: 'openrouter';
  readonly connectionId: string;
  readonly modelId: 'typesafe/jev-1.13';
  readonly accountId: string;
  readonly accountRevision: number;
  readonly accountDigest: string;
  readonly dataPolicyDigest: string;
  readonly maxInputTokens: number;
  readonly maxCalls: 1;
}
export interface AgentReviewTransport {
  readonly port: EvaluationPort;
  readonly ledger: SpendExposure;
  readonly binding: AgentReviewTransportBinding;
}
export interface RecordAgentReviewInput {
  readonly runtime: RunService;
  readonly runId: string;
  readonly owner: string;
  readonly principal: HarnessPrincipal;
  readonly grant: AgentReviewGrant;
  readonly host: AgentReviewHost;
  readonly observedAt: string;
}
export interface AuthorizeAgentReviewStepInput {
  readonly runtime: RunService;
  readonly runId: string;
  readonly principal: HarnessPrincipal;
  readonly grant: AgentReviewGrant;
  readonly host: AgentReviewHost;
  readonly intent: StepIntent;
  readonly phase: ReviewPhase;
}

const PIN_ID = 'agent-review:admission';
const PIN_VERSION = '1';
const FIXED_PROFILE_DIGEST = profileDigest(INVENTORY_REVIEW_PROFILE);
const PORT_ID = 'openrouter-evaluation';
const rawTextDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const refuse = (code: string, message: string): never => { throw new HarnessError(code, message); };

function frozen<T>(value: T): T {
  const result = copy(value);
  const freeze = (part: unknown): void => {
    if (part !== null && typeof part === 'object') {
      Object.values(part).forEach(freeze);
      Object.freeze(part);
    }
  };
  freeze(result);
  return result;
}
function checkedGrant(value: unknown): AgentReviewGrant {
  const result = agentReviewGrantSchema.safeParse(value);
  if (!result.success) return refuse('review_grant_invalid', 'The task review grant is malformed or outside its supported scope.');
  return frozen(result.data);
}
function checkedRef(value: PrincipalRef): PrincipalRef {
  const allowed = ['local-owner', 'device', 'session', 'team-member', 'prototype'];
  if (!value || !allowed.includes(value.kind) || typeof value.id !== 'string' || !value.id ||
      (value.tenantId !== null && (typeof value.tenantId !== 'string' || !value.tenantId)) ||
      !value.mintedAt || !Number.isSafeInteger(value.mintedAt.identity) || value.mintedAt.identity < 0 ||
      !Number.isSafeInteger(value.mintedAt.principal) || value.mintedAt.principal < 0)
    return refuse('review_authority_invalid', 'The review has no valid stored Trust authority reference.');
  return frozen({ kind: value.kind, id: value.id, tenantId: value.tenantId, mintedAt: { ...value.mintedAt } });
}
type ReviewState = { sources: { sourceId: string; text: string }[]; report: string };
interface ReviewContext {
  readonly profile: EvaluationProfile;
  readonly state: ReviewState;
  readonly label: HarnessLabel;
  readonly stateDigest: string;
  readonly stepId: string;
  readonly authorityDigest: string;
}
type ScopeInput = Pick<RecordAgentReviewInput, 'runtime' | 'runId' | 'principal' | 'grant' | 'host'> & {
  readonly ledger: SpendExposure;
};

function checkedRoot(run: HarnessRun, input: ScopeInput, allowScopedPrincipal: boolean): void {
  const { grant, principal } = input;
  validatePrincipal(principal);
  if (run.id !== grant.rootRunId || input.runId !== grant.rootRunId || run.tenantId !== grant.tenantId ||
      run.projectId !== grant.projectId || run.taskId !== grant.taskId || run.principal.id !== grant.principalId ||
      run.principal.identityGeneration !== grant.identityGeneration)
    refuse('review_root_scope', 'The review grant belongs to its exact root project and task.');
  const metadata = run.input !== null && typeof run.input === 'object' && !Array.isArray(run.input)
    ? run.input as Record<string, Json> : null;
  if ((metadata?.rootRunId !== undefined && metadata.rootRunId !== grant.rootRunId) ||
      (metadata?.parent !== undefined && metadata.parent !== null) ||
      ['diomedes-loop-worker', 'diomedes-loop-advisor', 'agent-team-response'].includes(run.capabilityId))
    refuse('review_child_scope', 'A Team or H14 child cannot inherit the root review grant.');
  const expected = allowScopedPrincipal
    ? { ...run.principal, capabilities: [...new Set([...run.principal.capabilities, EVALUATION_PERMISSION])] }
    : run.principal;
  if (digest(principal) !== digest(run.principal) && (!allowScopedPrincipal || digest(principal) !== digest(expected)))
    refuse('review_principal_scope', 'The review principal must match the stored root identity and permissions.');
  if (run.state === 'cancelled') refuse('run_cancelled', 'The root review run was cancelled.');
  if (run.state === 'reconcile_required') refuse('review_reconciliation_required', 'The root review is blocked pending reconciliation.');
  if (run.state === 'completed' || run.state === 'failed')
    refuse('review_run_settled', 'A settled root run admits no further review.');
  if (input.host.scopedLedger !== input.ledger || input.ledger?.jobScope?.id !== grant.rootJobId)
    refuse('review_ledger_scope', 'The review requires the existing ledger scoped to this root job.');
}

/** Configuration names an existing grant; only current Trust can authorize its disclosure. */
async function currentReference(input: ScopeInput, phase: ReviewPhase): Promise<PrincipalRef> {
  const admission = await input.host.resolveAdmission(input.grant.grantId, phase);
  if (!admission) return refuse('review_admission_revoked', 'The review admission is revoked or no longer active.');
  const activeGrant = checkedGrant(admission.grant);
  const reference = checkedRef(admission.authorityRef);
  if (digest(activeGrant) !== digest(input.grant))
    return refuse('review_grant_changed', 'The current review grant or its account binding changed.');
  if (admission.dataPolicyDigest !== input.grant.dataPolicyDigest)
    return refuse('review_policy_changed', 'The current review data policy differs from its grant.');
  if (reference.kind === 'team-member')
    return refuse('review_authority_denied', 'Team member Trust authority cannot disclose the root review.');
  const authority = requireCapability(requireCapability(requireGenuine(await input.host.currentAuthority({
    via: 'stored-reference', ref: reference,
  })), 'project.read'), phase === 'dispatch' ? 'egress.send' : 'egress.reconcile');
  if (isDenial(authority))
    return refuse('review_authority_denied', `Trust authority refused the review (${authority.code}): ${authority.reason}`);
  if (digest(refOf(authority)) !== digest(reference) ||
      (authority.principal.projectId !== null && authority.principal.projectId !== input.grant.projectId) ||
      (authority.principal.tenantId !== null && authority.principal.tenantId !== input.grant.tenantId))
    return refuse('review_authority_changed', 'The re-resolved Trust authority differs from the exact review reference.');
  return reference;
}

/** Resolve authority and exact material afresh. No selection or cached observation can revive them. */
async function currentContext(input: ScopeInput, phase: ReviewPhase, allowScopedPrincipal = false): Promise<ReviewContext> {
  checkedRoot(await input.runtime.get(input.runId), input, allowScopedPrincipal);
  const reference = await currentReference(input, phase);
  const profile = frozen(await input.host.resolveProfile(input.grant.profileId));
  if (!profile || profile.profileId !== input.grant.profileId || profile.revision !== input.grant.profileRevision ||
      profileDigest(profile) !== input.grant.profileDigest || profileDigest(profile) !== FIXED_PROFILE_DIGEST)
    return refuse('review_profile_changed', 'The inventory review profile revision or question digest changed.');
  const material = await input.host.resolveMaterial(input.grant, phase);
  if (!material || !Array.isArray(material.sources) || material.sources.length !== input.grant.sources.length)
    return refuse('review_source_changed', 'The selected review sources no longer match their grant.');
  const byId = new Map(material.sources.map(source => [source.sourceId, source]));
  if (byId.size !== material.sources.length)
    return refuse('review_source_changed', 'The selected review sources contain duplicate identities.');
  const labels: HarnessLabel[] = [];
  const sources = input.grant.sources.map(source => {
    const selected = byId.get(source.sourceId);
    if (!selected || typeof selected.text !== 'string' || rawTextDigest(selected.text) !== source.digest)
      return refuse('review_source_changed', 'Selected review source bytes differ from their granted digest.');
    labels.push(frozen(selected.label));
    return { sourceId: source.sourceId, text: selected.text };
  });
  if (!material.report || typeof material.report.text !== 'string' || rawTextDigest(material.report.text) !== input.grant.reportDigest)
    return refuse('review_report_changed', 'The report bytes differ from the exact granted report digest.');
  labels.push(frozen(material.report.label));
  const label = frozen(joinLabels(...labels));
  if (label.tenantId !== input.grant.tenantId || label.projectId !== input.grant.projectId)
    return refuse('review_material_scope', 'The selected review material belongs to another project or tenant.');
  const state = frozen({ sources, report: material.report.text });
  const size = serializedRequestTokens(state, providerQuestions(profile));
  if (size.total > INVENTORY_REVIEW_MAX_INPUT_TOKENS || size.statePlusLongestQuestion > INVENTORY_REVIEW_MAX_INPUT_TOKENS)
    return refuse('review_request_too_large', 'The complete serialized review request exceeds the 5,000-token bound.');
  const currentProfile = await input.host.resolveProfile(input.grant.profileId);
  if (!currentProfile || profileDigest(currentProfile) !== FIXED_PROFILE_DIGEST)
    return refuse('review_profile_changed', 'The selected inventory review profile changed while its material was resolving.');
  if (digest(await currentReference(input, phase)) !== digest(reference))
    return refuse('review_authority_changed', 'The review Trust reference changed while its selected material was resolving.');
  checkedRoot(await input.runtime.get(input.runId), input, allowScopedPrincipal);
  return { profile, state, label, stateDigest: digest(JSON.stringify(state)), stepId: evaluationStepId(profile, state),
    authorityDigest: digest(reference) };
}

function pinInput(grant: AgentReviewGrant, context: ReviewContext): Json {
  return { grantId: grant.grantId, grantDigest: digest(grant), authorityDigest: context.authorityDigest,
    stateDigest: context.stateDigest, stepId: context.stepId };
}
function matchesContext(current: ReviewContext, expected: ReviewContext): void {
  if (current.authorityDigest !== expected.authorityDigest)
    refuse('review_authority_changed', 'A new Trust reference cannot revive the pinned review admission.');
  if (current.stateDigest !== expected.stateDigest || current.stepId !== expected.stepId)
    refuse('review_material_changed', 'The exact review material changed before acceptance.');
  if (digest(current.label) !== digest(expected.label))
    refuse('review_policy_changed', 'The review material labels or source restrictions changed.');
}
async function requirePin(input: ScopeInput, context: ReviewContext): Promise<void> {
  const run = await input.runtime.get(input.runId);
  checkedRoot(run, input, true);
  const pin = run.steps.find(step => step.intent.stepId === PIN_ID);
  if (!pin || pin.state !== 'succeeded' || pin.intent.stepVersion !== PIN_VERSION || pin.intent.kind !== 'transform' ||
      pin.intent.effect !== 'pure' || pin.intent.destination !== 'local' || pin.intent.cost !== 0 ||
      pin.intent.permission !== null || pin.intent.approval || pin.intent.maxAttempts !== 1 ||
      digest(pin.intent.input) !== digest(pinInput(input.grant, context)))
    refuse('review_admission_mismatch', 'The exact one-call review admission is missing or changed.');
}

function checkedTransport(transport: AgentReviewTransport, input: ScopeInput, context: ReviewContext): AgentReviewTransportBinding {
  if (!transport || transport.ledger !== input.host.scopedLedger || transport.ledger?.jobScope?.id !== input.grant.rootJobId)
    return refuse('review_ledger_scope', 'The review transport must reuse the supplied root job ledger.');
  const binding = frozen(transport.binding);
  const { grant } = input;
  if (!binding || binding.grantId !== grant.grantId || binding.rootRunId !== grant.rootRunId ||
      binding.projectId !== grant.projectId || binding.taskId !== grant.taskId || binding.rootJobId !== grant.rootJobId ||
      binding.stepId !== context.stepId || binding.route !== grant.route.provider || binding.connectionId !== grant.route.connectionId ||
      binding.modelId !== grant.route.modelId || binding.accountId !== grant.account.id || binding.accountRevision !== grant.account.revision ||
      binding.accountDigest !== grant.account.digest || binding.dataPolicyDigest !== grant.dataPolicyDigest || binding.maxCalls !== 1 ||
      !Number.isSafeInteger(binding.maxInputTokens) || binding.maxInputTokens < 1 || binding.maxInputTokens > INVENTORY_REVIEW_MAX_INPUT_TOKENS)
    return refuse('review_transport_binding', 'The review transport route, account, policy or one-call binding differs from its grant.');
  if (!transport.port || transport.port.id !== PORT_ID || transport.port.requestedModel !== grant.route.modelId ||
      typeof transport.port.version !== 'string' || !transport.port.version || typeof transport.port.evaluate !== 'function')
    return refuse('review_transport_binding', 'The review transport must be the selected direct Jev evaluation port.');
  const size = serializedRequestTokens(context.state, providerQuestions(context.profile));
  if (size.total > binding.maxInputTokens || size.statePlusLongestQuestion > binding.maxInputTokens)
    return refuse('review_request_too_large', 'The serialized review request exceeds the transport input bound.');
  return binding;
}

/** One advisory evaluation; the stored principal, Need and task acceptance remain unchanged. */
export async function recordAgentReview(input: RecordAgentReviewInput): Promise<EvaluationObservation> {
  // Detach caller-owned values before the first await. No renderer-provided grant grants itself.
  const grant = checkedGrant(input.grant);
  const principal = frozen(input.principal);
  const scope = { runtime: input.runtime, runId: input.runId, principal, grant, host: input.host, ledger: input.host.scopedLedger };
  const context = await currentContext(scope, 'dispatch');
  const observed = await input.runtime.join(`agent-review:${input.runId}:${digest(grant)}`, async () => {
    await input.runtime.step(input.runId, input.owner, {
      id: PIN_ID, version: PIN_VERSION, name: 'agent-review-admission', kind: 'transform', effect: 'pure',
      cost: 0, maxAttempts: 1, permission: null, destination: 'local', input: pinInput(grant, context),
    }, async () => null, principal);
    const transport = await input.host.resolveTransport({ grant, stepId: context.stepId, stateDigest: context.stateDigest,
      maxInputTokens: INVENTORY_REVIEW_MAX_INPUT_TOKENS });
    const binding = checkedTransport(transport, scope, context);
    const port = transport.port;
    const evaluate = port.evaluate.bind(port);
    const scopedPort: EvaluationPort = {
      id: port.id, version: port.version, requestedModel: port.requestedModel, scripted: port.scripted,
      supports: Object.freeze([...port.supports]),
      limits: { maxTotalTokens: Math.min(binding.maxInputTokens, port.limits?.maxTotalTokens ?? binding.maxInputTokens),
        maxStatePlusLongestQuestionTokens: Math.min(binding.maxInputTokens, port.limits?.maxStatePlusLongestQuestionTokens ?? binding.maxInputTokens) },
      ...(port.refuses ? { refuses: port.refuses.bind(port) } : {}),
      async evaluate(call) {
        call.signal.throwIfAborted();
        await requirePin(scope, context);
        matchesContext(await currentContext(scope, 'dispatch'), context);
        if (transport.ledger !== input.host.scopedLedger)
          return refuse('review_ledger_scope', 'The supplied root review ledger changed before dispatch.');
        call.signal.throwIfAborted();
        const raw = await evaluate(call);
        matchesContext(await currentContext(scope, 'result'), context);
        call.signal.throwIfAborted();
        return raw;
      },
    };
    // This capability exists only while this exact validated root step is admitted.
    const evaluationPrincipal: HarnessPrincipal = { ...principal,
      capabilities: [...new Set([...principal.capabilities, EVALUATION_PERMISSION])] };
    return recordEvaluation({ runtime: input.runtime, runId: input.runId, owner: input.owner, principal: evaluationPrincipal,
      port: scopedPort, profile: context.profile, state: context.state, label: context.label, observedAt: input.observedAt });
  });
  matchesContext(await currentContext(scope, 'result'), context);
  await requirePin(scope, context);
  return observed;
}

/** Dedicated host egress branch: an AWS lead request cannot be treated as the Jev review. */
export async function authorizeAgentReviewStep(input: AuthorizeAgentReviewStepInput): Promise<void> {
  const scope: ScopeInput = { runtime: input.runtime, runId: input.runId, principal: frozen(input.principal),
    grant: checkedGrant(input.grant), host: input.host, ledger: input.host.scopedLedger };
  const intent = frozen(input.intent);
  const context = await currentContext(scope, input.phase, true);
  const expectedInput = {
    provider: PORT_ID, requestedModel: scope.grant.route.modelId, purpose: context.profile.purpose,
    profileId: context.profile.profileId, profileRevision: context.profile.revision, profileDigest: profileDigest(context.profile),
    questionIds: context.profile.questions.map(question => question.id), stateDigest: context.stateDigest,
  };
  if (intent.stepId !== context.stepId || intent.name !== PORT_ID || !intent.stepVersion || intent.kind !== 'model' ||
      intent.effect !== 'read' || intent.destination !== 'external' || intent.cost !== 1 || intent.maxAttempts !== 1 ||
      intent.permission !== EVALUATION_PERMISSION || intent.approval || intent.trustedInputRequired ||
      digest(intent.input) !== digest(expectedInput))
    refuse('review_intent_mismatch', 'The egress intent is not the exact selected Jev review model request.');
  validateLabel(intent.label);
  if (digest(intent.label) !== digest(context.label))
    refuse('review_policy_changed', 'The review egress label differs from the current selected material.');
  await requirePin(scope, context);
}
