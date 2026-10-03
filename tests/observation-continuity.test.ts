/**
 * Deterministic continuity and privacy boundaries. Production adapter recreation
 * and actual generation projection are covered by automatic-work-host.test.ts.
 */
import { describe, expect, test } from 'vitest';
import type { HarnessRun } from '../shared/harness.js';
import { ownedTeamResponseMetadataSchema } from '../shared/agent-collaboration.js';
import type { AdmittedAgentWork } from '../server/accounts/agent-gate.js';
import { ObservationScopes, type ObservationBindInput } from '../server/observability/scopes.js';
import type { ObservationOperatorConfig, TelemetryPolicy } from '../server/observability/eligibility.js';

const ORG = 'org_continuity_fixture';
const PERSON = 'person_continuity_fixture';

function fixture(customer = false) {
  const state = {
    time: 1_000,
    admission: 0,
    person: PERSON as string | null,
    active: ORG as string | null,
    backend: (customer ? 'cloud' : 'faux') as 'cloud' | 'faux' | 'unavailable',
    entitlement: { agent: true, state: 'active' },
    entitlementThrows: false,
    policies: new Map<string, TelemetryPolicy>(),
    policy: { organizationId: ORG, revision: 7, export: 'metadata', source: 'account-service' } as TelemetryPolicy | null,
  };
  const operator: ObservationOperatorConfig = {
    mode: 'memory', environment: 'test', companyHost: true,
    internalOrganizations: new Set(customer ? [] : [ORG]),
    pseudonymKey: new Uint8Array(Buffer.from('ab'.repeat(32), 'hex')),
    customerExport: customer, posthog: null,
  };
  const scopes = new ObservationScopes({
    operator, backend: () => state.backend, now: () => state.time,
    authority: {
      personId: () => state.person, activeOrganizationId: () => state.active,
      organizationFor: () => ORG, entitlement: () => {
        if (state.entitlementThrows) throw new Error('Synthetic account outage');
        return state.entitlement;
      },
    },
    telemetry: { policyFor: organizationId => organizationId === ORG ? state.policy : state.policies.get(organizationId) ?? null },
  });
  const decide = (admitted: Partial<AdmittedAgentWork> = {}, input: Partial<ObservationBindInput> = {}) => {
    const admission: AdmittedAgentWork = {
      admissionId: `adm_continuity_${++state.admission}`, organizationId: ORG, personId: state.person ?? PERSON,
      planId: 'business', policyRevision: 3, routeKind: 'byo', surface: 'loop',
      validUntil: '2099-01-01T00:00:00.000Z', ...admitted,
    };
    return scopes.decide({
      admission, rootJobId: 'loop-root', route: 'openrouter', connectionId: 'connection-1',
      model: 'openai/gpt-6.1-sol', connectionRevision: 1, ...input,
    });
  };
  const bind = (admitted: Partial<AdmittedAgentWork> = {}, input: Partial<ObservationBindInput> = {}) => {
    const decision = decide(admitted, input);
    if (!decision.eligible) throw new Error(`Fixture bind was refused: ${decision.denial}`);
    return decision.scope;
  };
  const run = (state = 'running'): HarnessRun => ({
    id: 'loop-root', capabilityId: 'diomedes-loop', state,
    input: {}, events: [], steps: [], lastSeq: 0, sessionId: null,
  }) as unknown as HarnessRun; // Resolver-only fixture; production adapter proof uses the real host.
  return { state, scopes, bind, decide, run };
}

