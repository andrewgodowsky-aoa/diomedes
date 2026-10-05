/**
 * The managed inference gateway (contract `nectovia-managed/1`,
 * docs/implementation/2026-09-25-managed-inference-gateway.md).
 *
 * A paying customer's bot calls a model on the company's provider account
 * through `POST /managed/v1/responses`, and the organization's credit is
 * debited for exactly what the call used. Customers never hold a provider key;
 * this is the only code that sends one.
 *
 * This module is not a general proxy. It forwards only the allowlisted body
 * below, only to the endpoint the resolved route's registry row names, and only
 * with the credential that row names.
 *
 * Nothing here reimplements the hold lifecycle: identity is AccountService's,
 * entitlement and routing are the commercial records', and every hold moves
 * through FundingService (openJob, reserve, markDispatched, settle,
 * markUncertain, releaseRefused).
 *
 * `POST /managed/v1/evaluations` is the second route through the same checks
 * and the same hold lifecycle: one typed evaluation (Jev, on OpenRouter's
 * Decisions API), held, sent once and settled before it answers
 * (docs/implementation/2026-09-26-jev-managed-evaluations.md).
 */
import { EVALUATION_OUTPUT_TOKENS_PER_QUESTION, checkEvaluationRequest } from '../../../shared/evaluation-wire.js';
import { FEATURE_LABELS } from '../../../shared/access.js';
import { individualIncludesMonthlyCredits } from '../../../shared/individual-plan.js';
import { individualCycleId, type IndividualBillingCycle } from '../../../shared/individual-period.js';
import { inputTokenBound } from '../../../shared/token-bound.js';
import { normalizeUsage } from '../../../shared/usage-contract.js';
import {
  approvedJobCap,
  isJobTier,
  isUsageClass,
  micro,
  periodIdFor,
  publishedMonthlyGrant,
  usageCost,
  type AttemptSettlement,
  type ChargeKind,
  type FundedAttempt,
  type JobTier,
  type MicroUsd,
  type RateSnapshot,
  type UsageClass,
} from '../../../shared/managed-usage.js';
import { decideAgentAdmission, snapshotFromView } from '../contract/contract.js';
import type { AccountService } from './account-service.js';
import {
  currentIndividualCycle,
  entitlementFromGrants,
  individualEntitlement,
  grantState,
  type AdmissionRecord,
  type PersonalAdmissionRecord,
  type PersonFeatureGrant,
  type CommercialRepository,
  type FeatureGrant,
  type RouteEntry,
  type TierPolicy,
} from './commercial.js';
import { digest, readBytes } from './crypto.js';
import { accountId, type AccountMembershipSnapshot } from './domain.js';
import { AccountError } from './errors.js';
import { DEFAULT_MANDATORY_RESTRICTIONS, hardRestrictionsSchema, resolveRoutingCandidates, mayFailOver, routingScopeKey,
  type AccountScope, type RequestEnvelope, type FailureKind, type RoutingReceipt } from '../../../shared/routing-policy.js';
import { approvedConnections, callManagedProvider, connectionCredential, providerBody, prepareManagedProvider, nativeRouteId, supportsReasoningSummaries } from './managed-bindings.js';
import { BindingError, canonicalJson, sseObjects } from './managed-normalization.js';
import { authorizeScope, effectivePolicy, defaultEnvelope, routesWithCircuits } from './routing.js';
import { FundingError, RELEASABLE_REFUSALS, type AttemptRef, type FundingRepository, type FundingService } from './funding.js';
import { MEMBER_LIMIT_REACHED } from '../../../shared/credit-allotments.js';
import type { MemberRole } from '../../../shared/workspaces.js';
import {
  EVALUATION_PROVIDER,
  MANAGED_PROVIDERS,
  answeredAs,
  credentialFor,
  credentialProblem,
  decisionsBody,
  decisionsUsage,
  evaluationReply,
  openRouterDecisionsCaller,
  registryRow,
  type EvaluationProviderCaller,
  type EvaluationProviderRow,
  type ProviderCaller,
  type ProviderEnv,
  type ProviderRegistryRow,
} from './managed-providers.js';

// --- the request body allowlist (contract section 1) -----------------------------------------

export type BodyRefusalCode = 'unsupported_field' | 'invalid_body';
export type BodyRefusal = { ok: false; code: BodyRefusalCode; field: string; message: string };

/** A body that passed the allowlist. Fields are exactly the client's; nothing has been added yet. */
export interface ResponsesBody {
  readonly [key: string]: unknown;
  readonly model: string;
  readonly input: readonly Record<string, unknown>[];
  readonly max_output_tokens?: number;
}

class Refusal {
  constructor(readonly code: BodyRefusalCode, readonly field: string, readonly message: string) {}
}
const unsupported = (field: string, message = `Nectovia’s managed model service does not accept ${field}.`): never => {
  throw new Refusal('unsupported_field', field, message);
};
const invalid = (field: string, message: string): never => {
  throw new Refusal('invalid_body', field, message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (base: string, key: string) => (base ? `${base}.${key}` : key);
function only(value: Record<string, unknown>, field: string, allowed: readonly string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(at(field, key));
}
function text(value: unknown, field: string, max = 10_000_000) {
  if (typeof value !== 'string' || value.length > max) invalid(field, `${field} must be text.`);
}

const TOP_LEVEL = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'include',
  'max_output_tokens', 'store', 'stream', 'text'] as const;
const MESSAGE_ROLES = ['developer', 'system', 'user', 'assistant'];
const MESSAGE_PARTS = ['input_text', 'output_text', 'input_image'];
const TOOL_OUTPUT_PARTS = ['input_text', 'input_image'];
const DATA_IMAGE = /^data:image\/[A-Za-z0-9.+-]{1,64};base64,[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_DETAIL = ['low', 'high', 'auto'];
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOLS = 64;
const MAX_TOOL_BYTES = 16_384;

function part(value: unknown, field: string, allowed: readonly string[]) {
  if (!isObject(value)) return invalid(field, `${field} must be a content part.`);
  if (typeof value.type !== 'string') return invalid(at(field, 'type'), `${at(field, 'type')} must be text.`);
  if (!allowed.includes(value.type)) unsupported(at(field, 'type'), `Nectovia’s managed model service does not accept ${value.type} content (${at(field, 'type')}).`);
  if (value.type === 'input_image') {
    only(value, field, ['type', 'image_url', 'detail']);
    if (typeof value.image_url !== 'string') return invalid(at(field, 'image_url'), `${at(field, 'image_url')} must be an inline data: image.`);
    if (!DATA_IMAGE.test(value.image_url))
      unsupported(at(field, 'image_url'), `Only inline data: images are accepted, so ${at(field, 'image_url')} was refused; a remote image is never fetched.`);
    if (value.detail !== undefined) {
      if (typeof value.detail !== 'string') return invalid(at(field, 'detail'), `${at(field, 'detail')} must be low, high or auto.`);
      if (!IMAGE_DETAIL.includes(value.detail))
        unsupported(at(field, 'detail'), `${at(field, 'detail')} ${value.detail} is not accepted; use low, high or auto.`);
    }
    return;
  }
  only(value, field, ['type', 'text']);
  text(value.text, at(field, 'text'));
}

function item(value: unknown, field: string) {
  if (!isObject(value)) return invalid(field, `${field} must be an input item.`);
  const type = value.type;
  if (type === undefined || type === 'message') {
    only(value, field, ['type', 'role', 'content', 'phase']);
    if (typeof value.role !== 'string') return invalid(at(field, 'role'), `${at(field, 'role')} must be text.`);
    if (!MESSAGE_ROLES.includes(value.role))
      unsupported(at(field, 'role'), `Nectovia’s managed model service does not accept a ${value.role} message (${at(field, 'role')}).`);
    if (value.phase !== undefined) {
      if (value.role !== 'assistant') unsupported(at(field, 'phase'), `Only an assistant message carries a phase, so ${at(field, 'phase')} was refused.`);
      if (typeof value.phase !== 'string' || value.phase.length > 32)
        invalid(at(field, 'phase'), `${at(field, 'phase')} must be text of at most 32 characters.`);
    }
    if (typeof value.content === 'string') return;
    if (!Array.isArray(value.content)) return invalid(at(field, 'content'), `${at(field, 'content')} must be text or a list of content parts.`);
    value.content.forEach((entry, index) => part(entry, `${field}.content[${index}]`, MESSAGE_PARTS));
    return;
  }
  if (type === 'function_call') {
    only(value, field, ['type', 'call_id', 'name', 'arguments']);
    text(value.call_id, at(field, 'call_id'), 256);
    text(value.name, at(field, 'name'), 128);
    text(value.arguments, at(field, 'arguments'));
    return;
  }
  if (type === 'function_call_output') {
    only(value, field, ['type', 'call_id', 'output']);
    text(value.call_id, at(field, 'call_id'), 256);
    if (typeof value.output === 'string') return;
    if (!Array.isArray(value.output)) return invalid(at(field, 'output'), `${at(field, 'output')} must be text or a list of content parts.`);
    value.output.forEach((entry, index) => part(entry, `${field}.output[${index}]`, TOOL_OUTPUT_PARTS));
    return;
  }
  if (type === 'reasoning') {
    only(value, field, ['type', 'id', 'encrypted_content', 'summary']);
    if (value.id !== undefined) text(value.id, at(field, 'id'), 256);
    if (value.encrypted_content === undefined || value.encrypted_content === null)
      unsupported(at(field, 'encrypted_content'), `Reasoning is carried back only with its encrypted content, and ${at(field, 'encrypted_content')} is missing.`);
    text(value.encrypted_content, at(field, 'encrypted_content'));
    if (value.summary === undefined) return;
    if (!Array.isArray(value.summary)) return invalid(at(field, 'summary'), `${at(field, 'summary')} must be a list.`);
    value.summary.forEach((entry, index) => {
      const name = `${field}.summary[${index}]`;
      if (!isObject(entry)) return invalid(name, `${name} must be a summary part.`);
      only(entry, name, ['type', 'text']);
      if (entry.type !== 'summary_text') unsupported(at(name, 'type'));
      text(entry.text, at(name, 'text'));
    });
    return;
  }
  if (typeof type === 'string')
    unsupported(at(field, 'type'), `Nectovia’s managed model service does not accept a ${type} item (${at(field, 'type')}).`);
  invalid(at(field, 'type'), `${at(field, 'type')} must be text.`);
}

function tools(value: unknown): Set<string> {
  const names = new Set<string>();
  if (value === undefined) return names;
  if (!Array.isArray(value)) return invalid('tools', 'tools must be a list.');
  if (value.length > MAX_TOOLS) invalid('tools', `At most ${MAX_TOOLS} tools can be offered in one request.`);
  const encoder = new TextEncoder();
  value.forEach((tool, index) => {
    const field = `tools[${index}]`;
    if (!isObject(tool)) return invalid(field, `${field} must be a tool.`);
    if (tool.type !== 'function') {
      if (typeof tool.type === 'string')
        unsupported(at(field, 'type'), `Only function tools can be offered; ${at(field, 'type')} names the built-in tool ${tool.type}.`);
      invalid(at(field, 'type'), `${at(field, 'type')} must be function.`);
    }
    only(tool, field, ['type', 'name', 'description', 'parameters', 'strict']);
    if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name))
      invalid(at(field, 'name'), `${at(field, 'name')} must be a function name of letters, digits, _ or -.`);
    if (names.has(tool.name as string)) invalid(at(field, 'name'), `${at(field, 'name')} repeats a tool name.`);
    names.add(tool.name as string);
    if (tool.description !== undefined) text(tool.description, at(field, 'description'));
    if (!isObject(tool.parameters)) invalid(at(field, 'parameters'), `${at(field, 'parameters')} must be a JSON schema object.`);
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') invalid(at(field, 'strict'), `${at(field, 'strict')} must be true or false.`);
    if (encoder.encode(JSON.stringify(tool)).byteLength > MAX_TOOL_BYTES)
      invalid(field, `Each tool must be at most 16 KB when serialized, and ${field} is larger.`);
  });
  return names;
}

