/**
 * The Nectovia route: the bot's conversation on company-managed inference
 * (contract `nectovia-managed/1`, section 6,
 * docs/implementation/2026-09-25-managed-inference-gateway.md).
 *
 * The customer connects no provider. Each call goes to the account service's
 * gateway, `POST {accountService}/managed/v1/responses`, as the signed-in
 * person: the session's bearer token, the admission the Agent gate recorded
 * for this work, and the job, attempt, tier, usage class and policy revision
 * it is metered under. The gateway checks all of it again, pays the provider
 * with the company's credential and debits the business's credits. No
 * provider credential exists on this computer for this route, and nothing is
 * written to protected storage for it.
 *
 * On this computer it is an ordinary model-API route: the same guarded
 * transport, the same one streamed Responses exchange through the same SDK as
 * the AWS route (the gateway forwards the SDK's body to GPT-6 Luna on Bedrock),
 * and the same local spend ledger. That ledger is a guard, never the balance:
 * the gateway's funding ledger is the authority, and nothing here shows a
 * local figure as what the business has left.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { creditAmount, publishedMonthlyGrant, type JobTier, type UsageClass } from '../../shared/managed-usage.js';
import { GPT6_LUNA, NECTOVIA_ROUTE } from '../../shared/model-api.js';
import type { TierResolution } from '../../shared/tier-map.js';
import { classifyTask, WORK_STYLE_LABELS, type WorkStyle } from '../../shared/work-style.js';
import { digest } from '../harness/policy.js';
import { attemptIdFor, type ExposureSummary, type ModelRateCard, type SpendExposure } from '../spend-exposure.js';
import { AWS_BEDROCK_SDK } from './aws-bedrock.js';
import {
  classifyEnvelope,
  CREDENTIAL_PLACEHOLDER,
  ModelApiError,
  respondStream,
  responsesBody,
  responsesUsage,
  type CallExposure,
  type RespondLimits,
  type RespondResult,
  type RouteBinding,
  type StreamSinks,
} from './model-api-core.js';

/** The same SDK pair the AWS route is tested against: the gateway speaks the same Responses body. */
export const NECTOVIA_SDK = AWS_BEDROCK_SDK;
export const NECTOVIA_PROTOCOL = 'openai-responses';
export const NECTOVIA_CONTRACT = 'nectovia-managed/1';

/** Said wherever this route finds nobody signed in. */
export const NECTOVIA_SIGN_IN = 'Sign in to use the Nectovia Agent.';
export const NECTOVIA_UNAVAILABLE = "Nectovia's model service isn't available right now. Nothing was charged.";

/** The model each tier runs, as the account service published it. */
export interface NectoviaPolicy {
  revision: number;
  tiers: Record<JobTier, { model: string; label: string } | null>;
}

/**
 * What this route needs from the account session. Nothing here is stored: the token is read for
 * each call and the policy is the one the service last published to this session.
 */
export interface NectoviaAccount {
  /** The account service's address; the gateway answers under `${base}/managed/v1`. */
  readonly base: string;
  signedIn(): boolean;
  /** The session's current bearer token, rotated when it is close to expiring. */
  token(): Promise<string>;
  policy(): NectoviaPolicy | null;
  /** Ask the account service for its published policy again, once. */
  refreshPolicy(): Promise<NectoviaPolicy | null>;
  /** The business the work belongs to, or null for Personal work. */
  organizationFor(projectId: string | null): string | null;
  /** The account service's own transport, so an in-process test service is reached the same way. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * What admission settled for one piece of managed work, carried in the admission record the run
 * persists. Identifiers only: the admission id is evidence of intent, never a credential.
 */
export interface ManagedAdmission {
  admissionId: string;
  organizationId: string;
  /** The published policy revision the model was resolved from. */
  policyRevision: number;
  tier: JobTier;
  usageClass: UsageClass;
  /** The run the admission was pinned to: every call of the work names it as its job. */
  rootJobId: string;
}

/** The effort each tier asks for. The route does not change by tier; the effort does. */
export const NECTOVIA_EFFORT: Record<JobTier, 'low' | 'medium' | 'high'> = {
  efficient: 'low',
  focused: 'medium',
  thorough: 'high',
};

/** A person's own conversation is included chat; everything else the Agent does is metered work. */
export const usageClassFor = (surface: string): UsageClass =>
  surface === 'conversation' ? 'included-chat' : 'metered-work';

/** What a run carries as the route's account: the business that pays. Never a credential. */
export const nectoviaAccountRoute = (organizationId: string) => `${NECTOVIA_ROUTE}:${organizationId}`;

/**
 * The local guard's ledger connection for one business and one month. A connection's exposure
 * counts everything it ever settled, so the guard is scoped to the month it guards; the business's
 * real allowance is the gateway's, and is never read from here.
 */
export function nectoviaConnectionId(organizationId: string, at: Date): string {
  const month = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${NECTOVIA_ROUTE}-${digest(organizationId).slice(0, 12)}-${month}`;
}

/**
 * The local guard for one business's month, and what it has left. Its cap is set once, from the
 * plan's published monthly grant (a plan without a published figure is guarded at the Business
 * grant). The gateway decides what the business can actually spend; this only stops this computer
 * sending past what the plan could fund. Every Nectovia call and every managed preflight holds on it.
 */
export async function ensureNectoviaGuard(
  exposure: Pick<SpendExposure, 'allowance' | 'setCap' | 'summary'>,
  connectionId: string,
  planId: string | null,
): Promise<ExposureSummary> {
  if (!exposure.allowance(connectionId))
    await exposure.setCap(connectionId, publishedMonthlyGrant(planId ?? '') ?? creditAmount(1_000), {
      approvedBy: `the ${planId ?? 'Nectovia'} plan, by this computer's host`,
      note: "Nectovia's local guard for this business this month. The account service's ledger is the authority.",
    });
  return exposure.summary(connectionId);
}

