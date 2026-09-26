/**
 * PH-01: who may be observed, decided only from an admission and the operator's configuration,
 * and rechecked while events wait. Pure: no app, no network.
 */
import { describe, expect, test } from 'vitest';
import { AGENT_NOT_INCLUDED, AccountAgentGate, type AdmittedAgentWork } from '../server/accounts/agent-gate.js';
import { EngineError } from '../server/engines/process.js';
import { SIGN_IN_REQUIRED } from '../shared/accounts.js';
import {
  ABSENT_TELEMETRY_POLICY,
  OBSERVATION_OFF,
  decideObservationEligibility,
  isCalendarDay,
  operatorConfigFromEnv,
  recheckScope,
  type EligibilityInput,
  type ObservationAuthorityPort,
  type ObservationOperatorConfig,
  type ObservationScope,
  type TelemetryPolicyPort,
} from '../server/observability/eligibility.js';
import { ENTITLEMENT_REFUSALS, ObservationScopes, refusalEndsObservation } from '../server/observability/scopes.js';
import type { HarnessRun } from '../shared/harness.js';

const KEY_HEX = 'ab'.repeat(32);
const ORG_A = 'org_internal_a';
const ORG_B = 'org_customer_b';

const operator = (overrides: Partial<ObservationOperatorConfig> = {}): ObservationOperatorConfig => ({
  mode: 'memory',
  environment: 'test',
  companyHost: true,
  internalOrganizations: new Set([ORG_A]),
  pseudonymKey: new Uint8Array(Buffer.from(KEY_HEX, 'hex')),
  customerExport: false,
  posthog: null,
  ...overrides,
});
const admission = (overrides: Partial<AdmittedAgentWork> = {}): AdmittedAgentWork => ({
  admissionId: 'adm_0123456789abcdef',
  organizationId: ORG_A,
  personId: 'person_1',
  planId: 'business',
  policyRevision: 3,
  routeKind: 'byo',
  surface: 'conversation',
  validUntil: '2026-09-25T13:00:00.000Z',
  ...overrides,
});
const input = (overrides: Partial<EligibilityInput> = {}): EligibilityInput => ({
  operator: operator(),
  backend: 'faux',
  admission: admission(),
  work: { rootJobId: 'conv-1', route: 'aws-bedrock', connectionId: 'conn-1', model: 'us.openai.gpt-6-luna' },
  activeOrganizationId: ORG_A,
  telemetry: ABSENT_TELEMETRY_POLICY,
  now: 1_000,
  ...overrides,
});
const denial = (value: EligibilityInput) => {
  const decision = decideObservationEligibility(value);
  return decision.eligible ? 'eligible' : decision.denial;
};
const metadataPolicy = (organizationId = ORG_B, exportMode: 'none' | 'metadata' = 'metadata'): TelemetryPolicyPort => ({
  policyFor: (id) => (id === organizationId ? { organizationId, revision: 7, export: exportMode, source: 'account-service' } : null),
});