function validate(value: unknown): ResponsesBody {
  if (!isObject(value)) return invalid('body', 'The request body must be a JSON object.');
  only(value, '', TOP_LEVEL);
  if (typeof value.model !== 'string' || !value.model || value.model.length > 200) invalid('model', 'model must name the model the tier resolves to.');
  if (!Array.isArray(value.input) || value.input.length === 0) invalid('input', 'input must be a non-empty list of items.');
  (value.input as unknown[]).forEach((entry, index) => item(entry, `input[${index}]`));
  if (value.instructions !== undefined) text(value.instructions, 'instructions');
  const offered = tools(value.tools);
  const choice = value.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) unsupported('tool_choice', `tool_choice ${choice} is not accepted; use auto, none, required or a listed function.`);
    } else if (isObject(choice)) {
      if (choice.type !== 'function') unsupported('tool_choice.type', 'tool_choice can only name a listed function.');
      only(choice, 'tool_choice', ['type', 'name']);
      if (typeof choice.name !== 'string' || !offered.has(choice.name)) invalid('tool_choice.name', 'tool_choice.name must name a function listed in tools.');
    } else invalid('tool_choice', 'tool_choice must be auto, none, required or a listed function.');
  }
  if (value.parallel_tool_calls !== undefined) {
    if (typeof value.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls', 'parallel_tool_calls must be false.');
    if (value.parallel_tool_calls) unsupported('parallel_tool_calls', 'parallel_tool_calls must be false; one tool call is made at a time.');
  }
  if (value.reasoning !== undefined) {
    const reasoning = value.reasoning;
    if (!isObject(reasoning)) return invalid('reasoning', 'reasoning must be an object.');
    only(reasoning, 'reasoning', ['effort', 'summary']);
    if (typeof reasoning.effort !== 'string') invalid('reasoning.effort', 'reasoning.effort must be low, medium or high.');
    if (!['low', 'medium', 'high'].includes(reasoning.effort as string))
      unsupported('reasoning.effort', `reasoning.effort ${String(reasoning.effort)} is not accepted; use low, medium or high.`);
    if ('summary' in reasoning && reasoning.summary !== null && !['auto', 'concise', 'detailed'].includes(reasoning.summary as string))
      unsupported('reasoning.summary', 'reasoning.summary may be auto, concise, detailed or null.');
  }
  if (value.include !== undefined) {
    if (!Array.isArray(value.include)) invalid('include', 'include must be a list.');
    if ((value.include as unknown[]).length !== 1 || (value.include as unknown[])[0] !== 'reasoning.encrypted_content')
      unsupported('include', 'include may only ask for reasoning.encrypted_content.');
  }
  if (value.max_output_tokens !== undefined &&
      (typeof value.max_output_tokens !== 'number' || !Number.isSafeInteger(value.max_output_tokens) || value.max_output_tokens < 1))
    invalid('max_output_tokens', 'max_output_tokens must be a whole number of at least 1.');
  if (value.store !== undefined) {
    if (typeof value.store !== 'boolean') invalid('store', 'store must be false.');
    if (value.store) unsupported('store', 'store must be false; Nectovia never asks the provider to keep a conversation.');
  }
  if (value.stream !== undefined) {
    if (typeof value.stream !== 'boolean') invalid('stream', 'stream must be true.');
    if (!value.stream) unsupported('stream', 'stream must be true; the managed model service only streams.');
  }
  if (value.text !== undefined) {
    const output = value.text;
    if (!isObject(output)) return invalid('text', 'text must be an object.');
    only(output, 'text', ['format']);
    const format = output.format;
    if (!isObject(format)) return invalid('text.format', 'text.format must be an object.');
    if (format.type === 'text') only(format, 'text.format', ['type']);
    else if (format.type === 'json_schema') {
      only(format, 'text.format', ['type', 'name', 'schema', 'strict', 'description']);
      if (typeof format.name !== 'string' || !TOOL_NAME.test(format.name)) invalid('text.format.name', 'text.format.name must be a short name of letters, digits, _ or -.');
      if (format.description !== undefined && (typeof format.description !== 'string' || format.description.length > 1_000))
        invalid('text.format.description', 'text.format.description must be text of at most 1,000 characters.');
      if (!isObject(format.schema)) invalid('text.format.schema', 'text.format.schema must be a JSON schema object.');
      if (format.strict !== undefined && typeof format.strict !== 'boolean') invalid('text.format.strict', 'text.format.strict must be true or false.');
    } else if (typeof format.type === 'string') unsupported('text.format.type', `text.format.type ${format.type} is not accepted; use text or json_schema.`);
    else invalid('text.format.type', 'text.format.type must be text or json_schema.');
  }
  return value as unknown as ResponsesBody;
}

/** Check a parsed request body against the allowlist. The first thing outside it is named. */
export function validateResponsesBody(value: unknown): { ok: true; body: ResponsesBody } | BodyRefusal {
  try {
    return { ok: true, body: validate(value) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, field: error.field, message: error.message };
    throw error;
  }
}

/** JSON with every object's keys sorted, so one body always has one digest. */
export { canonicalJson } from './managed-normalization.js';

// --- refusals ------------------------------------------------------------------------------

/** Every non-2xx answer is `{ error: { code, message } }`, the message a sentence a customer can read. */
export class ManagedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'ManagedError';
  }
}

export const ROUTE_UNAVAILABLE = 'Nectovia’s model service is not available right now.';
const unavailable = () => new ManagedError(503, 'route_unavailable', ROUTE_UNAVAILABLE);
/** The company spend ceiling's only customer-facing words: nothing about the ceiling itself. */
export const CEILING_REFUSAL = 'Nectovia’s model service isn’t available right now. Nothing was charged.';
const ceilingReached = () => new ManagedError(503, 'route_unavailable', CEILING_REFUSAL);
/** Why a call is refused when the business's current grants hold the Agent but not included AI usage. */
export const MANAGED_USAGE_NOT_INCLUDED = `${FEATURE_LABELS['managed-inference']} isn’t part of this business’s plan, so the Nectovia Agent can’t answer here. Nothing was charged.`;
/** The contract names these three funding refusals as 402, whatever status FundingService gives them. */
const PAYMENT_REFUSALS: ReadonlySet<string> = new Set(['insufficient_allowance', 'cap_request_required', 'no_period', MEMBER_LIMIT_REACHED]);
/** An evaluation no provider could take under the data policy: it reached no model and was released. */
export const PROVIDER_POLICY_REFUSAL = 'No provider that meets Nectovia’s data policy can take this right now. Nothing was charged.';

export function managedHeaders(): Headers {
  return new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
}

/** The one place a refusal becomes a response. An unexpected failure says nothing about itself. */
export function managedErrorResponse(error: unknown, headers: Headers = managedHeaders(), receipt?: RoutingReceipt): Response {
  let refusal: ManagedError;
  if (error instanceof ManagedError) refusal = error;
  else if (error instanceof FundingError && error.code === 'company_ceiling') refusal = ceilingReached();
  else if (error instanceof FundingError)
    refusal = new ManagedError(PAYMENT_REFUSALS.has(error.code) ? 402 : error.status, error.code, error.message);
  else if (error instanceof AccountError) refusal = new ManagedError(error.status, error.code ?? 'scope_forbidden', error.message);
  else {
    console.error(JSON.stringify({ event: 'managed-gateway-unavailable' }));
    refusal = new ManagedError(503, 'unavailable', 'Nectovia’s account service is unavailable. Try again shortly.', { 'Retry-After': '5' });
  }
  for (const [name, value] of Object.entries(refusal.headers)) headers.set(name, value);
  return Response.json({ error: { code: refusal.code, message: refusal.message }, ...(receipt ? { nectovia: receipt } : {}) }, { status: refusal.status, headers });
}

// --- headers (contract section 1) -------------------------------------------------------------

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BEARER = /^Bearer [A-Za-z0-9._~-]+$/;
const REVISION = /^(0|[1-9][0-9]{0,14})$/;
const isRunId = (value: string) => RUN_ID.test(value);
const isAccountId = (value: string) => accountId.safeParse(value).success;
const isBearer = (value: string) => value.length <= 16_391 && BEARER.test(value);

function header(headers: Headers, name: string, valid: (value: string) => boolean): string {
  const value = headers.get(name);
  if (value === null || !valid(value)) throw new ManagedError(400, 'invalid_header', `The ${name} header is missing or not valid.`);
  return value;
}

/** What every managed call carries: who, for which business, under which admission, job and attempt. */
interface JobHeaders {
  token: string;
  organizationId: string;
  admissionId: string;
  jobId: string;
  attemptId: string;
  parentAttemptId: string | null;
  tier: JobTier;
  usageClass: UsageClass;
  scope: AccountScope;
}

/** A response also names the routing policy revision its model was resolved from. */
interface GatewayHeaders extends JobHeaders {
  policyRevision: number;
  protocol: string | null;
  globalRevision: number;
  scopeRevision: number;
  preferenceRevision: number;
  routeRevision: number;
  checkpoint: string | null;
  sourceRestrictions: import('../../../shared/routing-policy.js').HardRestrictions[];
}