/**
 * The local rate card for a model the gateway serves, from the provider registry's own numbers.
 * One band: the gateway refuses input past 272,000 tokens rather than guess a long-context price,
 * so no call on this route can settle in a long band.
 */
export function nectoviaRateCard(model: string): ModelRateCard {
  if (model !== GPT6_LUNA.model)
    throw new ModelApiError(
      'nectovia_rate_card_missing',
      'Nectovia published a model this version of the app has no price for. Nothing was sent. Update Nectovia to use it.',
      false,
    );
  return {
    version: GPT6_LUNA.rateCard,
    route: NECTOVIA_ROUTE,
    modelId: model,
    source: `${GPT6_LUNA.source} Nectovia's local guard; the account service's ledger is the authority.`,
    shortContextMaxInputTokens: GPT6_LUNA.maxInputTokens,
    short: { ...GPT6_LUNA.rates },
    long: { ...GPT6_LUNA.rates },
  };
}

/**
 * The route's limits inside a caller's: the output cap is Nectovia's own 16,000-token product
 * limit, and the request stays small enough that the gateway's input bound
 * (`inputTokenBound`, 272,000 tokens) is never the thing that refuses it.
 */
export function nectoviaLimits(limits: RespondLimits): RespondLimits {
  return {
    ...limits,
    maxOutputTokens: Math.min(limits.maxOutputTokens, GPT6_LUNA.maxOutputTokens),
    maxRequestBytes: Math.min(limits.maxRequestBytes, 262_144),
  };
}

const tierName = (tier: JobTier) => WORK_STYLE_LABELS[tier];

/**
 * The gateway's refusals (contract sections 2 and 3), each in the words a customer reads. Every
 * one of these is answered before the gateway's dispatch commit, or after a provider rejection it
 * released, so nothing was charged; the local hold is released for them too. The service's own
 * sentence is used where the contract says it carries one.
 */
