/**
 * The Nectovia route: the bot's conversation on company-managed inference
 * (legacy contract `nectovia-managed/1`, section 6,
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
 * the AWS route, and the same local spend ledger. A versioned account snapshot
 * supplies the configured model's conservative prices and capabilities; the
 * gateway binds the actual provider and records every attempt. That ledger is
 * a guard, never the balance:
 * the gateway's funding ledger is the authority, and nothing here shows a
 * local figure as what the business has left.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { creditAmount, MAX_MONEY_MICRO_USD, micro, publishedMonthlyGrant, type JobTier, type UsageClass } from '../../shared/managed-usage.js';
import { MEMBER_LIMIT_REACHED } from '../../shared/credit-allotments.js';
import { OUT_OF_CREDITS_PERSONAL, PAY_AS_YOU_GO_PLAN_ONLY_REASON } from '../../shared/access.js';
import { ESCALATION_HEADER, escalationAllows, type EscalationRole } from '../../shared/escalation-controls.js';
import { GPT6_LUNA, MANAGED_LUNA, NECTOVIA_ROUTE } from '../../shared/model-api.js';
import { cycleContains, individualCycleId, verifiedIndividualCycle, type IndividualBillingCycle } from '../../shared/individual-period.js';
import type { TierResolution } from '../../shared/tier-map.js';
import { routingPriceSchema, routingReceiptSchema, routingScopeKey, type ResolvedRoutingSnapshot, type AccountScope, type HardRestrictions, type RoutingReceipt } from '../../shared/routing-policy.js';
import { classifyTask, WORK_STYLE_LABELS, type WorkStyle } from '../../shared/work-style.js';
import type { MemberRole } from '../../shared/workspaces.js';
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
export const NECTOVIA_UNAVAILABLE = "Nectovia's AI service isn't available right now.";

/** The model each tier runs, as the account service published it. */
export interface NectoviaPolicy {
  revision: number;
  tiers: Record<JobTier, { model: string; label: string } | null>;
  /** Per tier, whether the gateway accepts reasoning summaries for it. Absent: none is asked for. */
  reasoningSummaries?: Partial<Record<JobTier, boolean>>;
  resolved?: ResolvedRoutingSnapshot;
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
  policy(projectId?: string | null): NectoviaPolicy | null;
  /** Ask the account service for its published policy again, once. */
  refreshPolicy(projectId?: string | null): Promise<NectoviaPolicy | null>;
  /** The business the work belongs to, or null for Personal work. */
  organizationFor(projectId: string | null): string | null;
  scopeFor?(projectId: string | null): AccountScope | null;
  /** The signed-in person's role in a business as this computer last read it, or null when it is not known. */
  roleFor?(organizationId: string): MemberRole | null;
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
  scope?: AccountScope;
  /** Verified paid Individual term from the account service's admission. */
  billingCycle?: IndividualBillingCycle;
  /**
   * The person's role in the business when the work was admitted, or null when this computer does
   * not know it. It decides only which sentence a refusal for want of credits reads as.
   */
  role?: MemberRole | null;
  /** Authenticated per-account snapshot, never a model table from the owner settings. */
  routing?: ResolvedRoutingSnapshot;
  sourceRestrictions?: HardRestrictions[];
  /**
   * Set when a Nectovia role under another lead makes the call: the role, sent as
   * `ESCALATION_HEADER` so the gateway checks the account's escalation control. Absent for a
   * Nectovia lead and for a person's conversation.
   */
  escalation?: EscalationRole;
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
 * The local guard's ledger connection for one billing account and period. Verified Individual
 * admission terms keep one connection across calendar boundaries and receive a new one on paid
 * renewal. Business, legacy Individual and no-plan bought credits retain the calendar-month path.
 * Existing holds and settlements keep the original connection. The gateway owns the real balance.
 */
export function nectoviaConnectionId(organizationId: string, at: Date, billingCycle?: IndividualBillingCycle): string {
  if (billingCycle) {
    const cycle = verifiedIndividualCycle(billingCycle);
    if (!cycle || !cycleContains(cycle, at.getTime()))
      throw new ModelApiError('nectovia_admission_invalid', 'Your Individual billing period couldn\'t be confirmed.', false);
    return `${NECTOVIA_ROUTE}-${digest(organizationId).slice(0, 12)}-individual-${digest(individualCycleId(cycle)).slice(0, 16)}`;
  }
  const month = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${NECTOVIA_ROUTE}-${digest(organizationId).slice(0, 12)}-${month}`;
}

/**
 * The local guard for one business's month, and what it has left. Its cap is set once, from the
 * plan's published monthly grant (a plan without a published figure is guarded at the Business
 * grant). The gateway decides what the business can actually spend; this only stops this computer
 * sending past what the plan could fund. Every Nectovia call and every managed preflight holds on it.
 *
 * Pay as you go (DIO-223) is the one exception: work admitted with no plan, for a person's own scope,
 * carries the bought balance the account service reported (`boughtAvailable`, ledger units). The month's
 * cap is then what this connection has already settled or holds this month plus that balance, so a
 * person who bought more than the default can spend it on this computer, and it is approved again as a
 * new revision whenever that figure differs from the approved cap. The cap is never above what the
 * connection is already out plus the balance the service reported. Without the amount (an older
 * service, or work a plan holds) nothing changes: the default above is set once and never guessed at.
 */
export async function ensureNectoviaGuard(
  exposure: Pick<SpendExposure, 'allowance' | 'setCap' | 'summary'>,
  connectionId: string,
  planId: string | null,
  boughtAvailable?: number | null,
): Promise<ExposureSummary> {
  if (planId === null && boughtAvailable !== undefined && boughtAvailable !== null) {
    // Out so far: settled, or held (pending and uncertain), or written off. The balance is what the service says is left on top.
    const cap = micro(Math.min(exposure.summary(connectionId).exposureMicroUsd + boughtAvailable, MAX_MONEY_MICRO_USD));
    if (exposure.allowance(connectionId)?.capMicroUsd !== cap)
      await exposure.setCap(connectionId, cap, {
        approvedBy: "the person's bought balance, by this computer's host",
        note: "Nectovia's local guard for this person's own work this month: what this connection has already used or holds, plus the bought balance the account service reported. The account service's ledger is the authority.",
      });
    return exposure.summary(connectionId);
  }
  if (!exposure.allowance(connectionId))
    await exposure.setCap(connectionId, publishedMonthlyGrant(planId ?? '') ?? creditAmount(1_000), {
      approvedBy: `the ${planId ?? 'Nectovia'} plan, by this computer's host`,
      note: "Nectovia's local guard for this business this month. The account service's ledger is the authority.",
    });
  return exposure.summary(connectionId);
}