function jobHeaders(headers: Headers): JobHeaders {
  const token = header(headers, 'Authorization', isBearer).slice('Bearer '.length);
  const individual = headers.get('X-Nectovia-Scope-Kind') === 'individual';
  if (headers.has('X-Nectovia-Scope-Kind') && !['individual', 'organization'].includes(headers.get('X-Nectovia-Scope-Kind')!))
    throw new ManagedError(400, 'invalid_header', 'The account scope kind is invalid.');
  const organizationId = header(headers, individual ? 'X-Nectovia-Account' : 'X-Nectovia-Organization', isAccountId);
  if (individual && headers.has('X-Nectovia-Organization')) throw new ManagedError(400, 'invalid_header', 'Choose exactly one account scope.');
  const admissionId = header(headers, 'X-Nectovia-Admission', isAccountId);
  const jobId = header(headers, 'X-Nectovia-Job', isRunId);
  const attemptId = header(headers, 'X-Nectovia-Attempt', isRunId);
  const parentAttemptId = headers.has('X-Nectovia-Parent-Attempt') ? header(headers, 'X-Nectovia-Parent-Attempt', isRunId) : null;
  const tier = header(headers, 'X-Nectovia-Tier', isJobTier) as JobTier;
  const usageClass = header(headers, 'X-Nectovia-Usage-Class', isUsageClass) as UsageClass;
  return { token, organizationId, admissionId, jobId, attemptId, parentAttemptId, tier, usageClass,
    scope: { kind: individual ? 'individual' : 'organization', id: organizationId } };
}

function gatewayHeaders(headers: Headers): GatewayHeaders {
  const job = jobHeaders(headers);
  const revision = header(headers, 'X-Nectovia-Policy-Revision', (value) => REVISION.test(value) && Number.isSafeInteger(Number(value)));
  const optionalRevision = (name: string) => headers.has(name) ? Number(header(headers, name, value => REVISION.test(value))) : 0;
  return { ...job, policyRevision: Number(revision), protocol: headers.get('X-Nectovia-Protocol'),
    globalRevision: optionalRevision('X-Nectovia-Global-Revision'), scopeRevision: optionalRevision('X-Nectovia-Scope-Revision'),
    preferenceRevision: optionalRevision('X-Nectovia-Preference-Revision'), routeRevision: optionalRevision('X-Nectovia-Route-Revision'),
    checkpoint: headers.get('X-Nectovia-Checkpoint'), sourceRestrictions: sourceRestrictionHeaders(headers) };
}

function sourceRestrictionHeaders(headers: Headers): GatewayHeaders['sourceRestrictions'] {
  let sourceRestrictions: GatewayHeaders['sourceRestrictions'] = [];
  const source = headers.get('X-Nectovia-Source-Restrictions');
  if (source !== null) {
    try {
      if (source.length > 16_384) throw new Error('limit');
      const parsed: unknown = JSON.parse(source);
      if (!Array.isArray(parsed) || parsed.length > 32) throw new Error('limit');
      sourceRestrictions = parsed.map(v => hardRestrictionsSchema.parse(v));
    } catch { throw new ManagedError(400, 'invalid_header', 'Source restrictions are invalid.'); }
  }
  return sourceRestrictions;
}

// --- the owner's spend controls ----------------------------------------------------------------

/**
 * Two optional settings, read from the Worker's environment (or the faux
 * cloud's) at call time, beside BEDROCK_API_KEY:
 *
 * - MANAGED_SPEND_CEILING_MICRO_USD: the most the company's provider account
 *   may owe, across every tenant and organization and for all time: settled
 *   provider cost plus every open hold in full plus the new hold. A call that
 *   would pass it is refused before any hold (FundingService.reserve checks it
 *   inside the reserving transaction). Unset: no company ceiling.
 * - MANAGED_MAX_OUTPUT_TOKENS: lowers the registry row's output cap, never
 *   raises it. A request asking for more is clamped silently, and the clamp is
 *   named in X-Nectovia-Max-Output. Unset: the registry's cap.
 *
 * Blank is unset. Any other value that is not a whole number in range refuses
 * every managed call with 503 route_unavailable, sending and holding nothing:
 * a spend limit that ignored a typo would not be a limit.
 */
export const SPEND_SETTINGS = ['MANAGED_SPEND_CEILING_MICRO_USD', 'MANAGED_MAX_OUTPUT_TOKENS'] as const;
export type SpendSetting = typeof SPEND_SETTINGS[number];

interface SpendControls {
  ceilingMicroUsd: MicroUsd | null;
  maxOutputTokens: number | null;
}

function wholeSetting(env: ProviderEnv, name: SpendSetting, minimum: number): number | null {
  const value = env[name];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const count = typeof value === 'number' ? value
    : typeof value === 'string' && /^[0-9]{1,16}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < minimum) {
    console.error(JSON.stringify({ event: 'managed-setting-unreadable', setting: name }));
    throw unavailable();
  }
  return count;
}

export function spendControls(env: ProviderEnv): SpendControls {
  const ceiling = wholeSetting(env, 'MANAGED_SPEND_CEILING_MICRO_USD', 0);
  return { ceilingMicroUsd: ceiling === null ? null : micro(ceiling), maxOutputTokens: wholeSetting(env, 'MANAGED_MAX_OUTPUT_TOKENS', 1) };
}

// --- the provider stream --------------------------------------------------------------------

type Terminal = { type: string; response: Record<string, unknown> };
type StreamOutcome = { kind: 'ended'; terminal: Terminal | null } | { kind: 'failed' } | { kind: 'cancelled' };

const TERMINAL_TYPES: ReadonlySet<string> = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const TERMINAL_EVENT = /"type"\s*:\s*"response\.(?:completed|incomplete|failed)"/;
const MAX_TAP_BYTES = 8_000_000;

/**
 * Reads the SSE text as it passes, for the one thing settlement needs: the
 * last `response.completed`, `response.incomplete` or `response.failed` event.
 * It never changes, delays or adds a byte; the stream is forwarded as it came.
 */
class TerminalTap {
  terminal: Terminal | null = null;
  private buffer = '';
  private data: string[] = [];
  private held = 0;
  private broken = false;

  push(text: string) {
    if (this.broken || !text) return;
    this.buffer += text;
    let start = 0;
    for (;;) {
      const lf = this.buffer.indexOf('\n', start);
      const cr = this.buffer.indexOf('\r', start);
      if (lf < 0 && cr < 0) break;
      let end: number;
      let next: number;
      if (cr >= 0 && (lf < 0 || cr < lf)) {
        // A CR at the very end may be the first half of a CRLF still in flight.
        if (cr === this.buffer.length - 1) break;
        end = cr;
        next = this.buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
      } else {
        end = lf;
        next = lf + 1;
      }
      this.line(this.buffer.slice(start, end));
      start = next;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length + this.held > MAX_TAP_BYTES) {
      // An event this large is not one this tap can read. Settlement then finds no usage.
      this.broken = true;
      this.buffer = '';
      this.data = [];
      this.terminal = null;
    }
  }

  end() {
    if (this.broken) return;
    if (this.buffer) this.line(this.buffer);
    this.buffer = '';
    this.line('');
  }

  private line(line: string) {
    if (line === '') {
      if (this.data.length) this.event(this.data.join('\n'));
      this.data = [];
      this.held = 0;
      return;
    }
    if (line.startsWith('data:')) {
      const value = line.slice(line.startsWith('data: ') ? 6 : 5);
      this.data.push(value);
      this.held += value.length;
    }
  }

  private event(data: string) {
    if (!TERMINAL_EVENT.test(data)) return;
    try {
      const value: unknown = JSON.parse(data);
      if (isObject(value) && typeof value.type === 'string' && TERMINAL_TYPES.has(value.type) && isObject(value.response))
        this.terminal = { type: value.type, response: value.response };
    } catch {
      // Not an event this tap can read; the stream itself is unaffected.
    }
  }
}

/** Responses usage in the `nectovia-usage/1` counts, mapped the way the desktop's AWS route maps it. */
export function responsesUsage(usage: Record<string, unknown>) {
  const input = isObject(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const output = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return {
    inputTokens: usage.input_tokens,
    cacheReadTokens: input.cached_tokens ?? 0,
    cacheWriteTokens: input.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningTokens: output.reasoning_tokens ?? 0,
  };
}

/** Settle for the first of a promise or a deadline; the deadline runs `onTimeout` and rejects. */
function within<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('The provider went silent.'));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const REFUSED = 'The model provider refused this request.';

/** A provider's refusal sentence with the key taken out, at most 300 characters. A fragment of the key voids it. */
export function scrubbed(text: string, secret: string): string {
  const clean = text.split(secret).join('[redacted]');
  const size = Math.min(12, secret.length);
  for (let at = 0; at + size <= secret.length; at++) if (clean.includes(secret.slice(at, at + size))) return REFUSED;
  const chars = Array.from(clean);
  return chars.length > 300 ? chars.slice(0, 300).join('') : clean;
}

/** OpenRouter's words for a request no endpoint was allowed to take. */
const NO_ENDPOINT = /no (?:allowed )?(?:providers|endpoints)|data policy/i;

/**
 * A provider's refusal, read once: its sentence with the key taken out, and
 * whether it says no endpoint could take the request at all (OpenRouter filters
 * endpoints before it sends, and then reports `openrouter_metadata.attempt` 0).
 */
async function providerRefusal(response: Response, credential: string): Promise<{ message: string; unrouted: boolean }> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await readBytes(response, 65_536)));
    const said = isObject(value) && isObject(value.error) && typeof value.error.message === 'string' && value.error.message.trim()
      ? value.error.message : null;
    const metadata = isObject(value) && isObject(value.openrouter_metadata) ? value.openrouter_metadata : null;
    return { message: said === null ? REFUSED : scrubbed(said, credential), unrouted: metadata?.attempt === 0 || (said !== null && NO_ENDPOINT.test(said)) };
  } catch {
    // An unreadable refusal is still a refusal.
    return { message: REFUSED, unrouted: false };
  }
}

export async function providerMessage(response: Response, credential: string): Promise<string> {
  return (await providerRefusal(response, credential)).message;
}

/** The customer's answer to a provider refusal whose hold was released. It never says our key failed. */
function releasedRefusal(status: number, detail: string | null, retryAfter: string | null): ManagedError {
  if (status === 429)
    return new ManagedError(429, 'provider_busy', 'Nectovia’s model service is busy right now. Try again shortly.',
      retryAfter !== null && /^[\x20-\x7e]{1,64}$/.test(retryAfter) ? { 'Retry-After': retryAfter } : {});
  if (status === 401 || status === 403 || status === 404) return unavailable();
  return new ManagedError(400, 'provider_refused', detail ?? REFUSED);
}