describe('the bind decision, in order', () => {
  test('each refusal, and nothing eligible without every condition', () => {
    expect(denial(input({ operator: OBSERVATION_OFF }))).toBe('observation-off');
    expect(denial(input({ admission: null }))).toBe('no-admission');
    expect(denial(input({ work: { ...input().work, rootJobId: null } }))).toBe('no-root-job');
    expect(denial(input({ work: { ...input().work, route: 'claude' } }))).toBe('route-not-observable');
    expect(denial(input({ work: { ...input().work, route: 'native-fixture' } }))).toBe('route-not-observable');
    // A managed admission must be on the managed route, and a byo one on a connection route.
    expect(denial(input({ admission: admission({ routeKind: 'managed' }) }))).toBe('route-kind-not-observable');
    expect(denial(input({ work: { ...input().work, route: 'nectovia' } }))).toBe('route-kind-not-observable');
    expect(denial(input({ admission: admission({ routeKind: 'local' }) }))).toBe('route-kind-not-observable');
    expect(denial(input({ admission: admission({ routeKind: 'external-engine' }) }))).toBe('route-kind-not-observable');
    expect(denial(input({ backend: 'unavailable' }))).toBe('account-service-unavailable');
    expect(denial(input({ operator: operator({ pseudonymKey: null }) }))).toBe('pseudonym-key-missing');
    expect(denial(input({ operator: operator({ companyHost: false }) }))).toBe('not-company-host');
    expect(denial(input({ operator: operator({ internalOrganizations: new Set() }) }))).toBe('faux-account-not-internal');
    // A customer on the real service: no telemetry policy exists in production (D1).
    const customer = { admission: admission({ organizationId: ORG_B }), backend: 'cloud' as const };
    expect(denial(input(customer))).toBe('telemetry-policy-absent');
    expect(denial(input({ ...customer, telemetry: metadataPolicy(ORG_B, 'none') }))).toBe('telemetry-policy-none');
    expect(denial(input({ ...customer, telemetry: metadataPolicy() }))).toBe('customer-export-disabled');
    // A policy answered for another business is no policy for this one.
    expect(denial(input({ ...customer, telemetry: { policyFor: () => ({ organizationId: ORG_A, revision: 1, export: 'metadata', source: 'account-service' }) } }))).toBe(
      'telemetry-policy-absent',
    );
  });

  test('an internal organization on the faux service is internal-synthetic; on the cloud, internal; a customer fixture is client-reported', () => {
    const faux = decideObservationEligibility(input());
    expect(faux.eligible && faux.scope.facts).toMatchObject({
      class: 'internal-synthetic',
      synthetic: true,
      sourceTrust: 'company-host',
      environment: 'test',
      admissionId: 'adm_0123456789abcdef',
      surface: 'conversation',
      route: 'aws-bedrock',
      payer: 'byo',
      plan: 'business',
      policyRevision: 3,
      telemetryRevision: null,
    });
    const cloud = decideObservationEligibility(input({ backend: 'cloud' }));
    expect(cloud.eligible && cloud.scope.facts).toMatchObject({ class: 'internal', synthetic: false });
    const customer = decideObservationEligibility(
      input({ backend: 'cloud', admission: admission({ organizationId: ORG_B }), telemetry: metadataPolicy(), operator: operator({ customerExport: true }) }),
    );
    expect(customer.eligible && customer.scope.facts).toMatchObject({ class: 'customer-agent', sourceTrust: 'client-reported', telemetryRevision: 7 });
    const managed = decideObservationEligibility(
      input({ admission: admission({ routeKind: 'managed' }), work: { ...input().work, route: 'nectovia', model: 'nectovia-standard-1' } }),
    );
    expect(managed.eligible && managed.scope.facts).toMatchObject({ route: 'nectovia', payer: 'managed' });
  });

  test('the organization never leaves as itself: a keyed pseudonym that changes with the key', () => {
    const one = decideObservationEligibility(input());
    const two = decideObservationEligibility(input({ operator: operator({ pseudonymKey: new Uint8Array(32).fill(7) }) }));
    if (!one.eligible || !two.eligible) throw new Error('expected eligible');
    expect(one.scope.facts.organizationKey).toMatch(/^oorg_[0-9a-f]{32}$/);
    expect(one.scope.facts.organizationKey).not.toBe(two.scope.facts.organizationKey);
    expect(JSON.stringify(one.scope.facts)).not.toContain(ORG_A);
    expect(JSON.stringify(one.scope.facts)).not.toContain('person_1');
    expect(JSON.stringify(one.scope.facts)).not.toContain('conn-1');
  });

  test('an admission for organization B while A is internal gives B no internal class', () => {
    expect(denial(input({ admission: admission({ organizationId: ORG_B }) }))).toBe('faux-account-not-internal');
    expect(denial(input({ admission: admission({ organizationId: ORG_B }), backend: 'cloud' }))).toBe('telemetry-policy-absent');
  });

  test('plans outside the templates are other; no plan is none', () => {
    const other = decideObservationEligibility(input({ admission: admission({ planId: 'custom-deal-for-acme' }) }));
    const none = decideObservationEligibility(input({ admission: admission({ planId: null }) }));
    expect(other.eligible && other.scope.facts.plan).toBe('other');
    expect(none.eligible && none.scope.facts.plan).toBe('none');
  });
});