describe('owned Team observation identity', () => {
  test('the isolated observer enforces the shared strict metadata contract, including length and unknown-key limits', () => {
    const valid = { v: 1, grantId: 'grant', rootRunId: 'root', taskId: 'task', teamRunId: 'team',
      assignmentTaskId: 'assignment', parent: { runId: 'root', stepId: 'step' } };
    const cases: unknown[] = [valid, null, [], {}, { ...valid, v: 2 }, { ...valid, v: '1' },
      { ...valid, extra: true }, { ...valid, parent: { ...valid.parent, extra: true } }];
    for (const field of ['grantId', 'taskId', 'teamRunId', 'assignmentTaskId']) {
      for (const value of ['', 'a'.repeat(128), 'a'.repeat(129), ' ', null, 1, []]) cases.push({ ...valid, [field]: value });
      const missing = { ...valid } as Record<string, unknown>;
      delete missing[field];
      cases.push(missing);
    }
    for (const value of ['', 'a'.repeat(128), 'a'.repeat(129), '-root', 'root/path', 'root\n', null, 1])
      cases.push({ ...valid, rootRunId: value, parent: { ...valid.parent, runId: value } });
    for (const value of ['', 'a'.repeat(200), 'a'.repeat(201), null, 1])
      cases.push({ ...valid, parent: { ...valid.parent, stepId: value } });
    for (const parent of [null, [], {}, { runId: 'root' }, { stepId: 'step' }]) cases.push({ ...valid, parent });
    for (const candidate of cases) {
      const expected = ownedTeamResponseMetadataSchema.safeParse(candidate).success;
      const metadata = candidate && typeof candidate === 'object' ? candidate as typeof valid : valid;
      const f = fixture();
      // Match even malformed identities at the trusted bind seam to isolate resolver validation,
      // rather than passing only because a mutated field no longer matches an admitted identity.
      const ownedTeam = { ...metadata, runId: 'child', commandId: 'command' } as NonNullable<ObservationBindInput['ownedTeam']>;
      f.bind({ surface: 'team' }, { rootJobId: 'command', ownedTeam });
      const run = { ...f.run(), id: 'child', taskId: metadata.taskId, capabilityId: 'model-api-team-work',
        input: { commandId: 'command', rootRunId: metadata.rootRunId, parent: metadata.parent, ownedTeam: candidate } } as HarnessRun;
      expect(f.scopes.resolve(run) !== null, JSON.stringify(candidate)).toBe(expected);
    }
  });
});