/**
 * A hold at the dearest input-side rate (fresh input, cache write or cache
 * read) for every input token the bound allows, so no mix of cache use can
 * cost more than the hold, plus the output bound at the output rate, rounded up.
 */
function holdFor(rate: RateSnapshot, inputBound: number, outputBound: number): MicroUsd {
  const inputRate = Math.max(rate.inputMicroUsdPerMillion, rate.cacheWriteMicroUsdPerMillion, rate.cacheReadMicroUsdPerMillion);
  return micro(Number(
    (BigInt(inputBound) * BigInt(inputRate) + BigInt(outputBound) * BigInt(rate.outputMicroUsdPerMillion) + 999_999n) / 1_000_000n,
  ));
}

// --- the gateway (contract sections 2 and 3) -------------------------------------------------

export const MANAGED_CONTRACT = 'nectovia-managed/1';
export const MAX_REQUEST_BYTES = 2_000_000;
/** An evaluation body: far above what its 32,000-token bound can fill, far below a response's. */
export const MAX_EVALUATION_REQUEST_BYTES = 524_288;
/** The most of a provider's evaluation answer the gateway reads. The desktop keeps 65,536 bytes of it. */
export const MAX_EVALUATION_ANSWER_BYTES = 262_144;
/** Output held per question (shared/evaluation-wire.ts), the same bound the desktop's guard holds. */
export { EVALUATION_OUTPUT_TOKENS_PER_QUESTION };
/** v1 refuses long-context pricing rather than guessing it. */
export const MAX_INPUT_TOKEN_BOUND = 272_000;
export const ADMISSION_WINDOW_MS = 15 * 60_000;
/** How long the provider may stay silent: before it answers, and between chunks. */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const RELEASABLE_STATUSES: ReadonlySet<number> = new Set(RELEASABLE_REFUSALS);
const TIER_LABEL: Readonly<Record<JobTier, string>> = { efficient: 'Efficient', focused: 'Focused', thorough: 'Thorough' };

export interface ManagedContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ManagedInferenceOptions {
  accounts: Pick<AccountService, 'membership' | 'signIn'>;
  commercial: CommercialRepository;
  funding: FundingService;
  /** Reads only: whether this month has a credit period, and one attempt with its settlement. */
  fundingReads: FundingRepository;
  caller: ProviderCaller;
  registry?: readonly ProviderRegistryRow[];
  /** The typed-evaluation provider. Default: OpenRouter's Decisions API over the global fetch. */
  evaluationCaller?: EvaluationProviderCaller;
  /** The typed-evaluation route. Default: `EVALUATION_PROVIDER`. */
  evaluationProvider?: EvaluationProviderRow;
  now?: () => number;
  idleTimeoutMs?: number;
  /** The transport fixture replaces HTTP only; it cannot bypass binding/policy/funding code. */
  bindingTransport?: typeof globalThis.fetch;
}

interface Dispatch {
  ref: AttemptRef;
  row: ProviderRegistryRow;
  credential: string;
  body: string;
  headers: Headers;
  ctx?: ManagedContext;
}

const inFlight = () => new ManagedError(409, 'attempt_in_flight', 'That request is already being answered.');

/** A request body as JSON, or the refusal a customer reads. */
function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ManagedError(400, 'invalid_body', 'The request body is not valid JSON.');
  }
}