/**
 * The local rate card for a model the gateway serves. From an authenticated account snapshot it is
 * the tier's credit charge (Model B): the account service sends the charge, in ledger units, in the
 * snapshot's `price` and `guardPrices` fields and never a provider's price, so this card, the local
 * guard and the job estimate (`jobRatesOf`) all count credits. The legacy card below is a published
 * list price kept for accounts on the legacy routing record.
 * One band: the gateway refuses input past 272,000 tokens rather than guess a long-context price,
 * so no call on this route can settle in a long band.
 */
export function nectoviaRateCard(model: string, policy?: NectoviaPolicy | null): ModelRateCard {
  const snapshot = policy?.resolved;
  if (snapshot) {
    if (Date.parse(snapshot.validUntil) <= Date.now()) throw new ModelApiError('nectovia_policy_changed', 'Refresh this account routing snapshot before continuing.', false);
    const entries = Object.values(snapshot.tiers).filter(t => t?.model === model);
    if (!entries.length) throw new ModelApiError('nectovia_rate_card_missing', 'The account has no current price for this model.', false);
    const prices = entries.flatMap(t => t!.guardPrices).map(p => routingPriceSchema.parse(p));
    if (!prices.length || prices.some(p => Date.parse(p.validUntil) <= Date.now())) throw new ModelApiError('nectovia_policy_changed', 'The account price evidence expired. Refresh before continuing.', false);
    const bands = prices.flatMap(p => [p, ...p.longContext]);
    const attempts = Math.max(...entries.map(t => t!.maxAttempts));
    const rates = { input: Math.max(...bands.map(b => b.inputMicroUsdPerMillion)) * attempts,
      output: Math.max(...bands.flatMap(b => [b.outputMicroUsdPerMillion, b.reasoningMicroUsdPerMillion])) * attempts,
      cacheRead: Math.max(...bands.map(b => b.cacheReadMicroUsdPerMillion)) * attempts,
      cacheWrite: Math.max(...bands.map(b => b.cacheWriteMicroUsdPerMillion)) * attempts };
    return { version: `managed2:${snapshot.globalRevision}:${snapshot.scopeRevision}:${digest(prices).slice(0, 20)}`,
      route: NECTOVIA_ROUTE, modelId: model, source: 'Authenticated account snapshot. Conservative local exposure across permitted attempts; server receipts are the actual charges.',
      shortContextMaxInputTokens: Math.max(...entries.map(t => t!.capabilities.contextTokens)), short: rates, long: rates,
      requestFeeMicroUsd: Math.max(...bands.map(b => b.requestFeeMicroUsd)) * attempts };
  }
  const legacy = model === GPT6_LUNA.model ? GPT6_LUNA : MANAGED_LUNA;
  if (model !== legacy.model)
    throw new ModelApiError(
      'nectovia_rate_card_missing',
      'Nectovia changed its AI, and this app needs updated pricing. Update Nectovia to continue.',
      false,
    );
  return {
    version: legacy.rateCard,
    route: NECTOVIA_ROUTE,
    modelId: model,
    source: `${legacy.source} Nectovia's local guard; the account service's ledger is the authority.`,
    shortContextMaxInputTokens: legacy.maxInputTokens,
    short: { ...legacy.rates },
    long: { ...legacy.rates },
  };
}