describe('a scope boundary across fresh admissions', () => {
  test.each(['none', 'absent'] as const)('admission-observed policy %s fences every predecessor in that business only', policy => {
    const f = fixture(true);
    const first = f.bind();
    f.state.time = 1_500;
    const rebound = f.bind();
    const otherWork = f.bind({}, { rootJobId: 'another-root' });
    const otherOrg = 'org_unaffected';
    f.state.policies.set(otherOrg, { ...f.state.policy!, organizationId: otherOrg });
    const unrelated = f.bind({ organizationId: otherOrg }, { rootJobId: 'unrelated-root' });
    f.state.policy = policy === 'none' ? { ...f.state.policy!, export: 'none' } : null;
    const denial = policy === 'none' ? 'telemetry-policy-none' : 'telemetry-policy-absent';
    expect(f.decide()).toEqual({ eligible: false, denial });
    // No recheck during withdrawal: admission alone must remember it.
    f.state.policy = { organizationId: ORG, revision: 7, export: 'metadata', source: 'account-service' };
    f.state.time = 2_000;
    const fresh = f.bind();
    expect(fresh.boundAt).toBe(2_000);
    expect(fresh.facts.admissionId).not.toBe(first.facts.admissionId);
    for (const old of [first, rebound, otherWork]) {
      expect(old.organizationId).toBe(ORG);
      expect(f.scopes.recheck(old)).toEqual({ live: false, denial });
    }
    expect(unrelated.organizationId).toBe(otherOrg);
    expect(f.scopes.recheck(unrelated)).toEqual({ live: true });
    expect(f.scopes.recheck(fresh)).toEqual({ live: true });
  });

  test.each(['privacy', 'entitlement'] as const)('a recheck observing %s withdrawal fences predecessors before restoration', kind => {
    const f = fixture(true);
    const first = f.bind();
    const rebound = f.bind();
    if (kind === 'privacy') f.state.policy = { ...f.state.policy!, export: 'none' };
    else f.state.entitlement = { agent: false, state: 'expired' };
    const denial = kind === 'privacy' ? 'telemetry-policy-none' : 'entitlement-inactive';
    expect(f.scopes.recheck(rebound)).toEqual({ live: false, denial });
    f.state.policy = { ...f.state.policy!, export: 'metadata' };
    f.state.entitlement = { agent: true, state: 'active' };
    f.state.time = 2_000;
    const fresh = f.bind();
    expect(fresh.boundAt).toBe(2_000);
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial });
    expect(f.scopes.recheck(rebound)).toEqual({ live: false, denial });
    // Rechecking an already fenced object must not revoke a newly authorized scope.
    expect(f.scopes.recheck(fresh)).toEqual({ live: true });
  });

  test.each(['unknown', 'throws'] as const)('an admission outage and a %s entitlement recheck do not permanently revoke old scopes', outage => {
    const f = fixture(true);
    const first = f.bind();
    f.state.backend = 'unavailable';
    expect(f.decide()).toEqual({ eligible: false, denial: 'account-service-unavailable' });
    if (outage === 'unknown') f.state.entitlement = { agent: false, state: 'unknown' };
    else f.state.entitlementThrows = true;
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'account-service-unavailable' });
    f.state.backend = 'cloud';
    f.state.entitlement = { agent: true, state: 'active' };
    f.state.entitlementThrows = false;
    f.state.time = 2_000;
    expect(f.bind().boundAt).toBe(2_000);
    expect(f.scopes.recheck(first)).toEqual({ live: true });
  });

  test('a definitive withdrawal remains final through a subsequent outage and successful admission', () => {
    const f = fixture(true);
    const first = f.bind();
    f.state.policy = { ...f.state.policy!, export: 'none' };
    expect(f.decide()).toEqual({ eligible: false, denial: 'telemetry-policy-none' });
    f.state.backend = 'unavailable';
    expect(f.decide()).toEqual({ eligible: false, denial: 'account-service-unavailable' });
    f.state.entitlementThrows = true;
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'telemetry-policy-none' });
    f.state.backend = 'cloud';
    f.state.entitlementThrows = false;
    f.state.policy = { ...f.state.policy!, export: 'metadata' };
    f.bind();
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'telemetry-policy-none' });
  });

  test.each(['loop', 'team'] as const)('the same still-live %s identity keeps its first boundary despite a fresh admission ID', surface => {
    const f = fixture();
    const bindInput = { rootJobId: surface === 'loop' ? 'loop-root' : 'team-command' };
    const first = f.bind({ surface }, bindInput);
    const run = surface === 'loop' ? f.run() : ({
      ...f.run(), id: 'team-run', capabilityId: 'model-api-team-work', input: { commandId: 'team-command' },
    }) as HarnessRun;
    expect(f.scopes.resolve(run)?.scope).toBe(first);
    expect(f.scopes.recheck(first)).toEqual({ live: true });
    f.state.time = 2_000;
    const again = f.bind({ surface }, bindInput);
    expect(again.boundAt).toBe(1_000);
    expect(f.scopes.resolve(run)?.scope.boundAt).toBe(1_000);
  });

  test.each([
    ['model', {}, { model: 'vendor/other-model' }],
    ['connection', {}, { connectionId: 'connection-2' }],
    ['connection generation', {}, { connectionRevision: 2 }],
    ['route', {}, { route: 'azure-openai' }],
    ['routing policy', { policyRevision: 4 }, {}],
    ['plan', { planId: 'business-other' }, {}],
  ] as const)('a changed %s starts a new boundary', (_name, admitted, input) => {
    const f = fixture();
    const first = f.bind();
    f.state.time = 2_000;
    expect(f.bind(admitted, input).boundAt).toBe(2_000);
    expect(first.boundAt).toBe(1_000);
  });

  test('different raw plans must not appear identical because their export labels are both other', () => {
    const f = fixture();
    const first = f.bind({ planId: 'unknown-plan-a' });
    f.state.time = 2_000;
    const second = f.bind({ planId: 'unknown-plan-b' });
    expect(first.facts.plan).toBe('other');
    expect(second.facts.plan).toBe('other');
    expect(second.boundAt).toBe(2_000);
  });

  test('a changed backend class starts a fresh boundary', () => {
    const f = fixture();
    const first = f.bind();
    expect(first.facts.class).toBe('internal-synthetic');
    f.state.backend = 'cloud';
    f.state.time = 2_000;
    const second = f.bind();
    expect(second.facts.class).toBe('internal');
    expect(second.boundAt).toBe(2_000);
  });

  test('a definitive business refusal cannot be undone by a new identical admission', () => {
    const f = fixture();
    const first = f.bind();
    f.scopes.refused({ projectId: null, organizationId: ORG });
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'admission-refused' });
    f.state.time = 2_000;
    expect(f.bind().boundAt).toBe(2_000);
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'admission-refused' });
  });

  test.each(['person', 'workspace'] as const)('a %s departure and return never restores the earlier boundary', kind => {
    const f = fixture();
    const first = f.bind();
    if (kind === 'person') f.state.person = null;
    else f.state.active = 'org_elsewhere';
    f.scopes.observeContext();
    f.state.person = PERSON;
    f.state.active = ORG;
    f.scopes.observeContext();
    f.state.time = 2_000;
    expect(f.bind().boundAt).toBe(2_000);
    expect(f.scopes.recheck(first).live).toBe(false);
  });

  test('a workspace switch during the admission round trip still ends a stale ask', () => {
    const f = fixture();
    f.bind();
    const ask = f.scopes.ask(null);
    f.state.active = 'org_elsewhere';
    f.scopes.observeContext();
    f.state.active = ORG;
    f.scopes.observeContext();
    f.state.time = 2_000;
    const afterRoundTrip = f.bind({}, { ask });
    expect(f.scopes.recheck(afterRoundTrip).live).toBe(false);
  });

  test('observed privacy withdrawal remains ended when metadata export later returns', () => {
    const f = fixture(true);
    const first = f.bind();
    f.state.policy = { ...f.state.policy!, export: 'none' };
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'telemetry-policy-none' });
    f.state.policy = { ...f.state.policy!, export: 'metadata' };
    f.state.time = 2_000;
    expect(f.bind().boundAt).toBe(2_000);
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'telemetry-policy-none' });
  });

  test('a new telemetry revision starts a new boundary even while export remains metadata', () => {
    const f = fixture(true);
    f.bind();
    f.state.policy = { ...f.state.policy!, revision: 8 };
    f.state.time = 2_000;
    expect(f.bind().boundAt).toBe(2_000);
  });

  test('an observed ended entitlement is never revived by returning to active', () => {
    const f = fixture();
    const first = f.bind();
    f.state.entitlement = { agent: false, state: 'expired' };
    expect(f.scopes.recheck(first)).toEqual({ live: false, denial: 'entitlement-inactive' });
    f.state.entitlement = { agent: true, state: 'active' };
    f.state.time = 2_000;
    expect(f.bind().boundAt).toBe(2_000);
    expect(f.scopes.recheck(first).live).toBe(false);
  });

  test('a completed run starts fresh instead of retaining its earlier scope boundary', () => {
    const f = fixture();
    f.bind();
    const resolved = f.scopes.resolve(f.run())!;
    f.scopes.runEnded(f.run('completed'), resolved);
    f.state.time = 2_000;
    expect(f.bind().boundAt).toBe(2_000);
  });

  test('a fresh scopes instance never inherits a prior process boundary', () => {
    const before = fixture();
    expect(before.bind().boundAt).toBe(1_000);
    const after = fixture();
    after.state.time = 2_000;
    expect(after.bind().boundAt).toBe(2_000);
  });
});