export class ManagedInferenceService {
  private readonly now: () => number;
  private readonly registry: readonly ProviderRegistryRow[];
  private readonly idleTimeoutMs: number;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: ManagedInferenceOptions) {
    this.now = options.now ?? Date.now;
    this.registry = options.registry ?? MANAGED_PROVIDERS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  private at() {
    return new Date(this.now()).toISOString();
  }

  /** Resolves once every settlement started so far has finished. The faux cloud and tests wait on it. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** `POST /managed/v1/responses`. Every refusal before dispatch sends nothing and holds nothing. */
  async respond(request: Request, env: ProviderEnv, ctx?: ManagedContext): Promise<Response> {
    const headers = managedHeaders();
    const attempt = request.headers.get('x-nectovia-attempt');
    if (attempt !== null && RUN_ID.test(attempt)) headers.set('X-Nectovia-Attempt', attempt);
    try {
      return await this.run(request, env, headers, ctx);
    } catch (error) {
      return managedErrorResponse(error, headers);
    }
  }

  /** `GET /managed/v1/attempts/:attemptId`: one of the organization's attempts, and nobody else's. */
  async attempt(request: Request, attemptId: string): Promise<Response> {
    const headers = managedHeaders();
    try {
      const token = header(request.headers, 'Authorization', isBearer).slice('Bearer '.length);
      const individual = request.headers.get('X-Nectovia-Scope-Kind') === 'individual';
      const organizationId = header(request.headers, individual ? 'X-Nectovia-Account' : 'X-Nectovia-Organization', isAccountId);
      const { tenantId } = await authorizeScope(this.options.accounts, this.options.commercial, token,
        { kind: individual ? 'individual' : 'organization', id: organizationId }).catch(error => {
          if (error instanceof AccountError && error.status === 401)
            throw new ManagedError(401, 'sign_in_required', 'Your Nectovia sign-in has ended. Sign in again to continue.');
          if (error instanceof AccountError && error.status === 403 && !individual)
            throw new ManagedError(403, 'not_a_member', 'You are not an active member of this business.');
          throw error;
        });
      const found = RUN_ID.test(attemptId)
        ? await this.options.fundingReads.transaction(async (tx) => ({
            attempt: await tx.attempt(tenantId, attemptId),
            settlement: await tx.settlement(tenantId, attemptId),
          }))
        : { attempt: undefined, settlement: undefined };
      if (!found.attempt || found.attempt.organizationId !== organizationId)
        throw new ManagedError(404, 'unknown_attempt', 'That attempt was not found for this business.');
      const settled = found.settlement;
      return Response.json({
        attemptId,
        state: found.attempt.state,
        routing: found.attempt.rateSnapshot.routing ?? null,
        heldMicroUsd: ['pending', 'uncertain'].includes(found.attempt.state) ? found.attempt.maxMicroUsd : 0,
        providerCostMicroUsd: settled?.providerCostMicroUsd ?? null,
        allowanceDebitMicroUsd: settled?.allowanceDebitMicroUsd ?? null,
        usage: settled
          ? {
              inputTokens: settled.usage.inputTokens,
              cacheReadTokens: settled.usage.cacheReadTokens,
              cacheWriteTokens: settled.usage.cacheWriteTokens,
              outputTokens: settled.usage.outputTokens,
              reasoningTokens: settled.usage.reasoningTokens,
            }
          : null,
      }, { headers });
    } catch (error) {
      return managedErrorResponse(error, headers);
    }
  }

  private async run(request: Request, env: ProviderEnv, headers: Headers, ctx?: ManagedContext): Promise<Response> {
    // 1. Headers.
    const h = gatewayHeaders(request.headers);
    // 2 to 4. Membership, the stored admission and the entitlement.
    const { tenantId, state, member } = await this.admitted(h);
    // 5. The body.
    const bytes = await this.readBody(request, MAX_REQUEST_BYTES);
    const parsed = parseBody(bytes);
    const checked = validateResponsesBody(parsed);
    if (!checked.ok) throw new ManagedError(400, checked.code, checked.message);
    const body = checked.body;
    const scoped = await this.options.commercial.transaction(async tx => {
      h.sourceRestrictions = await tx.restrictJob(routingScopeKey(h.scope), h.jobId, h.sourceRestrictions);
      return effectivePolicy(tx, h.scope);
    });
    if (h.scope.kind === 'individual' || scoped.effective?.routing || scoped.own || scoped.preference) return this.runScoped(request, h, body, bytes, env, headers, ctx);
    if (h.sourceRestrictions.length) throw new ManagedError(409, 'source_policy_unverified', 'The legacy route has no evidence for these source restrictions. Publish a compliant route before continuing.');
    // 6. The route, and the owner's spend controls.
    const controls = spendControls(env);
    const { entry, row, credential } = this.resolve(state.policy, state.routes, h, body, env);
    headers.set('X-Nectovia-Route', entry.id);
    headers.set('X-Nectovia-Model', entry.model);
    headers.set('X-Nectovia-Rate-Card', row.rate.version);
    if ((body.max_output_tokens ?? 0) > row.maxOutputTokens)
      throw new ManagedError(400, 'invalid_body', `max_output_tokens can be at most ${row.maxOutputTokens.toLocaleString('en-US')} here.`);
    // An override only lowers the route's cap. Asking for more than it is clamped, not refused.
    const outputCap = Math.min(row.maxOutputTokens, controls.maxOutputTokens ?? row.maxOutputTokens);
    if (outputCap < row.maxOutputTokens) headers.set('X-Nectovia-Max-Output', String(outputCap));
    const maxOutputTokens = Math.min(body.max_output_tokens ?? outputCap, outputCap);
    // 7. The input bound.
    const bound = inputTokenBound(bytes.byteLength, body.input.length);
    if (bound > MAX_INPUT_TOKEN_BOUND)
      throw new ManagedError(413, 'context_too_long', 'This conversation is too long for one request. Start a new one, or attach less.');
    // 8 to 10. The job, the hold (the input bound and the output cap) and the dispatch commit.
    const ref = await this.holdAndDispatch(h, tenantId, state.grants, {
      kind: 'generation', route: entry.id, requestDigest: await digest(canonicalJson(parsed)), rate: row.rate,
      maxMicroUsd: holdFor(row.rate, bound, maxOutputTokens), ceilingMicroUsd: controls.ceilingMicroUsd, member,
    });
    // 11. The call: the allowlisted body, with the route's model, store off, streaming,
    // and the output cap the hold was priced at.
    const forwarded = JSON.stringify({ ...body, model: entry.model, store: false, stream: true, max_output_tokens: maxOutputTokens });
    return this.dispatch({ ref, row, credential, body: forwarded, headers, ctx });
  }

  /** One request can spend on several explicitly configured attempts; all use the existing root job cap. */
  private async runScoped(request: Request, h: GatewayHeaders, body: ResponsesBody, bytes: Uint8Array, env: ProviderEnv, headers: Headers, ctx?: ManagedContext): Promise<Response> {
    if (h.protocol !== 'nectovia-managed/2') throw new ManagedError(426, 'client_update_required', 'This account uses versioned routing. Update the desktop before continuing.');
    const controls = spendControls(env);
    const outputTokens = Math.min(body.max_output_tokens ?? 0, controls.maxOutputTokens ?? Number.MAX_SAFE_INTEGER);
    if (outputTokens < 1) throw new ManagedError(400, 'invalid_body', 'Provide a positive output bound.');
    const nativeRoutes = [...new Set(body.input.filter(i => i.type === 'reasoning').map(i => typeof i.encrypted_content === 'string' ? nativeRouteId(i.encrypted_content) ?? 'unbound-native-state' : 'unbound-native-state'))];
    const envelope: RequestEnvelope = { inputTokens: inputTokenBound(bytes.byteLength, body.input.length), outputTokens,
      tools: Array.isArray(body.tools) && body.tools.length > 0, images: JSON.stringify(body.input).includes('"input_image"'),
      reasoning: body.reasoning !== undefined, nativeRouteId: nativeRoutes.length === 0 ? null : nativeRoutes.length === 1 ? nativeRoutes[0] : 'mixed-native-routes' };
    const readCurrent = () => this.options.commercial.transaction(async tx => ({ ...(await effectivePolicy(tx, h.scope)),
      routes: await routesWithCircuits(tx, this.now()), restrictions: await tx.restrictJob(routingScopeKey(h.scope), h.jobId, []) }));
    const initial = await readCurrent();
    if (!initial.effective?.routing || !initial.preference) throw new ManagedError(409, 'routing_setup_required', 'An accepted privacy profile and versioned routing policy are required.');
    const preferenceRevision = initial.preference.revision;
    let previous: AttemptRef | null = null, fallbackReason: string | null = null;
    const changed = () => new ManagedError(409, previous ? 'routing_changed_after_attempt' : 'policy_changed',
      previous ? 'Routing changed after a recorded attempt. Review its costs, then refresh this account before retrying.' : 'Routing, price or account preferences changed. Refresh this account before retrying.');
    if (h.policyRevision !== initial.effective.revision || h.globalRevision !== initial.globalRevision || h.scopeRevision !== initial.scopeRevision || h.preferenceRevision !== preferenceRevision) throw changed();
    const policy = initial.effective.routing[h.tier];
    const referencePrice = initial.routes.find(r => r.id === policy.primary)?.binding?.price ?? null;
    const resolve = (state: typeof initial, requestEnvelope = envelope, sourceRestrictions = state.restrictions) => resolveRoutingCandidates({ routes: state.routes,
      connections: approvedConnections(env).filter(c => connectionCredential(c, env)), policy, preference: state.preference!,
      mandatory: state.global?.mandatory ?? DEFAULT_MANDATORY_RESTRICTIONS, sourceRestrictions,
      tier: h.tier, envelope: requestEnvelope, referencePrice, now: this.now() });
    // The advertised model is the authenticated snapshot's selection. The real request may
    // exclude it (context or sources); only an explicitly enabled backup may then serve it.
    const advertised = resolve(initial, defaultEnvelope(), []).candidates[0]?.route;
    if (!advertised || body.model !== advertised.model || h.routeRevision !== advertised.revision) throw changed();
    const selection = resolve(initial);
    const first = selection.candidates[0];
    if (!first) throw new ManagedError(409, 'no_compliant_route', selection.excluded.flatMap(x => x.reasons.map(r => r.message)).slice(0, 4).join(' ') || 'No configured route fits this request and its spending limits.');
    // An eligible primary that the account's profile ranked lower is a choice, not an outage.
    if (first.route.id !== policy.primary) fallbackReason = selection.ranked.some(c => c.route.id === policy.primary) ? 'ranked_by_profile'
      : selection.excluded.find(e => e.routeId === policy.primary)?.reasons[0]?.code ?? 'primary_unavailable';
    const refs: AttemptRef[] = [];
    try {
      for (let index = 0; index < selection.candidates.length; index++) {
        if (request.signal.aborted) throw new ManagedError(499, 'cancelled', 'The request was cancelled.');
        const admission = await this.admitted(h);
        const current = await readCurrent();
        if (current.globalRevision !== initial.globalRevision || current.scopeRevision !== initial.scopeRevision || current.preference?.revision !== preferenceRevision) throw changed();
        const candidate = selection.candidates[index];
        const fresh = resolve(current).ranked.find(c => c.route.id === candidate.route.id);
        if (!fresh || fresh.route.revision !== candidate.route.revision) throw changed();
        const { route, connection } = fresh;
        const binding = route.binding!;
        const credential = connectionCredential(connection, env);
        if (!credential) throw new ManagedError(503, 'credential_unavailable', 'The selected company connection has no usable credential.');
        const forwarded: { -readonly [K in keyof ResponsesBody]: ResponsesBody[K] } = {
          ...body, model: route.model, max_output_tokens: outputTokens,
        };
        // Re-evaluate optional summaries for every actual attempt, including backups.
        if (!supportsReasoningSummaries(route, connection) && isObject(forwarded.reasoning)) {
          const reasoning = { ...forwarded.reasoning };
          delete reasoning.summary;
          if (Object.keys(reasoning).length) forwarded.reasoning = reasoning;
          else delete forwarded.reasoning;
        }
        let priced = fresh;
        let actualEnvelope = envelope;
        try {
          const prepared = await prepareManagedProvider({ route, connection, credential, body: forwarded, signal: request.signal, scopeKey: routingScopeKey(h.scope) });
          const encoded = providerBody(route, connection, prepared.body);
          actualEnvelope = { ...envelope, inputTokens: Math.max(envelope.inputTokens,
            inputTokenBound(new TextEncoder().encode(encoded).byteLength, body.input.length)) };
          const eligible = resolve(current, actualEnvelope).ranked.find(c => c.route.id === route.id);
          if (!eligible) throw new ManagedError(409, previous ? 'routing_changed_after_attempt' : 'no_compliant_route',
            'The provider request format exceeds this route capability or approved cost envelope. Choose a smaller request.');
          priced = eligible;
        } catch (e) {
          if (e instanceof BindingError) throw new ManagedError(409, e.code, e.message); throw e;
        }
        const attemptId = index === 0 ? h.attemptId : `fallback:${await digest(canonicalJson([routingScopeKey(h.scope), h.jobId, h.attemptId]))}:${index}`;
        const price = binding.price;
        const rate: RateSnapshot = { version: price.version, inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
          outputMicroUsdPerMillion: price.outputMicroUsdPerMillion, reasoningMicroUsdPerMillion: price.reasoningMicroUsdPerMillion,
          cacheReadMicroUsdPerMillion: price.cacheReadMicroUsdPerMillion, cacheWriteMicroUsdPerMillion: price.cacheWriteMicroUsdPerMillion,
          requestFeeMicroUsd: price.requestFeeMicroUsd, longContext: price.longContext,
          routing: { scopeKey: routingScopeKey(h.scope), policyRevision: initial.effective.revision, globalRevision: initial.globalRevision, scopeRevision: initial.scopeRevision,
            preferenceRevision, requestGroup: h.attemptId, ordinal: index + 1, fallbackReason,
            routeId: route.id, routeRevision: route.revision, provider: route.provider, model: route.model,
            modelVersion: binding.modelVersion, deployment: binding.deployment, upstreamEndpoint: binding.upstreamEndpoint, priceVersion: price.version,
            connectionId: connection.id, connectionRevision: connection.revision, protocol: binding.protocol,
            priceObservedAt: price.observedAt, priceValidUntil: price.validUntil } };
        const ref = await this.holdAndDispatch({ ...h, attemptId, parentAttemptId: previous?.attemptId ?? h.parentAttemptId }, admission.tenantId, admission.state.grants,
          { kind: 'generation', route: route.id, requestDigest: await digest(canonicalJson({ body: forwarded, routing: rate.routing })), rate,
            maxMicroUsd: micro(Math.max(1, priced.estimateMicroUsd)), ceilingMicroUsd: controls.ceilingMicroUsd, member: admission.member }, async () => {
            // Reservation and native preparation can wait on I/O. Recheck the actual
            // authority immediately before committing this attempt's dispatch.
            if (request.signal.aborted) throw new ManagedError(499, 'cancelled', 'The request was cancelled before dispatch.');
            await this.admitted(h);
            const latest = await readCurrent();
            if (latest.globalRevision !== initial.globalRevision || latest.scopeRevision !== initial.scopeRevision || latest.preference?.revision !== preferenceRevision) throw changed();
            const allowed = resolve(latest, actualEnvelope).ranked.find(c => c.route.id === route.id);
            if (!allowed || allowed.route.revision !== route.revision || allowed.connection.revision !== connection.revision ||
                allowed.estimateMicroUsd !== priced.estimateMicroUsd || connectionCredential(allowed.connection, env) !== credential) throw changed();
          });
        previous = ref;
        refs.push(ref);
        // From dispatch onward an error must never imply that all attempts were free.
        headers.set('X-Nectovia-Charge', 'uncertain');
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
        let upstream: Response | undefined, category: FailureKind = 'timeout';
        try {
          // The dispatch write awaited I/O. Its committed hold must be retained,
          // but an already-cancelled request must not invoke a provider transport.
          abort.signal.throwIfAborted();
          upstream = await within(callManagedProvider({ route, connection, credential, body: forwarded, signal: abort.signal, scopeKey: routingScopeKey(h.scope) }, this.options.bindingTransport), this.idleTimeoutMs, () => abort.abort());
          if (!upstream.ok) {
            const status = upstream.status;
            category = status === 429 ? 'quota' : status === 503 ? 'capacity' : status >= 500 ? 'health' : status === 401 || status === 403 ? 'credential' : 'invalid-request';
            await upstream.body?.cancel();
            if (RELEASABLE_STATUSES.has(status)) await this.releaseRefused(ref, status, upstream.headers.get('x-request-id'));
            else await this.park(ref, `The provider returned HTTP ${status}; billed usage has not been reconciled.`);
          } else if (upstream.body) {
            // Hold headers/empty framing until the first semantic event. No different model is ever
            // spliced into a response after this point, even when a later stream fails.
            const reader = upstream.body.getReader(), chunks: Uint8Array[] = []; let held = 0, seen = '';
            try {
              while (!/"type"\s*:\s*"response\.(?:output_text\.delta|output_item\.added|completed|incomplete|refusal)/.test(seen)) {
                const next = await within(reader.read(), this.idleTimeoutMs, () => abort.abort());
                if (next.done) throw new BindingError('incomplete_stream', 'The provider stream ended before an answer.');
                chunks.push(next.value); held += next.value.length; seen += new TextDecoder().decode(next.value);
                if (held > 262_144) throw new BindingError('stream_limit', 'The provider sent too much framing before its answer.');
              }
            } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
            headers.set('X-Nectovia-Attempt', ref.attemptId); headers.set('X-Nectovia-Request-Group', h.attemptId);
            headers.set('X-Nectovia-Route', route.id); headers.set('X-Nectovia-Model', route.model); headers.set('X-Nectovia-Rate-Card', price.version);
            headers.set('X-Nectovia-Policy-Revision', String(initial.effective.revision));
            if (fallbackReason) headers.set('X-Nectovia-Fallback-Reason', fallbackReason);
            headers.set('content-type', 'text/event-stream');
            const restored = new ReadableStream<Uint8Array>({ async pull(c) { if (chunks.length) { c.enqueue(chunks.shift()!); return; } const part = await reader.read(); if (part.done) c.close(); else c.enqueue(part.value); }, cancel: () => reader.cancel() });
            let terminalSettled = false;
            const events = sseObjects(restored), encoder = new TextEncoder();
            const attributed = new ReadableStream<Uint8Array>({
              pull: async controller => {
                try {
                  const part = await events.next();
                  if (part.done) { controller.close(); return; }
                  const event = part.value;
                  if (TERMINAL_TYPES.has(String(event.type)) && isObject(event.response)) {
                    await this.conclude(ref, { kind: 'ended', terminal: { type: String(event.type), response: event.response } }, upstream!.headers.get('x-request-id'));
                    terminalSettled = true;
                    event.response.nectovia = await this.receipts(refs);
                  }
                  controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
                } catch (error) { controller.error(error); }
              }, cancel: async () => { await events.return(undefined); },
            });
            let finish!: () => void;
            const tracked = new Promise<void>(resolve => { finish = resolve; });
            this.pending.add(tracked); ctx?.waitUntil(tracked);
            const stream = this.tap(attributed, abort, async outcome => {
              request.signal.removeEventListener('abort', onAbort);
              try { if (!terminalSettled) await this.conclude(ref, outcome, upstream!.headers.get('x-request-id')); }
              finally { finish(); this.pending.delete(tracked); }
            });
            return new Response(stream, { status: 200, headers });
          } else throw new BindingError('empty_stream', 'The provider returned no stream.');
        } catch (error) {
          abort.abort();
          category = error instanceof BindingError ? 'configuration' : 'timeout';
          await this.park(ref, request.signal.aborted
            ? 'The request was cancelled after its dispatch record committed; usage has not been reconciled.'
            : error instanceof BindingError ? error.message : 'The provider may have received the request, but no output or usage was confirmed.');
        }
        request.signal.removeEventListener('abort', onAbort);
        if (request.signal.aborted)
          throw new ManagedError(499, 'cancelled', 'The request was cancelled. Its recorded attempt retains any uncertain cost.');
        if (['quota', 'capacity', 'health', 'timeout'].includes(category)) await this.options.commercial.transaction(tx =>
          tx.saveCircuit(route.id, route.revision, new Date(this.now() + 30_000).toISOString(), `This model returned ${category}; the next funded request after the cooldown checks recovery.`));
        if (request.signal.aborted || !mayFailOver({ kind: category, enabled: policy.fallbackEnabled, maxAttempts: policy.maxAttempts,
          visibleOutput: false, uncertainToolEffect: false,
          portableCheckpoint: h.checkpoint === 'portable' && envelope.nativeRouteId === null, attempts: index + 1 }))
          throw new ManagedError(503, category === 'configuration' ? 'provider_protocol_error' : `provider_${category}`, 'The selected route could not complete this request. Its recorded attempt retains any uncertain cost.');
        fallbackReason = category;
      }
      throw new ManagedError(409, 'fallback_exhausted', 'All permitted attempts were used. Review the recorded costs before choosing to retry.');
    } catch (error) {
      if (!refs.length) throw error;
      // Failure stays a non-success response, with the same immutable attempt
      // evidence a successful backup would return to the owning account.
      return managedErrorResponse(error, headers, await this.receipts(refs));
    }
  }

  private async receipts(refs: readonly AttemptRef[]): Promise<RoutingReceipt> {
    return this.options.fundingReads.transaction(async tx => {
      const attempts = [];
      for (const ref of refs) {
        const attempt = await tx.attempt(ref.tenantId, ref.attemptId), settlement = await tx.settlement(ref.tenantId, ref.attemptId);
        if (!attempt) throw new Error('A dispatched attempt is missing.');
        attempts.push({ attemptId: attempt.id, state: attempt.state, routing: attempt.rateSnapshot.routing ?? null,
          heldMicroUsd: ['pending', 'uncertain'].includes(attempt.state) ? attempt.maxMicroUsd : 0,
          providerCostMicroUsd: settlement?.providerCostMicroUsd ?? null, allowanceDebitMicroUsd: settlement?.allowanceDebitMicroUsd ?? null });
      }
      return { attempts, allowanceDebitMicroUsd: attempts.reduce((sum, a) => sum + (a.allowanceDebitMicroUsd ?? 0), 0),
        heldMicroUsd: attempts.reduce((sum, a) => sum + a.heldMicroUsd, 0) };
    });
  }

  /**
   * `POST /managed/v1/evaluations`: one typed evaluation, held, sent once and
   * settled before it answers. The same headers as a response less the policy
   * revision, the same membership, admission and entitlement checks, and the same
   * hold lifecycle; and the current grants must include AI usage, because this
   * is included usage. Every refusal before dispatch sends nothing and holds
   * nothing. Once a call is sent, X-Nectovia-Charge says what became of its hold:
   * `settled` (with X-Nectovia-Charge-Micro-Usd and the tokens it was priced
   * from), `uncertain` or `released`.
   */
  async evaluate(request: Request, env: ProviderEnv): Promise<Response> {
    const headers = managedHeaders();
    const attempt = request.headers.get('x-nectovia-attempt');
    if (attempt !== null && RUN_ID.test(attempt)) headers.set('X-Nectovia-Attempt', attempt);
    try {
      return await this.runEvaluation(request, env, headers);
    } catch (error) {
      return managedErrorResponse(error, headers);
    }
  }

  private async runEvaluation(request: Request, env: ProviderEnv, headers: Headers): Promise<Response> {
    // 1. Headers.
    const h = jobHeaders(request.headers);
    // 2 to 4. Membership, the stored admission, the Agent and included AI usage, as for a response.
    const { tenantId, state, member } = await this.admitted(h);
    const routing = await this.options.commercial.transaction(async tx => ({ ...(await effectivePolicy(tx, h.scope)),
      restrictions: await tx.restrictJob(routingScopeKey(h.scope), h.jobId, sourceRestrictionHeaders(request.headers)) }));
    if (h.scope.kind === 'individual' || routing.preference || routing.effective?.routing || routing.restrictions.length)
      throw new ManagedError(422, 'helper_privacy_unverified', 'This optional advisor has no endpoint evidence for the account and source restrictions. Continue without the advisor.');
    // 5. The body: a state and its questions, inside the route's bounds.
    const bytes = await this.readBody(request, MAX_EVALUATION_REQUEST_BYTES);
    const parsed = parseBody(bytes);
    const checked = checkEvaluationRequest(parsed);
    if (!checked.ok) throw new ManagedError(checked.code === 'request_too_large' ? 413 : 400, checked.code, checked.message);
    // 6. The route, its key and the owner's spend controls.
    const row = this.options.evaluationProvider ?? EVALUATION_PROVIDER;
    const credential = credentialFor(row, env);
    if (!credential) {
      console.error(JSON.stringify({ event: 'managed-configuration-unavailable', setting: row.credential, rule: credentialProblem(row, env) ?? 'format' }));
      throw unavailable();
    }
    const controls = spendControls(env);
    headers.set('X-Nectovia-Model', row.model);
    headers.set('X-Nectovia-Rate-Card', row.rate.version);
    // 7. The input bound, over the body exactly as it will be sent.
    const forwarded = decisionsBody(row, checked.request);
    const questions = Object.keys(checked.request.questions).length;
    const bound = inputTokenBound(new TextEncoder().encode(forwarded).byteLength, questions);
    if (bound > MAX_INPUT_TOKEN_BOUND)
      throw new ManagedError(413, 'request_too_large', 'This evaluation is too large for one request.');
    // 8 to 10. The job, the hold and the dispatch commit, as for a response.
    const ref = await this.holdAndDispatch(h, tenantId, state.grants, {
      kind: 'advisor', route: row.id, requestDigest: await digest(canonicalJson(parsed)), rate: row.rate,
      maxMicroUsd: holdFor(row.rate, bound, questions * EVALUATION_OUTPUT_TOKENS_PER_QUESTION), ceilingMicroUsd: controls.ceilingMicroUsd, member,
    });
    // 11. The call, once, and its settlement before anything is answered.
    return this.decide(ref, row, credential, forwarded, headers);
  }

  /**
   * Steps 2 to 4 of every managed call. The person is a current member; the
   * stored admission is theirs, managed, current and pinned to this job
   * (evidence of intent, never a bearer credential); and the business's grants,
   * read now, still admit the Agent and include AI usage.
   */
  private async admitted(h: JobHeaders) {
    const member = await authorizeScope(this.options.accounts, this.options.commercial, h.token, h.scope).catch(error => {
      if (error instanceof AccountError && error.status === 401)
        throw new ManagedError(401, 'sign_in_required', 'Your Nectovia sign-in has ended. Sign in again to continue.');
      if (error instanceof AccountError && error.status === 403 && h.scope.kind === 'organization')
        throw new ManagedError(403, 'not_a_member', 'You are not an active member of this business.');
      throw error;
    });
    const tenantId = member.tenantId;
    const at = this.at();
    const state = await this.options.commercial.transaction(async (tx) => ({
      admission: h.scope.kind === 'individual' ? await tx.personalAdmission(tenantId, h.admissionId) : await tx.admission(tenantId, h.admissionId),
      grants: h.scope.kind === 'individual' ? await tx.personGrants(member.person.id) : await tx.grants(h.organizationId),
      accessRevision: await tx.accessRevision(h.organizationId),
      individual: h.scope.kind === 'individual' ? await individualEntitlement(tx, h.scope.id, member.person.id, at) : null,
      policy: await tx.policy(),
      routes: await tx.routes(),
    }));
    this.checkAdmission(state.admission, { person: member.person, tenantId }, h);
    const view = state.individual ?? entitlementFromGrants(state.grants, state.accessRevision, at);
    const decision = decideAgentAdmission({ workspace: h.scope.kind === 'individual' ? 'personal' : 'business', member: true,
      entitlement: snapshotFromView(view), ...(h.scope.kind === 'individual' ? { individual: snapshotFromView(view) } : {}), at });
    if (!decision.admitted) throw new ManagedError(403, 'agent_not_included', decision.reason);
    // Every call here is Diomedes-funded, so it also needs included AI usage ('managed-inference'),
    // read from the same current grants. A month's credit period outlives the grant that funded it,
    // so funding alone doesn't answer this. Refused before the job is opened or anything is held.
    if (!view.managedInference) throw new ManagedError(403, 'agent_not_included', MANAGED_USAGE_NOT_INCLUDED);
    // The verified person and their role, for the member's own monthly limit. Only a business has members.
    const asMember = h.scope.kind === 'organization' ? { personId: member.person.id, role: member.role } : null;
    return { tenantId, state, view, member: asMember };
  }

  /**
   * Steps 8 to 10 of every managed call: the job, this month's credit, the hold
   * and the dispatch commit. A refusal here sent nothing. On return the attempt
   * is marked dispatched by this caller alone, and only this caller may send it.
   */
  private async holdAndDispatch(h: JobHeaders, tenantId: string, grants: readonly (FeatureGrant | PersonFeatureGrant)[], hold: {
    kind: ChargeKind; route: string; requestDigest: string; rate: RateSnapshot; maxMicroUsd: MicroUsd; ceilingMicroUsd: MicroUsd | null;
    /** The verified member this call is for, so the funding service can enforce their monthly limit. Null for a personal workspace. */
    member?: { personId: string; role: MemberRole } | null;
  }, beforeDispatch?: () => Promise<void>): Promise<AttemptRef> {
    const ref: AttemptRef = { tenantId, organizationId: h.organizationId, attemptId: h.attemptId };
    await this.options.funding.openJob({
      tenantId, organizationId: h.organizationId, rootJobId: h.jobId, runRef: h.jobId, parentRunRef: null,
      tier: h.tier, capMicroUsd: approvedJobCap(h.tier),
    });
    const individualCycle = await this.ensurePeriod(tenantId, h.scope, grants);
    // The company ceiling is checked inside the reserving transaction, so a refusal holds nothing.
    let attempt: FundedAttempt;
    try {
      attempt = await this.options.funding.reserve({
        ...ref, rootJobId: h.jobId, parentAttemptId: h.parentAttemptId, kind: hold.kind, route: hold.route,
        requestDigest: hold.requestDigest, rateSnapshot: hold.rate, maxMicroUsd: hold.maxMicroUsd, usageClass: h.usageClass,
        companyCeilingMicroUsd: hold.ceilingMicroUsd, ...(hold.member ? { member: hold.member } : {}),
        ...(individualCycle ? { individualCycle } : {}),
      });
    } catch (error) {
      if (!(error instanceof FundingError && error.code === 'company_ceiling')) throw error;
      console.warn(JSON.stringify({ event: 'managed-spend-ceiling-reached', attemptId: h.attemptId }));
      throw ceilingReached();
    }
    // An identical reservation came back: this attempt has been here before. Only one that
    // never left may go on; anything already sent is never sent again.
    if (attempt.state === 'pending' && attempt.dispatchedAt !== null) throw inFlight();
    if (attempt.state !== 'pending')
      throw new ManagedError(409, 'attempt_replayed',
        `Attempt ${h.attemptId} was already sent. Read its outcome at /managed/v1/attempts/${h.attemptId}, and retry under a new attempt id.`);
    if (beforeDispatch) {
      try { await beforeDispatch(); }
      catch (error) {
        // release() refuses any hold another concurrent request already sent.
        await this.options.funding.release(ref);
        throw error;
      }
    }
    // Dispatch commits before anything leaves, and is exclusive: only the caller whose
    // conditional update moved the attempt sends. Any other, in any isolate, gets attempt_in_flight.
    try {
      await this.options.funding.markDispatched(ref);
    } catch (error) {
      if (error instanceof FundingError && error.code === 'attempt_in_flight') throw inFlight();
      throw error;
    }
    return ref;
  }

  /**
   * One evaluation call and what became of its hold. The provider is asked once,
   * its answer is read whole, and the hold is settled, parked or released before
   * the customer hears anything, with the outcome in X-Nectovia-Charge.
   */
  private async decide(ref: AttemptRef, row: EvaluationProviderRow, credential: string, body: string, headers: Headers): Promise<Response> {
    const caller = this.options.evaluationCaller ?? openRouterDecisionsCaller();
    const lost = async (reason: string): Promise<never> => {
      await this.park(ref, reason);
      headers.set('X-Nectovia-Charge', 'uncertain');
      throw unavailable();
    };
    const abort = new AbortController();
    let response: Response;
    try {
      response = await within(caller({ row, credential, body, signal: abort.signal }), this.idleTimeoutMs, () => abort.abort());
    } catch {
      return lost('The provider call failed before it answered, by a network failure or a timeout. The provider may still have received it.');
    }
    const requestId = row.requestIdHeaders.map((name) => response.headers.get(name)).find((value) => value !== null && RUN_ID.test(value)) ?? null;
    if (response.status < 200 || response.status > 299) return this.evaluationRefused(response, ref, credential, requestId, headers);
    let answer: Record<string, unknown>;
    try {
      const bytes = await within(readBytes(response, MAX_EVALUATION_ANSWER_BYTES), this.idleTimeoutMs, () => abort.abort());
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!isObject(value)) throw new TypeError('The answer is not an object.');
      answer = value;
    } catch {
      return lost('The provider answered, but its answer could not be read, so what it used is unknown.');
    }
    const receipt = await this.settleEvaluation(ref, row, answer, requestId);
    headers.set('X-Nectovia-Charge', receipt ? 'settled' : 'uncertain');
    if (receipt) {
      headers.set('X-Nectovia-Charge-Micro-Usd', String(receipt.allowanceDebitMicroUsd));
      headers.set('X-Nectovia-Input-Tokens', String(receipt.usage.inputTokens));
      headers.set('X-Nectovia-Output-Tokens', String(receipt.usage.outputTokens));
    }
    // Paid for, whatever comes next; an answer with no answers in it is still refused.
    if (!isObject(answer.answers)) throw unavailable();
    return Response.json(evaluationReply(answer), { status: 200, headers });
  }

  /**
   * Settle an answered evaluation from the usage the provider reported, priced
   * under the route's rate. It stays uncertain, never zero, when the usage is
   * missing or unreadable, when another model answered, when the provider says
   * it cost more than that price, or when there is nothing to settle against.
   * Null means it was parked.
   */
  private async settleEvaluation(ref: AttemptRef, row: EvaluationProviderRow, answer: Record<string, unknown>, requestId: string | null): Promise<AttemptSettlement | null> {
    const park = async (reason: string) => {
      await this.park(ref, reason);
      return null;
    };
    const usage = answer.usage;
    if (!isObject(usage)) return park('The provider reported no usage for this evaluation.');
    if (answer.model !== undefined && (typeof answer.model !== 'string' || !answeredAs(row, answer.model)))
      return park('A model other than the one this call was priced for answered it.');
    const counts = decisionsUsage(usage);
    const cost = usage.cost;
    const known = normalizeUsage(counts);
    // OpenRouter reports what it charged in USD. More than the published price means the price moved.
    if (typeof cost === 'number' && Number.isFinite(cost) && known.state === 'known' &&
        Math.round(cost * 1e12) > usageCost(row.rate, known.usage) * 1_000_000)
      return park('The provider reported a cost above the published price, so the charge is held for reconciliation.');
    const receiptRef = typeof answer.id === 'string' && RUN_ID.test(answer.id) ? answer.id : requestId;
    if (!receiptRef) return park('The provider named no response or request id to settle against.');
    try {
      // A report FundingService cannot price keeps the hold as uncertain, with its reason.
      const settled = await this.options.funding.settle({ ...ref, receiptRef, usage: counts, raw: usage, reconciledFrom: 'response' });
      return settled.outcome === 'settled' ? settled.settlement : null;
    } catch {
      return park('Settlement from the provider’s usage did not complete. The hold stays until reconciliation.');
    }
  }

  /**
   * A provider refusal to an evaluation, before any output. Released on a status
   * the provider does not bill, parked otherwise, exactly as for a response. A
   * request no endpoint could take under the data policy is refused by name and
   * never sent anywhere else. Always throws the customer's answer.
   */
  private async evaluationRefused(response: Response, ref: AttemptRef, credential: string, requestId: string | null, headers: Headers): Promise<never> {
    const status = response.status;
    if (!RELEASABLE_STATUSES.has(status)) {
      await response.body?.cancel().catch(() => {});
      await this.park(ref, `The provider answered HTTP ${status} before any output, so it may have processed the request.`);
      headers.set('X-Nectovia-Charge', 'uncertain');
      throw unavailable();
    }
    let said: { message: string; unrouted: boolean } | null = null;
    if (status === 400 || status === 404 || status === 413 || status === 422) said = await providerRefusal(response, credential);
    else await response.body?.cancel().catch(() => {});
    const released = await this.releaseRefused(ref, status, requestId);
    headers.set('X-Nectovia-Charge', released ? 'released' : 'uncertain');
    if (status === 404 && said?.unrouted) {
      console.warn(JSON.stringify({ event: 'managed-evaluation-provider-policy', attemptId: ref.attemptId }));
      // "Nothing was charged" is said only of a hold that was released.
      throw released ? new ManagedError(503, 'evaluation_provider_policy', PROVIDER_POLICY_REFUSAL) : unavailable();
    }
    throw releasedRefusal(status, said?.message ?? null, response.headers.get('retry-after'));
  }

  private async member(token: string, organizationId: string): Promise<AccountMembershipSnapshot> {
    try {
      return await this.options.accounts.membership(token, organizationId);
    } catch (error) {
      if (error instanceof AccountError && error.status === 401)
        throw new ManagedError(401, 'sign_in_required', 'Your Nectovia sign-in has ended. Sign in again to continue.');
      if (error instanceof AccountError && error.status === 403)
        throw new ManagedError(403, 'not_a_member', 'You are not an active member of this business.');
      throw error;
    }
  }

  private checkAdmission(record: AdmissionRecord | PersonalAdmissionRecord | undefined, member: { person: { id: string }; tenantId: string }, h: JobHeaders) {
    const now = this.now();
    const at = record ? Date.parse(record.at) : Number.NaN;
    const current = at <= now + 5_000 && now - at <= ADMISSION_WINDOW_MS;
    const scopeMatches = record && (h.scope.kind === 'individual'
      ? 'billingAccountId' in record && record.billingAccountId === h.scope.id && record.tenantId === member.person.id
      : 'organizationId' in record && record.organizationId === h.organizationId);
    if (!record || !scopeMatches || record.tenantId !== member.tenantId ||
        record.personId !== member.person.id || record.decision !== 'admitted' || record.routeKind !== 'managed' || !current ||
        (record.rootJobId !== null && record.rootJobId !== h.jobId))
      throw new ManagedError(403, 'admission_invalid', 'This work has no current admission to Nectovia’s managed model service. Ask for admission again, then retry.');
  }

  private async readBody(request: Request, max: number): Promise<Uint8Array> {
    try {
      return await readBytes(request, max);
    } catch (error) {
      if (error instanceof RangeError)
        throw new ManagedError(413, 'request_too_large', `A request can be at most ${max.toLocaleString('en-US')} bytes.`);
      throw new ManagedError(400, 'invalid_body', 'A JSON request body is required.');
    }
  }

  private resolve(policy: TierPolicy | undefined, routes: readonly RouteEntry[], h: GatewayHeaders, body: ResponsesBody, env: ProviderEnv) {
    const changed = () => new ManagedError(409, 'policy_changed', 'Nectovia’s model routing has changed. Read the routing policy again, then retry.');
    if (h.policyRevision !== (policy?.revision ?? 0)) throw changed();
    const resolved = policy?.tiers[h.tier] ?? null;
    if (!resolved) throw new ManagedError(409, 'tier_unrouted', `The ${TIER_LABEL[h.tier]} tier has no model right now.`);
    const entry = routes.find((item) => item.id === resolved.entryId);
    if (!entry || entry.status !== 'qualified' || entry.provider !== resolved.provider || entry.model !== resolved.model) throw unavailable();
    if (body.model !== entry.model) throw changed();
    const row = registryRow(entry, this.registry);
    const credential = row ? credentialFor(row, env) : null;
    if (!row || !credential) throw unavailable();
    return { entry, row, credential };
  }

  /**
   * This month's credit, allocated on the first call that needs it. Credit
   * periods are otherwise written only when a grant is issued, for that month,
   * so without this every business would stop on the first of the next month.
   * The source is the current grant that would fund a month at issue time
   * (included usage, on a plan with a published monthly grant), the one ending
   * last; allocatePeriod is idempotent for it. A revoked or expired grant never
   * gets here: step 4 has already refused.
   *
   * Individual (DIO-128): a current complete-plan grant that names a verified monthly term funds
   * that exact term, and the term is returned so the reservation binds to it. The term comes from
   * the grant, never from the grant ending last, the first use or the calling device; grants that
   * name the same term share its one row. Grants from before monthly terms keep the calendar month.
   */
  private async ensurePeriod(tenantId: string, scope: AccountScope, grants: readonly (FeatureGrant | PersonFeatureGrant)[]): Promise<IndividualBillingCycle | undefined> {
    const organizationId = scope.id; // The historical ledger column holds the billing account, never a selected Business.
    if (scope.kind === 'individual') {
      const person = grants.filter((grant): grant is PersonFeatureGrant => 'personId' in grant && grant.personId === tenantId && grant.tenantId === tenantId);
      const term = currentIndividualCycle(person, this.now());
      if (term) {
        // Written once, on the first use inside the term; reserve() checks the row's bounds again.
        if (!(await this.options.fundingReads.transaction((tx) => tx.period(tenantId, organizationId, individualCycleId(term.cycle)))))
          await this.options.funding.allocateIndividualPeriod({ tenantId, organizationId, sourceGrantId: term.grant.id, cycle: term.cycle });
        return term.cycle;
      }
      // A current grant naming a term that is not in force now never falls back to a calendar month.
      if (person.some((grant) => grant.billingCycle && grantState(grant, this.now()) === 'active' && individualIncludesMonthlyCredits(grant)))
        throw new FundingError(409, 'Your Individual billing period could not be confirmed, so nothing was reserved. Nothing was sent.', 'no_period');
    }
    const periodId = periodIdFor(this.at());
    if (await this.options.fundingReads.transaction((tx) => tx.period(tenantId, organizationId, periodId))) return;
    const when = this.now();
    const source = grants
      .filter((grant) => grantState(grant, when) === 'active' &&
        (scope.kind === 'individual'
          ? 'personId' in grant && grant.personId === tenantId && grant.tenantId === tenantId && !grant.billingCycle && individualIncludesMonthlyCredits(grant)
          : 'organizationId' in grant && grant.organizationId === scope.id && grant.tenantId === tenantId && grant.features.includes('managed-inference')) &&
        grant.planId !== null && publishedMonthlyGrant(grant.planId) !== null)
      .sort((a, b) => Date.parse(b.validUntil) - Date.parse(a.validUntil) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (!source?.planId) return;
    try {
      await this.options.funding.allocatePeriod({ tenantId, organizationId, periodId, planId: source.planId, sourceGrantId: source.id });
    } catch (error) {
      // Another grant funded this month first: reserve against that one.
      if (!(error instanceof FundingError && error.code === 'period_conflict')) throw error;
    }
  }

  private async dispatch(call: Dispatch): Promise<Response> {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const tracked: Promise<void> = finished.then(() => {
      this.pending.delete(tracked);
    });
    this.pending.add(tracked);
    call.ctx?.waitUntil(tracked);

    const abort = new AbortController();
    let response: Response;
    try {
      response = await within(
        this.options.caller({ row: call.row, credential: call.credential, body: call.body, signal: abort.signal }),
        this.idleTimeoutMs,
        () => abort.abort(),
      );
    } catch {
      await this.park(call.ref, 'The provider call failed before it answered, by a network failure or a timeout. The provider may still have received it.');
      finish();
      throw unavailable();
    }
    if (response.status < 200 || response.status > 299) {
      try {
        return await this.refused(response, call);
      } finally {
        finish();
      }
    }
    if (!response.body) {
      await this.park(call.ref, 'The provider answered with no stream.');
      finish();
      throw unavailable();
    }
    const requestId = call.row.requestIdHeaders.map((name) => response.headers.get(name)).find((value) => value !== null && RUN_ID.test(value)) ?? null;
    const stream = this.tap(response.body, abort, (outcome) => this.conclude(call.ref, outcome, requestId).finally(finish));
    const type = response.headers.get('content-type');
    call.headers.set('Content-Type', type && /^text\/event-stream\b/i.test(type) ? type : 'text/event-stream');
    return new Response(stream, { status: 200, headers: call.headers });
  }

  /** A provider refusal before any byte reached the customer. Always throws the customer's answer. */
  private async refused(response: Response, call: Dispatch): Promise<never> {
    const status = response.status;
    if (!RELEASABLE_STATUSES.has(status)) {
      await response.body?.cancel().catch(() => {});
      await this.park(call.ref, `The provider answered HTTP ${status} before any output, so it may have processed the request.`);
      throw unavailable();
    }
    const requestId = call.row.requestIdHeaders.map((name) => response.headers.get(name)).find((value) => value !== null && RUN_ID.test(value)) ?? null;
    // Nothing past the error body is read: the provider sent no output.
    let detail: string | null = null;
    if (status === 400 || status === 413 || status === 422) detail = await providerMessage(response, call.credential);
    else await response.body?.cancel().catch(() => {});
    await this.releaseRefused(call.ref, status, requestId);
    throw releasedRefusal(status, detail, response.headers.get('retry-after'));
  }

  /**
   * Contract section 3 (revision 2): a hold the provider refused before any
   * output, with a status it does not bill, is released through
   * FundingService.releaseRefused, which records the status and the provider's
   * request id as the evidence. If that release fails, the hold is parked as
   * uncertain for reconciliation: never released on a guess, never left pending.
   */
  private async releaseRefused(ref: AttemptRef, status: number, requestId: string | null): Promise<boolean> {
    try {
      await this.options.funding.releaseRefused({ ...ref, providerStatus: status, providerRequestId: requestId });
      return true;
    } catch {
      await this.park(ref, `The provider refused the request with HTTP ${status} before any output. The hold stays until provider records reconcile it.`);
      return false;
    }
  }

  /** The hold stays at its ceiling until provider reporting reconciles it. Never released, never retried. */
  private async park(ref: AttemptRef, reason: string) {
    try {
      await this.options.funding.markUncertain({ ...ref, reason });
    } catch {
      // Left pending, the restart sweep still parks it. The attempt id is not a secret.
      console.error(JSON.stringify({ event: 'managed-hold-unresolved', attemptId: ref.attemptId }));
    }
  }

  private tap(body: ReadableStream<Uint8Array>, abort: AbortController, end: (outcome: StreamOutcome) => Promise<void>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const events = new TerminalTap();
    const idleTimeoutMs = this.idleTimeoutMs;
    let concluded = false;
    const conclude = (outcome: StreamOutcome) => {
      if (concluded) return;
      concluded = true;
      void end(outcome);
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await within(reader.read(), idleTimeoutMs, () => abort.abort());
        } catch {
          void reader.cancel().catch(() => {});
          conclude({ kind: 'failed' });
          try { controller.error(new Error('The model stream was interrupted.')); } catch { /* already closed */ }
          return;
        }
        if (part.done) {
          events.push(decoder.decode());
          events.end();
          try { controller.close(); } catch { /* the reader already left */ }
          conclude({ kind: 'ended', terminal: events.terminal });
          return;
        }
        try { controller.enqueue(part.value); } catch { /* the reader already left */ }
        events.push(decoder.decode(part.value, { stream: true }));
      },
      cancel() {
        conclude({ kind: 'cancelled' });
        abort.abort();
        return reader.cancel().catch(() => {});
      },
    });
  }

  private async conclude(ref: AttemptRef, outcome: StreamOutcome, requestId: string | null): Promise<void> {
    if (outcome.kind === 'cancelled')
      return this.park(ref, 'The client disconnected mid-stream. The provider may have finished and charged for it.');
    if (outcome.kind === 'failed')
      return this.park(ref, 'The provider stream failed after it started. Its usage is unknown until reconciled.');
    const response = outcome.terminal?.response;
    if (!response) return this.park(ref, 'The stream ended without a completed, incomplete or failed event, so its usage is unknown.');
    const usage = response.usage;
    if (!isObject(usage)) return this.park(ref, 'The provider reported no usage for this response.');
    if (usage.cost !== undefined) {
      const attempt = await this.options.fundingReads.transaction(tx => tx.attempt(ref.tenantId, ref.attemptId));
      const known = normalizeUsage(responsesUsage(usage));
      if (!attempt || known.state !== 'known' || typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0 ||
          Math.round(usage.cost * 1e12) > usageCost(attempt.rateSnapshot, known.usage) * 1_000_000)
        return this.park(ref, 'The provider cost is invalid or above the accepted price. The hold remains for reconciliation.');
    }
    const receiptRef = typeof response.id === 'string' && RUN_ID.test(response.id) ? response.id : requestId;
    if (!receiptRef) return this.park(ref, 'The provider named no response or request id to settle against.');
    try {
      // A report FundingService cannot price keeps the hold as uncertain, with its reason.
      await this.options.funding.settle({ ...ref, receiptRef, usage: responsesUsage(usage), raw: usage, reconciledFrom: 'response' });
    } catch {
      await this.park(ref, 'Settlement from the provider’s usage did not complete. The hold stays until reconciliation.');
    }
  }
}