describe('operator configuration from the environment', () => {
  test('default is off; customer export is never read from the environment; unknown variables are ignored', () => {
    expect(operatorConfigFromEnv({})).toBe(OBSERVATION_OFF);
    expect(operatorConfigFromEnv({ NECTOVIA_OBSERVATION: 'yes' })).toBe(OBSERVATION_OFF);
    const config = operatorConfigFromEnv({
      NECTOVIA_OBSERVATION: 'memory',
      NECTOVIA_OBSERVATION_ENVIRONMENT: 'internal',
      NECTOVIA_OBSERVATION_COMPANY_HOST: '1',
      NECTOVIA_OBSERVATION_INTERNAL_ORGS: `${ORG_A}, bad org id ,${ORG_B}`,
      NECTOVIA_OBSERVATION_PSEUDONYM_KEY: KEY_HEX,
      NECTOVIA_OBSERVATION_CUSTOMER_EXPORT: '1',
      NECTOVIA_OBSERVATION_INTERNAL: 'true',
    });
    expect(config).toMatchObject({ mode: 'memory', environment: 'internal', companyHost: true, customerExport: false, posthog: null });
    expect([...config.internalOrganizations]).toEqual([ORG_A, ORG_B]);
    expect(config.pseudonymKey?.length).toBe(32);
  });

  test('a short or malformed key is no key; an unknown environment is development', () => {
    const short = operatorConfigFromEnv({ NECTOVIA_OBSERVATION: 'memory', NECTOVIA_OBSERVATION_PSEUDONYM_KEY: 'ab'.repeat(16) });
    expect(short.pseudonymKey).toBeNull();
    expect(short.environment).toBe('development');
    expect(operatorConfigFromEnv({ NECTOVIA_OBSERVATION: 'memory', NECTOVIA_OBSERVATION_PSEUDONYM_KEY: 'zz'.repeat(32) }).pseudonymKey).toBeNull();
  });

  test('posthog settings need an https origin and a capture-key shape; funding and budget default to none', () => {
    const base = { NECTOVIA_OBSERVATION: 'posthog', NECTOVIA_POSTHOG_CAPTURE_KEY: 'phc_testOnly0123456789abcdef' };
    expect(operatorConfigFromEnv({ ...base, NECTOVIA_POSTHOG_HOST: 'https://us.i.posthog.com' }).posthog).toEqual({
      host: 'https://us.i.posthog.com',
      captureKey: 'phc_testOnly0123456789abcdef',
      fundedUntil: null,
      dailyEvents: 0,
    });
    expect(operatorConfigFromEnv({ ...base, NECTOVIA_POSTHOG_HOST: 'http://us.i.posthog.com' }).posthog).toBeNull();
    expect(operatorConfigFromEnv({ ...base, NECTOVIA_POSTHOG_HOST: 'https://u:p@us.i.posthog.com' }).posthog).toBeNull();
    expect(operatorConfigFromEnv({ ...base, NECTOVIA_POSTHOG_HOST: 'https://us.i.posthog.com/batch/' }).posthog).toBeNull();
    expect(operatorConfigFromEnv({ ...base, NECTOVIA_POSTHOG_HOST: 'https://us.i.posthog.com', NECTOVIA_POSTHOG_CAPTURE_KEY: 'not a key' }).posthog).toBeNull();
    const funded = operatorConfigFromEnv({
      ...base,
      NECTOVIA_POSTHOG_HOST: 'https://us.i.posthog.com',
      NECTOVIA_OBSERVATION_FUNDED_UNTIL: '2027-03-31',
      NECTOVIA_OBSERVATION_DAILY_EVENTS: '5000',
    }).posthog;
    expect(funded).toMatchObject({ fundedUntil: '2027-03-31', dailyEvents: 5000 });
    // A funded-until that is not a calendar day reads as absent (PH-07 F-5): JavaScript would roll these over.
    for (const day of ['2099-02-30', '2027-02-29', '2027-04-31', '2027-13-01', '2027-00-10', '2027-3-31'])
      expect(
        operatorConfigFromEnv({ ...base, NECTOVIA_POSTHOG_HOST: 'https://us.i.posthog.com', NECTOVIA_OBSERVATION_FUNDED_UNTIL: day }).posthog?.fundedUntil,
        day,
      ).toBeNull();
    expect(isCalendarDay('2028-02-29')).toBe(true);
  });
});

