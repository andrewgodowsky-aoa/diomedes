/**
 * Whether one admitted piece of Agent work may be observed, and whether it still
 * may (PH-00 contract, sections 2.3 and 3).
 *
 * Observation starts only from an admitted decision the account service returned
 * (`AccountAgentGate.check`) plus the operator's own configuration, read once from
 * the process environment at startup. No input here comes from an HTTP request,
 * the renderer, a settings file, a run's input or a model's output, so a client
 * that claims to be internal, paid or another business has nothing to claim it to.
 *
 * Free and Personal work, direct engines and the host's connection test carry no
 * admission, so they never reach a scope. Customer work additionally needs a
 * telemetry policy the account service does not yet publish (dependency D1), so
 * it is refused as `telemetry-policy-absent` in production.
 */
import type { AdmittedAgentWork } from '../accounts/agent-gate.js';
import {
  MANAGED_ROUTE,
  OBSERVATION_ENVIRONMENTS,
  isObservedRoute,
  type ObservationEnvironment,
  type ObservedPayer,
  type ObservedSurface,
  type ScopeFacts,
} from '../../shared/observability.js';
import { ORGANIZATION_ID, organizationKeyFor, planOf, derive } from './sanitize.js';

// --- operator configuration ----------------------------------------------------

export interface PostHogOperatorConfig {
  /** An https origin, e.g. `https://us.i.posthog.com`. */
  readonly host: string;
  /** The project capture token: an ingestion credential, never a grant. */
  readonly captureKey: string;
  /** The last day the vendor benefit is known to fund eligible usage; null is unknown. */
  readonly fundedUntil: string | null;
  /** Events this process may send per UTC day. Zero sends nothing. */
  readonly dailyEvents: number;
}

export interface ObservationOperatorConfig {
  readonly mode: 'off' | 'memory' | 'posthog';
  readonly environment: ObservationEnvironment;
  /** The operator declared this installation a company host. A label, not proof (D3). */
  readonly companyHost: boolean;
  readonly internalOrganizations: ReadonlySet<string>;
  /** At least 32 bytes. Without it nothing is observed: every id that leaves is keyed. */
  readonly pseudonymKey: Uint8Array | null;
  /** Never read from the environment. False in production until D1 and D5 exist. */
  readonly customerExport: boolean;
  readonly posthog: PostHogOperatorConfig | null;
}

export const OBSERVATION_OFF: ObservationOperatorConfig = Object.freeze({
  mode: 'off',
  environment: 'development',
  companyHost: false,
  internalOrganizations: new Set<string>(),
  pseudonymKey: null,
  customerExport: false,
  posthog: null,
});