/**
 * The route's limits inside a caller's: the output cap is Nectovia's own 16,000-token product
 * limit, and the request stays small enough that the gateway's input bound
 * (`inputTokenBound`, 272,000 tokens) is never the thing that refuses it.
 */
export function nectoviaLimits(limits: RespondLimits, snapshot?: ResolvedRoutingSnapshot, tier?: JobTier): RespondLimits {
  const entry = tier ? snapshot?.tiers[tier] : null;
  return {
    ...limits,
    maxOutputTokens: Math.min(limits.maxOutputTokens, entry?.capabilities.outputTokens ?? MANAGED_LUNA.maxOutputTokens),
    maxRequestBytes: Math.min(limits.maxRequestBytes, 262_144),
  };
}

const tierName = (tier: JobTier) => WORK_STYLE_LABELS[tier];

/**
 * What a person reads when the business has no credits left, and the work stopped at that step.
 * An owner or admin is the one who can buy more; anyone else, or a role this computer does not
 * know, is told who can. Earlier steps of the same work were charged, so only what came after is
 * said to be uncharged. Credits are bought in Settings, Usage, which the owner or admin's sentence
 * names in plain words; the app has no way to link there from a message, so it doesn't try.
 */
export const OUT_OF_CREDITS_BUYER =
  'Your business is out of credits, so this stopped here. Buy more credits in Settings, Usage.';
export const OUT_OF_CREDITS_OTHER =
  'Your business is out of credits, so this stopped here. An owner or admin can buy more credits to keep going.';