describe('the recheck while events wait', () => {
  const eligible = decideObservationEligibility(input());
  if (!eligible.eligible) throw new Error('expected eligible');
  const scope: ObservationScope = eligible.scope;
  const authority = (overrides: Partial<{ person: string | null; active: string | null; entitlement: { agent: boolean; state: string } | null }> = {}): ObservationAuthorityPort => {
    const values = { person: 'person_1', active: ORG_A as string | null, entitlement: { agent: true, state: 'active' } as { agent: boolean; state: string } | null, ...overrides };
    return { personId: () => values.person, activeOrganizationId: () => values.active, entitlement: () => values.entitlement };
  };
  const recheck = (port: ObservationAuthorityPort, config = operator(), telemetry: TelemetryPolicyPort = ABSENT_TELEMETRY_POLICY) => {
    const result = recheckScope(scope, port, config, telemetry);
    return result.live ? 'live' : result.denial;
  };

  test('each change ends optional export; the same person, workspace and plan keep it', () => {
    expect(recheck(authority())).toBe('live');
    expect(recheck(authority({ person: null }))).toBe('signed-out');
    expect(recheck(authority({ person: 'person_2' }))).toBe('person-changed');
    expect(recheck(authority({ active: null }))).toBe('workspace-changed');
    expect(recheck(authority({ active: ORG_B }))).toBe('workspace-changed');
    expect(recheck(authority({ entitlement: { agent: true, state: 'revoked' } }))).toBe('entitlement-inactive');
    expect(recheck(authority({ entitlement: { agent: true, state: 'expired' } }))).toBe('entitlement-inactive');
    expect(recheck(authority({ entitlement: { agent: true, state: 'unknown' } }))).toBe('entitlement-inactive');
    expect(recheck(authority({ entitlement: { agent: false, state: 'active' } }))).toBe('entitlement-inactive');
    expect(recheck(authority({ entitlement: null }))).toBe('entitlement-inactive');
    expect(recheck(authority(), operator({ internalOrganizations: new Set() }))).toBe('no-longer-internal');
    expect(recheck(authority(), OBSERVATION_OFF)).toBe('observation-off');
  });

  test('a customer scope ends when the policy tightens to none', () => {
    const customer = decideObservationEligibility(
      input({ backend: 'cloud', admission: admission({ organizationId: ORG_B }), telemetry: metadataPolicy(), operator: operator({ customerExport: true }), activeOrganizationId: ORG_B }),
    );
    if (!customer.eligible) throw new Error('expected eligible');
    const port: ObservationAuthorityPort = { personId: () => 'person_1', activeOrganizationId: () => ORG_B, entitlement: () => ({ agent: true, state: 'active' }) };
    const config = operator({ customerExport: true });
    expect(recheckScope(customer.scope, port, config, metadataPolicy()).live).toBe(true);
    expect(recheckScope(customer.scope, port, config, metadataPolicy(ORG_B, 'none'))).toEqual({ live: false, denial: 'telemetry-policy-none' });
    expect(recheckScope(customer.scope, port, config, ABSENT_TELEMETRY_POLICY)).toEqual({ live: false, denial: 'telemetry-policy-absent' });
  });
});

