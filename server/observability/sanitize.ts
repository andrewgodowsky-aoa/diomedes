/**
 * The observation allowlists and identifier derivations (PH-00 contract 4.1, 4.3).
 *
 * Every value that leaves the machine is either a closed enumeration, a count, a
 * company-issued opaque id, or a digest built here. A name a customer could have
 * chosen (a model, a deployment, a tool, a project, a business) is not an
 * identifier: it is refused as `customer-named`, never hashed and sent, because
 * hashing content does not make it anonymous.
 */
import { createHash, createHmac } from 'node:crypto';
import { PLAN_TEMPLATES } from '../../shared/access.js';
import {
  OBSERVATION_CONTRACT,
  OBSERVED_CAPABILITIES,
  known,
  unknown,
  type Observed,
  type ObservedCapability,
  type ObservedRoute,
} from '../../shared/observability.js';
import { TEAM_TOOL_NAMES } from '../../shared/team-routes.js';
import { ADVISE_TOOL, ASSIGN_TOOL } from '../../shared/team-delegation.js';

// --- identifiers --------------------------------------------------------------

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/** 32 hex characters of the contract-scoped digest of one key. */
export function derive(kind: string, environment: string, key: string): string {
  return sha256(`${OBSERVATION_CONTRACT}|${kind}|${environment}|${key}`).toString('hex').slice(0, 32);
}

export const traceIdFor = (environment: string, traceRootRunId: string) => `otr_${derive('trace', environment, traceRootRunId)}`;
export const sessionIdFor = (environment: string, lineageRunId: string) => `oss_${derive('session', environment, lineageRunId)}`;
export const spanIdFor = (environment: string, key: string) => `osp_${derive('span', environment, key)}`;

/** A deterministic UUID (RFC 9562 version 8) for one emitted event. */
export function uuidFor(environment: string, key: string): string {
  const bytes = sha256(`${OBSERVATION_CONTRACT}|event|${environment}|${key}`).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A keyed pseudonym: only the holder of the operator's key can join it back. */
export function keyedDigest(key: Uint8Array, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
export const organizationKeyFor = (key: Uint8Array, organizationId: string) =>
  `oorg_${keyedDigest(key, `organization|${organizationId}`).slice(0, 32)}`;
/** Rate-card versions can embed an owner's model name (Azure, OpenRouter), so they are keyed too. */
export const rateCardKeyFor = (key: Uint8Array, version: string) =>
  `rc_${keyedDigest(key, `rate-card|${version}`).slice(0, 16)}`;

// --- models -------------------------------------------------------------------

/**
 * Built-in catalog models a person picks from rather than types. Mirrors
 * `AWS_LUNA_MODEL` (server/engines/aws-bedrock.ts) and `VERTEX_GEMINI_MODEL`
 * (server/engines/google-vertex.ts); a test keeps them equal.
 */
export const CATALOG_MODELS: Readonly<Record<'aws-bedrock' | 'google-vertex', readonly string[]>> = Object.freeze({
  'aws-bedrock': Object.freeze(['us.openai.gpt-5.6-luna']),
  'google-vertex': Object.freeze(['gemini-3.8-flash']),
});

const PROVIDER_MODEL = /^[a-z0-9][a-z0-9._:@-]{0,79}$/;
const VENDOR_MODEL = /^[a-z0-9][a-z0-9._-]{0,39}\/[a-z0-9][a-z0-9._:-]{0,79}$/;
/** A run of twelve digits is an AWS account id shape; an ARN names an account. */
const ACCOUNTISH = /arn:|\d{12}/;

/**
 * The model a person or the tier policy asked for. Only a built-in catalog model,
 * or the company's managed tier model, is an identifier; an owner-typed model or
 * deployment name is `customer-named`.
 */
export function requestedModel(route: ObservedRoute, value: string | null | undefined): Observed<string> {
  if (!value) return unknown('not-reported');
  if (route === 'nectovia')
    return PROVIDER_MODEL.test(value) && !ACCOUNTISH.test(value) ? known(value) : unknown('customer-named');
  if (route === 'aws-bedrock' || route === 'google-vertex')
    return CATALOG_MODELS[route].includes(value) ? known(value) : unknown('customer-named');
  return unknown('customer-named');
}

/**
 * The model the provider reported. Provider-authored, so it may leave when it has
 * a provider's shape; Azure reports under a customer's deployment and is never
 * sent, and anything carrying an account id is refused.
 */
export function reportedModel(route: ObservedRoute, value: string | null | undefined): Observed<string> {
  if (!value) return unknown('not-reported');
  if (route === 'azure-openai' || ACCOUNTISH.test(value)) return unknown('customer-named');
  if (route === 'openrouter') return VENDOR_MODEL.test(value) ? known(value) : unknown('customer-named');
  return PROVIDER_MODEL.test(value) ? known(value) : unknown('customer-named');
}

// --- tools, codes, errors, plans, capabilities ---------------------------------

/** Tools the host itself registers. Anything else, including a pack or connector tool, is `other`. */
export const OBSERVABLE_TOOLS: ReadonlySet<string> = new Set([
  'list_sources',
  'read_source',
  'load_playbook',
  'list_files',
  'read_file',
  'search_files',
  'write_file',
  'fetch_page',
  'connector_read',
  'list_project_files',
  'read_project_file',
  'propose_write',
  'delegate',
  'open_handoff',
  'open_team_handoffs',
  'account_loop_context',
  'format_lines',
  'read_fixture',
  'compose_brief',
  'read_brief_sources',
  'save_brief_draft',
  ASSIGN_TOOL,
  ADVISE_TOOL,
  ...TEAM_TOOL_NAMES,
]);
export const toolName = (name: string | null | undefined): string =>
  typeof name === 'string' && OBSERVABLE_TOOLS.has(name) ? name : 'other';

/** Tools whose step hands work to a child run: their span id is the child's parent anchor. */
export const DELEGATING_TOOLS: ReadonlySet<string> = new Set(['delegate', ASSIGN_TOOL, ADVISE_TOOL]);

/** A host-authored error code: an identifier, never a sentence. */
export const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const errorCode = (value: unknown): Observed<string> =>
  typeof value === 'string' && SAFE_CODE.test(value) ? known(value) : unknown('not-reported');

const ERROR_CLASSES: ReadonlySet<string> = new Set([
  'ModelApiError',
  'HarnessError',
  'EngineError',
  'ApiError',
  'AbortError',
  'TimeoutError',
  'Suspended',
  'SpendExposureError',
  'JobCapReached',
  'TypeError',
  'Error',
]);
export const errorClass = (name: string | null | undefined): Observed<string> =>
  !name ? unknown('not-reported') : known(ERROR_CLASSES.has(name) ? name : 'other');

const PLAN_IDS: ReadonlySet<string> = new Set(PLAN_TEMPLATES.map((plan) => plan.id));
export const planOf = (planId: string | null | undefined): string =>
  !planId ? 'none' : PLAN_IDS.has(planId) ? planId : 'other';

export const capabilityOf = (id: string): ObservedCapability =>
  (OBSERVED_CAPABILITIES as readonly string[]).includes(id) ? (id as ObservedCapability) : 'other';

/** Organization ids in operator configuration: the account service's id shape, nothing wider. */
export const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