export function gatewayRefusal(
  status: number,
  error: { code: string | null; message: string } | null,
  tier: JobTier,
): { code: string; message: string } | null {
  const said = error?.message?.trim() || null;
  switch (error?.code) {
    case 'sign_in_required':
      return { code: 'nectovia_sign_in_required', message: NECTOVIA_SIGN_IN };
    case 'not_a_member':
    case 'agent_not_included':
      return {
        code: 'nectovia_agent_not_included',
        message: said ?? 'This business does not include the Nectovia Agent. Nothing was charged.',
      };
    case 'admission_invalid':
      return {
        code: 'nectovia_admission_invalid',
        message: 'Nectovia could not confirm this message was admitted. Nothing was charged. Send it again.',
      };
    case 'insufficient_allowance':
    case 'no_period':
      return {
        code: `nectovia_${error.code}`,
        message: said ?? "This business has used this month's Nectovia credits. Nothing was charged.",
      };
    case 'cap_request_required':
      return {
        code: 'nectovia_cap_request_required',
        message: said ?? `This job has reached the ${tierName(tier)} cap. Nothing was charged.`,
      };
    case 'policy_changed':
      return {
        code: 'nectovia_policy_changed',
        message: `Nectovia changed the model ${tierName(tier)} runs on. Nothing was charged. Send your message again.`,
      };
    case 'tier_unrouted':
      return {
        code: 'nectovia_tier_unrouted',
        message: `${tierName(tier)} has no Nectovia model right now. Nothing was charged. Choose another tier.`,
      };
    case 'context_too_long':
    case 'request_too_large':
      return {
        code: 'nectovia_too_long',
        message: 'This message and its sources are longer than Nectovia accepts. Nothing was charged. Choose fewer or shorter sources.',
      };
    case 'provider_busy':
      return {
        code: 'nectovia_provider_busy',
        message: "Nectovia's model service is busy. Nothing was charged. Try again in a minute.",
      };
    case 'route_unavailable':
      return { code: 'nectovia_route_unavailable', message: NECTOVIA_UNAVAILABLE };
    case 'invalid_header':
    case 'unsupported_field':
    case 'provider_refused':
    case 'attempt_conflict':
      return {
        code: `nectovia_${error.code}`,
        message: `Nectovia refused this message${said ? `: ${said}` : '.'} Nothing was charged.`,
      };
  }
  // A 503 without the gateway's own body is not known to have held nothing.
  if (status === 401) return { code: 'nectovia_sign_in_required', message: NECTOVIA_SIGN_IN };
  return null;
}

/** Statuses at which the gateway's readable error body means it held and sent nothing. */
const GATEWAY_RELEASABLE = new Set([400, 401, 402, 403, 404, 409, 413, 422, 429, 503]);

/** Headers that carry the gateway's record of the call, kept as the call's request id. */
const GATEWAY_REQUEST_ID_HEADERS = ['x-nectovia-attempt', 'x-request-id'] as const;

/**
 * The route's part of one call. `attemptId` reads the local hold's id, which is what the gateway
 * is told the attempt is: one per provider call, fixed before anything is sent.
 */
export function nectoviaBinding(input: {
  base: string;
  connectionId: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  managed: ManagedAdmission;
  attemptId: () => string | null;
  /** The attempt this call retries, when it is a retry. */
  parentAttemptId?: string | null;
}): RouteBinding {
  const baseUrl = `${input.base}/managed/v1`;
  const { managed } = input;
  const attach = (headers: Headers, token: string) => {
    const attempt = input.attemptId();
    if (!attempt)
      throw new ModelApiError('nectovia_request_refused', 'This call has no recorded attempt, so it was not sent.', false);
    headers.delete('authorization');
    headers.delete('openai-organization');
    headers.delete('openai-project');
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-nectovia-organization', managed.organizationId);
    headers.set('x-nectovia-admission', managed.admissionId);
    headers.set('x-nectovia-job', managed.rootJobId);
    headers.set('x-nectovia-attempt', attempt);
    if (input.parentAttemptId) headers.set('x-nectovia-parent-attempt', input.parentAttemptId);
    headers.set('x-nectovia-tier', managed.tier);
    headers.set('x-nectovia-usage-class', managed.usageClass);
    headers.set('x-nectovia-policy-revision', String(managed.policyRevision));
  };
  return {
    route: NECTOVIA_ROUTE,
    prefix: 'nectovia',
    label: 'Nectovia',
    connectionId: input.connectionId,
    modelId: input.model,
    expiresAt: null,
    model: (fetch) =>
      createOpenAI({
        name: NECTOVIA_ROUTE,
        baseURL: baseUrl,
        // A placeholder: the guarded transport attaches the session token after its checks,
        // and an explicit value also stops the SDK reading OPENAI_API_KEY from the environment.
        apiKey: CREDENTIAL_PLACEHOLDER,
        fetch,
      }).responses(input.model),
    guard: { expectedUrl: `${baseUrl}/responses`, attach, requestIdHeaders: GATEWAY_REQUEST_ID_HEADERS },
    // Exactly the AWS route's options: the gateway forwards this body to the same model.
    providerOptions: {
      openai: {
        forceReasoning: true,
        systemMessageMode: 'developer',
        include: ['reasoning.encrypted_content'],
        reasoningEffort: input.effort,
        reasoningSummary: null,
        store: false,
        parallelToolCalls: false,
      },
    },
    classify: (envelope) => {
      const { readable, body } = responsesBody(envelope);
      return { readable, classified: readable ? classifyEnvelope(body) : null };
    },
    usage: responsesUsage,
    releasableStatuses: GATEWAY_RELEASABLE,
    refused: (status, error) => gatewayRefusal(status, error, managed.tier),
  };
}