export const outOfCreditsMessage = (role?: MemberRole | null, scopeKind?: AccountScope['kind'] | null): string =>
  // Personal work runs on the person's own bought credits (pay as you go, DIO-219): they are the one who buys more.
  scopeKind === 'individual' ? OUT_OF_CREDITS_PERSONAL : role === 'owner' || role === 'admin' ? OUT_OF_CREDITS_BUYER : OUT_OF_CREDITS_OTHER;

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
  role?: MemberRole | null,
  scopeKind?: AccountScope['kind'] | null,
): { code: string; message: string } | null {
  const said = error?.message?.trim() || null;
  switch (error?.code) {
    case 'sign_in_required':
      return { code: 'nectovia_sign_in_required', message: NECTOVIA_SIGN_IN };
    case 'not_a_member':
    case 'agent_not_included':
      return {
        code: 'nectovia_agent_not_included',
        message: said ?? 'This business doesn\'t include the Nectovia Agent.',
      };
    case 'admission_invalid':
      return {
        code: 'nectovia_admission_invalid',
        message: 'Nectovia couldn\'t confirm this message started. Send it again to check.',
      };
    case 'insufficient_allowance':
    case 'no_period':
      // The service's own words are not shown: they cannot know the person's role or that earlier
      // steps of this work were charged. The codes stay, so anything that keys on them still does.
      return { code: `nectovia_${error.code}`, message: outOfCreditsMessage(role, scopeKind) };
    case 'plan_required':
      // Something only a plan includes, refused to a person paying as they go. Nothing was sent.
      return { code: 'nectovia_plan_required', message: said ?? PAY_AS_YOU_GO_PLAN_ONLY_REASON };
    case 'cap_request_required':
      return {
        code: 'nectovia_cap_request_required',
        message: said ?? `This job has reached the ${tierName(tier)} cap.`,
      };
    case MEMBER_LIMIT_REACHED:
      // A member's own monthly limit stopped this step (Andrew, 2026-10-01). The service's sentence says
      // how many credits it needs and how many are set, and ends with who can approve more; this app
      // turns the refusal into a stop the person can ask an owner or admin about.
      return {
        code: `nectovia_${MEMBER_LIMIT_REACHED}`,
        message: said ?? 'This would go past the credits set for you this month. An owner or admin can approve more.',
      };
    case 'policy_changed':
      return {
        code: 'nectovia_policy_changed',
        message: `Nectovia changed the AI used for ${tierName(tier)}. Send your message again.`,
      };
    case 'tier_unrouted':
      return {
        code: 'nectovia_tier_unrouted',
        message: `${tierName(tier)} is unavailable right now. Choose another tier.`,
      };
    case 'tier_unpriced':
    case 'over_cost_ceiling':
      // Tier pricing (Model B): the tier has no credit price yet, or no route it may run within its
      // price. Either way the tier cannot answer now, which is what the person needs to know.
      return {
        code: `nectovia_${error.code}`,
        message: `${tierName(tier)} is unavailable right now. Choose another tier.`,
      };
    case 'context_too_long':
    case 'request_too_large':
      return {
        code: 'nectovia_too_long',
        message: 'This message and its sources are longer than Nectovia accepts. Choose fewer or shorter sources.',
      };
    case 'provider_busy':
      return {
        code: 'nectovia_provider_busy',
        message: "Nectovia's AI service is busy. Try again in a minute.",
      };
    case 'route_unavailable':
      return { code: 'nectovia_route_unavailable', message: NECTOVIA_UNAVAILABLE };
    case 'escalation_off':
    case 'escalation_tier_off': {
      // The account's escalation control refused a role's call. The gateway and this app say it
      // in the same words (`shared/escalation-controls.ts`).
      const refusal = escalationAllows({ enabled: error.code === 'escalation_tier_off', tiers: [] }, tier);
      return { code: `nectovia_${error.code}`, message: said ?? (refusal.ok ? NECTOVIA_UNAVAILABLE : refusal.reason) };
    }
    case 'invalid_header':
    case 'unsupported_field':
    case 'provider_refused':
    case 'attempt_conflict':
      return {
        code: `nectovia_${error.code}`,
        message: `Nectovia refused this message${said ? `: ${said}` : '.'}`,
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
  /** Ask for reasoning summaries: a thinking sink listens and the gateway says it accepts them. */
  summaries: boolean;
  routing?: ResolvedRoutingSnapshot;
  nativeRouteId?: string;
  onReceipt?: (receipt: RoutingReceipt) => void;
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
    const scope = managed.scope ?? { kind: 'organization', id: managed.organizationId };
    if (scope.kind === 'individual') { headers.delete('x-nectovia-organization'); headers.set('x-nectovia-account', scope.id); headers.set('x-nectovia-scope-kind', 'individual'); }
    else headers.set('x-nectovia-organization', scope.id);
    headers.set('x-nectovia-admission', managed.admissionId);
    headers.set('x-nectovia-job', managed.rootJobId);
    headers.set('x-nectovia-attempt', attempt);
    if (input.parentAttemptId) headers.set('x-nectovia-parent-attempt', input.parentAttemptId);
    headers.set('x-nectovia-tier', managed.tier);
    // Only a role under another lead names itself; nothing else may carry the header.
    headers.delete(ESCALATION_HEADER);
    if (managed.escalation) headers.set(ESCALATION_HEADER, managed.escalation);
    headers.set('x-nectovia-usage-class', managed.usageClass);
    headers.set('x-nectovia-policy-revision', String(managed.policyRevision));
    const snapshot = input.routing ?? managed.routing;
    if (managed.sourceRestrictions?.length && !snapshot)
      throw new ModelApiError('nectovia_source_policy_unverified', 'These sources need a versioned routing policy with verified privacy evidence.', false);
    if (snapshot) {
      if (snapshot.scope.kind !== scope.kind || snapshot.scope.id !== scope.id || Date.parse(snapshot.validUntil) <= Date.now())
        throw new ModelApiError('nectovia_policy_changed', 'The routing snapshot is expired or belongs to another account.', false);
      headers.set('x-nectovia-protocol', snapshot.protocol);
      headers.set('x-nectovia-global-revision', String(snapshot.globalRevision)); headers.set('x-nectovia-scope-revision', String(snapshot.scopeRevision));
      headers.set('x-nectovia-preference-revision', String(snapshot.preferenceRevision));
      headers.set('x-nectovia-route-revision', String(snapshot.tiers[managed.tier]?.entryRevision ?? 0));
      headers.set('x-nectovia-checkpoint', input.nativeRouteId ? 'native' : 'portable');
      if (input.nativeRouteId) headers.set('x-nectovia-native-route', input.nativeRouteId);
      if (managed.sourceRestrictions?.length) headers.set('x-nectovia-source-restrictions', JSON.stringify(managed.sourceRestrictions));
    }
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
        forceReasoning: (input.routing ?? managed.routing)?.tiers[managed.tier]?.capabilities.reasoning !== false,
        systemMessageMode: 'developer',
        include: ['reasoning.encrypted_content'],
        ...((input.routing ?? managed.routing)?.tiers[managed.tier]?.capabilities.reasoning === false ? {} : { reasoningEffort: input.effort }),
        reasoningSummary: input.summaries ? 'auto' : null,
        store: false,
        parallelToolCalls: false,
      },
    },
    classify: (envelope) => {
      const { readable, body } = responsesBody(envelope);
      const classified = readable ? classifyEnvelope(body) : null;
      const snapshot = input.routing ?? managed.routing;
      if (classified && (snapshot && envelope.status < 400 || body && typeof body === 'object' && 'nectovia' in body)) {
        const parsed = routingReceiptSchema.safeParse(body && typeof body === 'object' && 'nectovia' in body ? body.nectovia : undefined);
        if (!parsed.success) throw new ModelApiError('nectovia_receipt_invalid', 'The gateway did not return a valid attempt record. Its cost remains reserved.', true);
        const receipt = parsed.data;
        if (snapshot && receipt.attempts.some((attempt, index) => {
          const route = attempt.routing;
          return !route || route.scopeKey !== routingScopeKey(snapshot.scope) || route.requestGroup !== input.attemptId() ||
            route.ordinal !== index + 1 || route.policyRevision !== snapshot.revision || route.globalRevision !== snapshot.globalRevision ||
            route.scopeRevision !== snapshot.scopeRevision || route.preferenceRevision !== snapshot.preferenceRevision;
        })) throw new ModelApiError('nectovia_receipt_invalid', 'The gateway attempt record does not match this account and request. Its cost remains reserved.', true);
        input.onReceipt?.(receipt);
        classified.rawUsage = { ...classified.usage, nectovia: receipt };
        const actual = receipt.attempts.at(-1)?.routing;
        if (actual?.routeId) classified.servedBy = `${actual.provider}/${actual.model} (${actual.routeId})`;
      }
      return { readable, classified };
    },
    usage: responsesUsage,
    releasableStatuses: GATEWAY_RELEASABLE,
    refused: (status, error) => gatewayRefusal(status, error, managed.tier, managed.role, managed.scope?.kind),
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
    /**
     * `policy` says whether the gateway accepts reasoning summaries. A caller without it (the Work
     * loop, which has no thinking sink) never asks for them.
     */
    account: Pick<NectoviaAccount, 'refreshPolicy'> & Partial<Pick<NectoviaAccount, 'policy'>>;
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
  const snapshot = input.managed.routing ?? input.account.policy?.()?.resolved;
  const nativeRoutes = new Set<string>();
  for (const message of snapshot ? input.messages : []) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'reasoning') continue;
      const encrypted = part.providerOptions?.openai?.reasoningEncryptedContent;
      if (typeof encrypted !== 'string' || !encrypted) continue;
      const match = /^nectovia-native-v1:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}):[^:]+$/.exec(encrypted);
      if (!match) throw new ModelApiError('nonportable_continuation', 'This reasoning checkpoint is not bound to a managed route. Resume from portable history.', false);
      nativeRoutes.add(match[1]);
    }
  }
  if (nativeRoutes.size > 1)
    throw new ModelApiError('nonportable_continuation', 'This conversation contains checkpoints from different routes. Resume from portable history.', false);
  let attemptId: string | null = null;
  let gatewayCharge: string | null = null;
  let gatewayReceipt: RoutingReceipt | null = null;
  const withReceipt = (failure: ModelApiError) => gatewayReceipt ? Object.assign(failure, { managed: gatewayReceipt }) : failure;
  const allAttemptsReleased = () => gatewayReceipt !== null && gatewayReceipt.attempts.every(attempt => attempt.state === 'released');
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
    release: (id, reason) => gatewayCharge === 'uncertain' && !allAttemptsReleased()
      ? input.exposure.markUncertain(id, 'The gateway recorded a potentially charged attempt. Its local hold remains until reconciliation.')
      : input.exposure.release(id, reason),
    markUncertain: (...args) => input.exposure.markUncertain(...args),
    settle: (id, detail) => {
      const raw = detail.raw as { nectovia?: { heldMicroUsd?: unknown } } | undefined;
      const held = gatewayReceipt?.heldMicroUsd ?? raw?.nectovia?.heldMicroUsd;
      // The shared error path can settle reported usage without passing raw
      // metadata. Use the validated receipt captured during classification;
      // an interrupted versioned response without one remains uncertain.
      if ((snapshot && gatewayReceipt === null) || (typeof held === 'number' && held > 0))
        return input.exposure.markUncertain(id, 'The gateway has not reconciled every attempt. The complete local hold remains reserved.');
      return input.exposure.settle(id, detail);
    },
    ...(input.exposure.beforeDispatch ? { beforeDispatch: (hold) => input.exposure.beforeDispatch!(hold) } : {}),
  };
  const { base, account, connectionId, model, managed, token, effort, limits, ...rest } = input;
  try {
    return await respondStream({
      ...rest,
      transport: async (url, init) => {
        const response = await (input.transport ?? globalThis.fetch)(url, init);
        gatewayCharge = response.headers.get('x-nectovia-charge');
        return response;
      },
      exposure,
      secret: token,
      limits: nectoviaLimits(limits, snapshot, managed.tier),
      binding: nectoviaBinding({
        base,
        connectionId,
        model,
        effort,
        managed,
        attemptId: () => attemptId,
        parentAttemptId,
        routing: snapshot,
        nativeRouteId: nativeRoutes.values().next().value,
        onReceipt: receipt => { gatewayReceipt = receipt; },
        // Ask for summaries only from a gateway that says it accepts them.
        summaries: Boolean(rest.onReasoningDelta) && account.policy?.()?.reasoningSummaries?.[managed.tier] === true,
      }),
    });
  } catch (error) {
    if (error instanceof ModelApiError && error.code === 'nectovia_receipt_invalid' && attemptId)
      await input.exposure.markUncertain(attemptId, error.message);
    if (error instanceof ModelApiError && gatewayCharge === 'uncertain' && !allAttemptsReleased())
      throw withReceipt(new ModelApiError(error.code, 'Nectovia could not complete this request. A recorded attempt may have incurred a charge; its cost remains reserved. Review the run before retrying.', error.dispatched, error.evidence));
    if (!(error instanceof ModelApiError)) throw error;
    if (error.code !== 'nectovia_policy_changed') throw withReceipt(error);
    const policy = await account.refreshPolicy().catch(() => null);
    const now = policy?.tiers[managed.tier] ?? null;
    throw withReceipt(new ModelApiError(
      error.code,
      now
        ? `Nectovia now runs ${tierName(managed.tier)} on ${now.label}. Send your message again to use it.`
        : `${tierName(managed.tier)} is unavailable right now. Choose another tier.`,
      error.dispatched,
      error.evidence,
    ));
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
  if (!published) return refuse(`${tierName(style)} is unavailable right now. Choose another tier.`);
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
  'Build and Fix aren\'t available for the Nectovia Agent in this conversation.';

/**
 * Managed loops require one stable root job and fresh admission before every model step.
 * Delegates and teams are not admitted on this route; they have separate jobs.
 */
export const NECTOVIA_LOOP_REFUSED = 'This Nectovia loop needs its own managed job. Delegates and teams are unavailable on this route.';