describe('scopes: bound by the admitted job, resolved from the run record', () => {
  const run = (overrides: Partial<HarnessRun>): HarnessRun =>
    ({ id: 'run-x', capabilityId: 'model-api-turn', input: {}, events: [], steps: [], lastSeq: 0, sessionId: null, ...overrides }) as HarnessRun;
  const scopesFor = (limit?: number) =>
    new ObservationScopes({
      operator: operator(),
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => ORG_A, entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => 1_000,
      limit,
    });
  const bind = (scopes: ObservationScopes, surface: AdmittedAgentWork['surface'], rootJobId: string | null) =>
    scopes.decide({ admission: admission({ surface }), rootJobId, route: 'aws-bedrock', connectionId: 'conn-1', model: 'us.openai.gpt-6-luna' });

  test('each capability resolves through the key its caller bound, and nothing else resolves', () => {
    const scopes = scopesFor();
    // Each message is its own job: the conversation admission names the turn run's own id.
    bind(scopes, 'conversation', 'turn-1');
    bind(scopes, 'work', 'text-run-1');
    bind(scopes, 'team', 'request-1');
    bind(scopes, 'loop', 'loop-root');
    expect(scopes.resolve(run({ id: 'turn-1', capabilityId: 'model-api-turn', input: { conversationRunId: 'lineage-1' } }))).toMatchObject({
      own: true,
      traceRootRunId: 'turn-1',
      lineageRunId: 'lineage-1',
    });
    // Another message in the same conversation was not admitted by that admission.
    expect(scopes.resolve(run({ id: 'turn-2', capabilityId: 'model-api-turn', input: { conversationRunId: 'lineage-1' } }))).toBeNull();
    // A turn that names no conversation is not a turn this host made.
    expect(scopes.resolve(run({ id: 'turn-1', capabilityId: 'model-api-turn', input: {} }))).toBeNull();
    // The lineage run holds history, not work.
    expect(scopes.resolve(run({ id: 'lineage-1', capabilityId: 'model-api-conversation' }))).toBeNull();
    expect(scopes.resolve(run({ id: 'text-run-1', capabilityId: 'engine-text-turn' }))).toMatchObject({ traceRootRunId: 'text-run-1' });
    expect(scopes.resolve(run({ id: 'text-run-2', capabilityId: 'engine-text-turn' }))).toBeNull();
    expect(scopes.resolve(run({ id: 'team-run', capabilityId: 'model-api-team-work', input: { commandId: 'request-1' } }))).toMatchObject({ traceRootRunId: 'team-run' });
    expect(scopes.resolve(run({ id: 'loop-root', capabilityId: 'diomedes-loop' }))).toMatchObject({ traceRootRunId: 'loop-root', parentRunId: null });
    // A delegate that did not admit on its own inherits its loop root's scope, never its model or connection.
    const inherited = scopes.resolve(
      run({ id: 'child-1', capabilityId: 'diomedes-loop-delegate', input: { parent: { runId: 'loop-root', stepId: 'tool:2' }, rootRunId: 'loop-root' } }),
    );
    expect(inherited).toMatchObject({ own: false, traceRootRunId: 'loop-root', parentRunId: 'loop-root' });
    // A worker admits under its own id.
    bind(scopes, 'loop', 'worker-1');
    expect(
      scopes.resolve(run({ id: 'worker-1', capabilityId: 'diomedes-loop-worker', input: { parent: { runId: 'loop-root', stepId: 'team:1' } } })),
    ).toMatchObject({ own: true, traceRootRunId: 'loop-root', parentRunId: 'loop-root' });
    // Other capabilities never resolve, whatever their input says.
    expect(scopes.resolve(run({ id: 'x', capabilityId: 'weekly-brief', input: { conversationRunId: 'lineage-1' } }))).toBeNull();
  });

  test('an admission with no job id, or a refused one, binds nothing and counts its reason', () => {
    const scopes = scopesFor();
    expect(bind(scopes, 'loop', null)).toMatchObject({ eligible: false, denial: 'no-root-job' });
    scopes.bind({ admission: null, rootJobId: 'x', route: 'aws-bedrock', connectionId: 'c', model: null });
    expect(scopes.size).toBe(0);
    expect(scopes.denials()).toEqual({ 'no-root-job': 1, 'no-admission': 1 });
  });

  test('a refused later admission for the same work ends the earlier scope', () => {
    const scopes = scopesFor();
    bind(scopes, 'conversation', 'lineage-1');
    expect(scopes.size).toBe(1);
    scopes.bind({ admission: admission({ surface: 'conversation', organizationId: ORG_B }), rootJobId: 'lineage-1', route: 'aws-bedrock', connectionId: 'c', model: null });
    expect(scopes.size).toBe(0);
  });

  test('a refused admission ends every scope of that business, though its cached entitlement still reads active; a later admitted bind is live (PH-07 F-2)', () => {
    const owners: Record<string, string> = { 'project-a': ORG_A, 'project-b': ORG_B };
    const scopes = new ObservationScopes({
      operator: operator({ internalOrganizations: new Set([ORG_A, ORG_B]) }),
      backend: () => 'faux',
      authority: {
        personId: () => 'person_1',
        activeOrganizationId: () => ORG_A,
        // The cached answer has not caught up with the revocation.
        entitlement: () => ({ agent: true, state: 'active' }),
        organizationFor: (projectId) => (projectId ? (owners[projectId] ?? null) : ORG_A),
      },
      now: () => 1_000,
    });
    const bindFor = (organizationId: string, rootJobId: string, admissionId: string) => {
      const decision = scopes.decide({
        admission: admission({ surface: 'work', organizationId, admissionId }),
        rootJobId,
        route: 'aws-bedrock',
        connectionId: 'conn-1',
        model: null,
      });
      if (!decision.eligible) throw new Error(`expected eligible: ${decision.denial}`);
      return decision.scope;
    };
    const a = bindFor(ORG_A, 'work-a', 'adm_a1');
    const b = bindFor(ORG_B, 'work-b', 'adm_b1');
    scopes.refused({ projectId: 'project-a' });
    expect(scopes.recheck(a)).toEqual({ live: false, denial: 'admission-refused' });
    expect(scopes.recheck(b)).toEqual({ live: true });
    expect(scopes.resolve(run({ id: 'work-a', capabilityId: 'engine-text-turn' }))).toBeNull();
    expect(scopes.resolve(run({ id: 'work-b', capabilityId: 'engine-text-turn' }))).not.toBeNull();
    // Admitted again later: a new scope, live. The ended one stays ended.
    const again = bindFor(ORG_A, 'work-a', 'adm_a2');
    expect(scopes.recheck(again)).toEqual({ live: true });
    expect(scopes.recheck(a).live).toBe(false);
    // A project no business owns and Personal work end nothing.
    scopes.refused({ projectId: 'project-personal' });
    expect(scopes.recheck(again)).toEqual({ live: true });
    expect(scopes.recheck(b)).toEqual({ live: true });
    expect(scopes.denials()['admission-refused']).toBeGreaterThanOrEqual(1);
  });

  test('a refusal ends the business passed to it, even when the active business has since changed (PH-07 N-1)', () => {
    let active: string | null = ORG_A;
    const scopes = new ObservationScopes({
      operator: operator({ internalOrganizations: new Set([ORG_A, ORG_B]) }),
      backend: () => 'faux',
      authority: {
        personId: () => 'person_1',
        activeOrganizationId: () => active,
        entitlement: () => ({ agent: true, state: 'active' }),
        organizationFor: (projectId) => (projectId === 'owned-by-b' ? ORG_B : active),
      },
      now: () => 1_000,
    });
    const bindFor = (organizationId: string, rootJobId: string) => {
      const decision = scopes.decide({
        admission: admission({ surface: 'work', organizationId, admissionId: `adm_${rootJobId}` }),
        rootJobId,
        route: 'aws-bedrock',
        connectionId: 'conn-1',
        model: null,
      });
      if (!decision.eligible) throw new Error(`expected eligible: ${decision.denial}`);
      return decision.scope;
    };
    const a = bindFor(ORG_A, 'work-a');
    // The gate's rule: the project's owner, else the active business. Read before the round trip.
    expect(scopes.businessFor('unowned')).toBe(ORG_A);
    expect(scopes.businessFor('owned-by-b')).toBe(ORG_B);
    expect(scopes.businessFor(null)).toBe(ORG_A);
    const asked = scopes.businessFor('unowned');
    active = ORG_B; // the person switches while the admission is on the wire
    scopes.refused({ projectId: 'unowned', organizationId: asked });
    expect(scopes.resolve(run({ id: 'work-a', capabilityId: 'engine-text-turn' }))).toBeNull();
    expect(scopes.recheck(a)).toMatchObject({ live: false });
    // Harbor's business was not refused: a scope bound for it now is live.
    const b = bindFor(ORG_B, 'work-b');
    expect(scopes.recheck(b)).toEqual({ live: true });
    // An explicit null (Personal) ends nothing, and is not re-derived from the project.
    scopes.refused({ projectId: 'owned-by-b', organizationId: null });
    expect(scopes.recheck(b)).toEqual({ live: true });
  });

  test('only a refusal that says the business is not entitled ends observation; an outage or sign-in does not (PH-07 N-2)', () => {
    const withCode = (code: string) => Object.defineProperty(new EngineError(AGENT_NOT_INCLUDED, 'x', false), 'refusalCode', { value: code });
    expect([...ENTITLEMENT_REFUSALS].sort()).toEqual(['agent_not_included', 'entitlement_expired', 'entitlement_revoked', 'not_a_member']);
    for (const code of ENTITLEMENT_REFUSALS) expect(refusalEndsObservation(withCode(code)), code).toBe(true);
    for (const code of ['entitlement_unknown', SIGN_IN_REQUIRED, 'SIGN_IN_REQUIRED', 'personal_workspace', 'cap_request_required', ''])
      expect(refusalEndsObservation(withCode(code)), code).toBe(false);
    expect(refusalEndsObservation(new EngineError(AGENT_NOT_INCLUDED, 'x', false))).toBe(false);
    expect(refusalEndsObservation(new Error('boom'))).toBe(false);
    expect(refusalEndsObservation(null)).toBe(false);
  });

  test('the gate’s refusal carries the service’s code and is otherwise the same error it always threw (PH-07 N-2)', async () => {
    const refusedWith = async (code: string, reason: string) => {
      const gate = new AccountAgentGate(
        { admitAgent: async () => ({ admitted: false, code, reason }) } as never,
        { projectOwner: () => null, active: () => ({ kind: 'business', organizationId: ORG_A }) } as never,
      );
      return gate.check({ phase: 'admit', surface: 'conversation', projectId: 'p1', rootJobId: 'job-1' }).then(
        () => {
          throw new Error('expected a refusal');
        },
        (error: unknown) => error as EngineError,
      );
    };
    for (const code of ['entitlement_revoked', 'entitlement_unknown', 'not_a_member']) {
      const reason = `The reason for ${code}.`;
      const thrown = await refusedWith(code, reason);
      const before = new EngineError(AGENT_NOT_INCLUDED, reason, false);
      expect(thrown.constructor).toBe(EngineError);
      expect([thrown.name, thrown.code, thrown.message, thrown.status, thrown.ambiguous]).toEqual([before.name, before.code, before.message, before.status, before.ambiguous]);
      expect(Object.keys(thrown)).toEqual(Object.keys(before));
      expect(JSON.stringify(thrown)).toBe(JSON.stringify(before));
      expect(JSON.stringify({ ...thrown })).toBe(JSON.stringify({ ...before }));
      expect((thrown as unknown as { refusalCode: string }).refusalCode).toBe(code);
      expect(() => {
        (thrown as unknown as { refusalCode: string }).refusalCode = 'agent_not_included';
      }).toThrow();
    }
    // The service's sign-in refusal keeps the gate's sign-in error, and ends nothing.
    const signIn = await refusedWith(SIGN_IN_REQUIRED, 'Sign in.');
    expect(signIn.code).toBe('SIGN_IN_REQUIRED');
    expect(refusalEndsObservation(signIn)).toBe(false);
  });

  test('sign-out, another person or another business ends a scope for good, even once undone; the next bind is fresh (PH-07 N-3)', () => {
    let person: string | null = 'person_1';
    let active: string | null = ORG_A;
    const scopes = new ObservationScopes({
      operator: operator(),
      backend: () => 'faux',
      authority: { personId: () => person, activeOrganizationId: () => active, entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => 1_000,
    });
    const bindAs = (rootJobId: string) => {
      const decision = scopes.decide({
        admission: admission({ surface: 'work', admissionId: `adm_${rootJobId}` }),
        rootJobId,
        route: 'aws-bedrock',
        connectionId: 'conn-1',
        model: null,
      });
      if (!decision.eligible) throw new Error(`expected eligible: ${decision.denial}`);
      return decision.scope;
    };
    // A save that changes nothing ends nothing.
    const first = bindAs('work-1');
    scopes.observeContext();
    scopes.observeContext();
    expect(scopes.recheck(first)).toEqual({ live: true });
    // Away and back before any recheck: seen at the switch, final.
    active = ORG_B;
    scopes.observeContext();
    active = ORG_A;
    scopes.observeContext();
    expect(scopes.recheck(first)).toEqual({ live: false, denial: 'workspace-changed' });
    // The run still resolves to its (ended) scope; its events drop at the recheck.
    expect(scopes.resolve(run({ id: 'work-1', capabilityId: 'engine-text-turn' }))?.scope).toBe(first);
    // The next admission binds a fresh scope, which is live; the old one stays ended.
    const second = bindAs('work-1');
    expect(second).not.toBe(first);
    expect(scopes.recheck(second)).toEqual({ live: true });
    expect(scopes.recheck(first).live).toBe(false);
    // Sign-out and sign-in again as the same person.
    person = null;
    scopes.observeContext();
    person = 'person_1';
    scopes.observeContext();
    expect(scopes.recheck(second)).toEqual({ live: false, denial: 'signed-out' });
    const third = bindAs('work-2');
    expect(scopes.recheck(third)).toEqual({ live: true });
    // A failed recheck is final even when nothing was seen in between: the first answer stands.
    active = ORG_B;
    expect(scopes.recheck(third)).toEqual({ live: false, denial: 'workspace-changed' });
    active = ORG_A;
    expect(scopes.recheck(third).live).toBe(false);
  });

  test('bounded: the oldest scope is forgotten first', () => {
    const scopes = scopesFor(2);
    bind(scopes, 'work', 'a');
    bind(scopes, 'work', 'b');
    bind(scopes, 'work', 'c');
    expect(scopes.size).toBe(2);
    expect(scopes.resolve(run({ id: 'a', capabilityId: 'engine-text-turn' }))).toBeNull();
    expect(scopes.resolve(run({ id: 'c', capabilityId: 'engine-text-turn' }))).not.toBeNull();
  });
});