/**
 * One call through the gateway: reserve on the local guard, stream once, classify, settle.
 * Never retried. When the gateway says the published policy moved, the policy is read again
 * once and the refusal names the model the tier runs now; nothing switches payer or provider.
 */
export async function respondNectovia(
  input: {
    base: string;
    account: Pick<NectoviaAccount, 'refreshPolicy'>;
    connectionId: string;
    model: string;
    managed: ManagedAdmission;
    token: string;
    card: ModelRateCard;
    exposure: CallExposure;
    attempt: import('../spend-exposure.js').ExposureAttempt;
    instructions: string;
    messages: import('ai').ModelMessage[];
    tools: readonly import('../../shared/harness.js').ToolDescriptor[];
    effort: 'low' | 'medium' | 'high';
    limits: RespondLimits;
    signal: AbortSignal;
    transport?: typeof globalThis.fetch;
    now?: () => Date;
  } & StreamSinks,
): Promise<RespondResult> {
  let attemptId: string | null = null;
  // A retry is the next attempt number of the same step, and names the attempt before it.
  const parentAttemptId =
    input.attempt.attempt > 1
      ? attemptIdFor(input.connectionId, { ...input.attempt, attempt: input.attempt.attempt - 1 })
      : null;
  // The hold's id is the attempt the gateway records, so it is read from the hold as it is made.
  const exposure: CallExposure = {
    reserve: async (hold) => {
      const reservation = await input.exposure.reserve(hold);
      attemptId = reservation.id;
      return reservation;
    },
    release: (...args) => input.exposure.release(...args),
    markUncertain: (...args) => input.exposure.markUncertain(...args),
    settle: (...args) => input.exposure.settle(...args),
    ...(input.exposure.beforeDispatch ? { beforeDispatch: (hold) => input.exposure.beforeDispatch!(hold) } : {}),
  };
  const { base, account, connectionId, model, managed, token, effort, limits, ...rest } = input;
  try {
    return await respondStream({
      ...rest,
      exposure,
      secret: token,
      limits: nectoviaLimits(limits),
      binding: nectoviaBinding({ base, connectionId, model, effort, managed, attemptId: () => attemptId, parentAttemptId }),
    });
  } catch (error) {
    if (!(error instanceof ModelApiError) || error.code !== 'nectovia_policy_changed') throw error;
    const policy = await account.refreshPolicy().catch(() => null);
    const now = policy?.tiers[managed.tier] ?? null;
    throw new ModelApiError(
      error.code,
      now
        ? `Nectovia now runs ${tierName(managed.tier)} on ${now.label}. Nothing was charged. Send your message again to use it.`
        : `${tierName(managed.tier)} has no Nectovia model right now. Nothing was charged. Choose another tier.`,
      error.dispatched,
      error.evidence,
    );
  }
}

/**
 * What a Nectovia conversation's tier runs on: the model the account service publishes for it
 * now, at the tier's own level. Nothing on this computer picks the model, and the owner's tier
 * map (which routes the owner's own provider routes) is never read. A tier the policy leaves
 * unrouted is refused by name; so is every tier while nobody is signed in or the service has
 * not answered. Pure: the caller reads the session.
 */
export function nectoviaTier(input: {
  style: WorkStyle;
  signedIn: boolean;
  policy: NectoviaPolicy | null;
  text?: string | null;
}): TierResolution {
  const { style } = input;
  const kind = classifyTask(input.text);
  const refuse = (reason: string): TierResolution => ({
    outcome: 'refuse',
    style,
    route: NECTOVIA_ROUTE,
    model: null,
    reason,
    ownerPin: false,
    kind,
  });
  if (!input.signedIn) return refuse(NECTOVIA_SIGN_IN);
  if (!input.policy) return refuse(NECTOVIA_UNAVAILABLE);
  const published = input.policy.tiers[style];
  if (!published) return refuse(`${tierName(style)} has no Nectovia model right now. Nothing was sent. Choose another tier.`);
  return {
    outcome: 'run',
    style,
    route: NECTOVIA_ROUTE,
    model: published.model,
    effort: NECTOVIA_EFFORT[style],
    reason: `${tierName(style)}: ${published.label} on Nectovia.`,
    ownerPin: false,
    kind,
  };
}

/** Build and Fix run through Work; the Nectovia Agent answers in the conversation. */
export const NECTOVIA_WORK_REFUSED =
  'The Nectovia Agent answers in the conversation. Build and Fix are not on it yet, so nothing was sent.';