const HEX_KEY = /^[0-9a-f]{64,256}$/i;
const CAPTURE_KEY = /^phc_[A-Za-z0-9]{16,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real UTC calendar day, `YYYY-MM-DD`. `2099-02-30` parses in JavaScript (as 2 March), so it must round-trip. */
export function isCalendarDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function posthogFromEnv(env: NodeJS.ProcessEnv): PostHogOperatorConfig | null {
  const host = env.NECTOVIA_POSTHOG_HOST?.trim();
  const captureKey = env.NECTOVIA_POSTHOG_CAPTURE_KEY?.trim();
  if (!host || !captureKey || !CAPTURE_KEY.test(captureKey)) return null;
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  const fundedUntil = env.NECTOVIA_OBSERVATION_FUNDED_UNTIL?.trim() ?? '';
  const daily = Number(env.NECTOVIA_OBSERVATION_DAILY_EVENTS ?? '0');
  return {
    host: url.origin,
    captureKey,
    fundedUntil: isCalendarDay(fundedUntil) ? fundedUntil : null,
    dailyEvents: Number.isSafeInteger(daily) && daily > 0 ? Math.min(daily, 1_000_000) : 0,
  };
}

/** Read once at startup. Anything malformed reads as absent, and absent is off. */
export function operatorConfigFromEnv(env: NodeJS.ProcessEnv): ObservationOperatorConfig {
  const mode = env.NECTOVIA_OBSERVATION === 'memory' || env.NECTOVIA_OBSERVATION === 'posthog' ? env.NECTOVIA_OBSERVATION : 'off';
  if (mode === 'off') return OBSERVATION_OFF;
  const environment = (OBSERVATION_ENVIRONMENTS as readonly string[]).includes(env.NECTOVIA_OBSERVATION_ENVIRONMENT ?? '')
    ? (env.NECTOVIA_OBSERVATION_ENVIRONMENT as ObservationEnvironment)
    : 'development';
  const internalOrganizations = new Set(
    (env.NECTOVIA_OBSERVATION_INTERNAL_ORGS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => ORGANIZATION_ID.test(item)),
  );
  const key = env.NECTOVIA_OBSERVATION_PSEUDONYM_KEY?.trim() ?? '';
  return {
    mode,
    environment,
    companyHost: env.NECTOVIA_OBSERVATION_COMPANY_HOST === '1',
    internalOrganizations,
    pseudonymKey: HEX_KEY.test(key) && key.length % 2 === 0 ? new Uint8Array(Buffer.from(key, 'hex')) : null,
    customerExport: false,
    posthog: mode === 'posthog' ? posthogFromEnv(env) : null,
  };
}

// --- customer telemetry policy (dependency D1) ---------------------------------

export interface TelemetryPolicy {
  readonly organizationId: string;
  readonly revision: number;
  readonly export: 'none' | 'metadata';
  readonly source: 'account-service';
}
export interface TelemetryPolicyPort {
  policyFor(organizationId: string): TelemetryPolicy | null;
}
/** Production until the account service publishes a telemetry policy: there is none. */
export const ABSENT_TELEMETRY_POLICY: TelemetryPolicyPort = Object.freeze({ policyFor: () => null });

// --- the decision -----------------------------------------------------------------

export type ObservationDenial =
  | 'observation-off'
  | 'no-admission'
  | 'no-root-job'
  | 'route-not-observable'
  | 'route-kind-not-observable'
  | 'account-service-unavailable'
  | 'not-company-host'
  | 'faux-account-not-internal'
  | 'pseudonym-key-missing'
  | 'customer-export-disabled'
  | 'telemetry-policy-absent'
  | 'telemetry-policy-none'
  | 'signed-out'
  | 'person-changed'
  | 'workspace-changed'
  | 'entitlement-inactive'
  | 'no-longer-internal'
  /** The account service refused a later admission for the business (contract section 3). */
  | 'admission-refused';

export interface ObservationScope {
  /** `osc_` + 24 hex of the admission id. */
  readonly scopeId: string;
  readonly facts: ScopeFacts;
  // Host-only from here down. None of these is ever serialized.
  readonly organizationId: string;
  readonly personId: string;
  readonly activeOrganizationAtBind: string | null;
  readonly bindKey: string;
  readonly connectionId: string;
  readonly requestedModel: string | null;
  /** Host epoch milliseconds. Only attempts started at or after this are observed. */
  readonly boundAt: number;
}

export type EligibilityDecision =
  | { readonly eligible: true; readonly scope: ObservationScope }
  | { readonly eligible: false; readonly denial: ObservationDenial };

export interface EligibilityInput {
  readonly operator: ObservationOperatorConfig;
  readonly backend: 'faux' | 'cloud' | 'unavailable';
  readonly admission: AdmittedAgentWork | null;
  readonly work: {
    readonly rootJobId: string | null;
    readonly route: string;
    readonly connectionId: string;
    readonly model: string | null;
  };
  readonly activeOrganizationId: string | null;
  readonly telemetry: TelemetryPolicyPort;
  readonly now: number;
}

const deny = (denial: ObservationDenial): EligibilityDecision => ({ eligible: false, denial });

export const bindKeyFor = (surface: string, rootJobId: string) => `${surface}:${rootJobId}`;

export function decideObservationEligibility(input: EligibilityInput): EligibilityDecision {
  const { operator, admission, work } = input;
  if (operator.mode === 'off') return deny('observation-off');
  if (!admission) return deny('no-admission');
  if (!work.rootJobId) return deny('no-root-job');
  if (!isObservedRoute(work.route)) return deny('route-not-observable');
  const payer: ObservedPayer | null =
    admission.routeKind === 'managed' ? 'managed' : admission.routeKind === 'byo' ? 'byo' : null;
  if (!payer || (payer === 'managed') !== (work.route === MANAGED_ROUTE)) return deny('route-kind-not-observable');
  if (input.backend === 'unavailable') return deny('account-service-unavailable');
  if (!operator.pseudonymKey) return deny('pseudonym-key-missing');

  const internal = operator.internalOrganizations.has(admission.organizationId);
  let facts: Pick<ScopeFacts, 'class' | 'synthetic' | 'sourceTrust' | 'telemetryRevision'>;
  if (internal) {
    if (!operator.companyHost) return deny('not-company-host');
    facts = {
      class: input.backend === 'faux' ? 'internal-synthetic' : 'internal',
      synthetic: input.backend === 'faux',
      sourceTrust: 'company-host',
      telemetryRevision: null,
    };
  } else {
    // A faux account service holds test accounts; nothing it admits is customer data.
    if (input.backend === 'faux') return deny('faux-account-not-internal');
    const policy = input.telemetry.policyFor(admission.organizationId);
    if (!policy || policy.organizationId !== admission.organizationId) return deny('telemetry-policy-absent');
    if (policy.export !== 'metadata') return deny('telemetry-policy-none');
    if (!operator.customerExport) return deny('customer-export-disabled');
    facts = { class: 'customer-agent', synthetic: false, sourceTrust: 'client-reported', telemetryRevision: policy.revision };
  }
  return {
    eligible: true,
    scope: {
      scopeId: `osc_${derive('scope', operator.environment, admission.admissionId).slice(0, 24)}`,
      facts: {
        ...facts,
        environment: operator.environment,
        organizationKey: organizationKeyFor(operator.pseudonymKey, admission.organizationId),
        admissionId: admission.admissionId,
        surface: admission.surface as ObservedSurface,
        route: work.route,
        payer,
        plan: planOf(admission.planId),
        policyRevision: admission.policyRevision,
      },
      organizationId: admission.organizationId,
      personId: admission.personId,
      activeOrganizationAtBind: input.activeOrganizationId,
      bindKey: bindKeyFor(admission.surface, work.rootJobId),
      connectionId: work.connectionId,
      requestedModel: work.model,
      boundAt: input.now,
    },
  };
}

// --- the recheck --------------------------------------------------------------------

/** Live host answers, read at enqueue and again immediately before each send. */
export interface ObservationAuthorityPort {
  personId(): string | null;
  activeOrganizationId(): string | null;
  /** The account service's last answer for this business (cached; refreshed on sign-in and reload). */
  entitlement(organizationId: string): { readonly agent: boolean; readonly state: string } | null;
  /**
   * The business an admission for this project is asked for: the project's owner, else the active
   * business, as `AccountAgentGate.organizationFor` decides. Null is Personal. Absent reads the
   * active business.
   */
  organizationFor?(projectId: string | null): string | null;
}

export type ScopeRecheck = { readonly live: true } | { readonly live: false; readonly denial: ObservationDenial };

export function recheckScope(
  scope: ObservationScope,
  authority: ObservationAuthorityPort,
  operator: ObservationOperatorConfig,
  telemetry: TelemetryPolicyPort,
): ScopeRecheck {
  const end = (denial: ObservationDenial): ScopeRecheck => ({ live: false, denial });
  if (operator.mode === 'off') return end('observation-off');
  const person = authority.personId();
  if (!person) return end('signed-out');
  if (person !== scope.personId) return end('person-changed');
  if (authority.activeOrganizationId() !== scope.activeOrganizationAtBind) return end('workspace-changed');
  const entitlement = authority.entitlement(scope.organizationId);
  if (!entitlement || !entitlement.agent || entitlement.state !== 'active') return end('entitlement-inactive');
  if (scope.facts.class === 'customer-agent') {
    const policy = telemetry.policyFor(scope.organizationId);
    if (!policy) return end('telemetry-policy-absent');
    if (policy.export !== 'metadata') return end('telemetry-policy-none');
    if (!operator.customerExport) return end('customer-export-disabled');
  } else if (!operator.internalOrganizations.has(scope.organizationId)) return end('no-longer-internal');
  return { live: true };
}
