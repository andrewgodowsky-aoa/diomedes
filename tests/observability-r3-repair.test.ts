/**
 * PH-07 round 3 repair: the four findings, each at its cause.
 *
 *   R3-1  an access read that fails in transport, by status or in parsing is an inability to ask,
 *         never final; only a well-formed answer that the business is not entitled ends a scope
 *   R3-2  only the account service's own membership refusal is `not_a_member`
 *   R3-3  a scope is measured from the ask, read before the admission's round trip
 *   R3-4  the scope map never forgets a scope a live run has claimed, and counts what it forgets
 *
 * The account service is the faux service in this process, reached through a fetcher a test may
 * intercept. Nothing here reaches PostHog or any other host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountBackend } from '../server/accounts/backend.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import type { AdmittedAgentWork } from '../server/accounts/agent-gate.js';
import { AccountSessionService, MEMBERSHIP_REFUSALS, refusedMembership } from '../server/accounts/session.js';
import { ApiError } from '../server/paths.js';
import {
  recheckScope,
  type ObservationAuthorityPort,
  type ObservationOperatorConfig,
  type ObservationScope,
} from '../server/observability/eligibility.js';
import { ObservationProjector } from '../server/observability/projector.js';
import { ObservationScopes, refusalEndsObservation } from '../server/observability/scopes.js';
import { AccountAgentGate } from '../server/accounts/agent-gate.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';
import type { HarnessEvent, HarnessRun, StepRecord } from '../shared/harness.js';
import type { Observation } from '../shared/observability.js';

const operator = (internal: string[]): ObservationOperatorConfig => ({
  mode: 'memory',
  environment: 'test',
  companyHost: true,
  internalOrganizations: new Set(internal),
  pseudonymKey: new Uint8Array(32).fill(7),
  customerExport: false,
  posthog: null,
});
const admission = (
  organizationId: string,
  admissionId: string,
  surface: AdmittedAgentWork['surface'] = 'conversation',
): AdmittedAgentWork => ({
  admissionId,
  organizationId,
  personId: 'person_1',
  planId: 'business',
  policyRevision: 1,
  routeKind: 'byo',
  surface,
  validUntil: '2026-09-26T13:00:00.000Z',
});

// --- the faux account service -------------------------------------------------------------------

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let intercept: ((request: Request) => Promise<Response> | null) | null;
let dir: string;
const pathOf = (request: Request) => new URL(request.url).pathname;
const isAccess = (request: Request) => request.method === 'GET' && /^\/account\/organizations\/[^/]+\/access$/.test(pathOf(request));
const isAdmission = (request: Request) => request.method === 'POST' && pathOf(request).endsWith('/agent-admissions');
const json = (status: number, value: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } });
/** A body whose stream fails after its first bytes, as a read cut off by a timeout does. */
const brokenBody = (prefix: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function signedIn(email: string) {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', (request) => intercept?.(request) ?? cloud.handle(request)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, dir, null);
  await session.init();
  await session.signIn({ email, password: FAUX_DEMO_PASSWORD, remember: false });
  return session;
}
async function tokenFor(email: string) {
  const pair = await cloud.store.run((draft) => cloud.identity.signIn(draft.identity, { email, password: FAUX_DEMO_PASSWORD, remember: false }));
  await cloud.accounts.signIn(pair.accessToken);
  return pair.accessToken;
}
/** Observation over a real session: the same authority `createObservation` builds. */
function observing(session: AccountSessionService, active: string) {
  const authority: ObservationAuthorityPort = {
    personId: () => session.personId(),
    activeOrganizationId: () => active,
    entitlement: (organizationId) => session.entitlement(organizationId),
  };
  const scopes = new ObservationScopes({ operator: operator([orgs.juniper, orgs.harbor]), backend: () => 'faux', authority });
  const bound = (job: string) => {
    const decision = scopes.decide({
      admission: { ...admission(active, `adm_${job}`), personId: session.personId()! },
      rootJobId: job,
      route: 'aws-bedrock',
      connectionId: 'c1',
      model: null,
    });
    if (!decision.eligible) throw new Error(decision.denial);
    return decision.scope;
  };
  return { scopes, bound, authority };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-r3-repair-'));
  intercept = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
});
afterEach(async () => {
  intercept = null;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// =================================================================================================
// R3-1
// =================================================================================================

describe('R3-1 an unanswered access read is an inability to ask', () => {
  test('recheckScope: `unknown` is `account-service-unavailable`; only an answer is `entitlement-inactive`', () => {
    const scope = { organizationId: 'org_a', personId: 'person_1', activeOrganizationAtBind: 'org_a', facts: { class: 'internal' } } as ObservationScope;
    const recheckWith = (entitlement: ReturnType<ObservationAuthorityPort['entitlement']>) =>
      recheckScope(scope, { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => entitlement }, operator(['org_a']), {
        policyFor: () => null,
      });
    expect(recheckWith({ agent: false, state: 'unknown' })).toEqual({ live: false, denial: 'account-service-unavailable' });
    expect(recheckWith({ agent: true, state: 'active' })).toEqual({ live: true });
    for (const answer of [null, { agent: false, state: 'revoked' }, { agent: false, state: 'expired' }, { agent: false, state: 'none' }, { agent: false, state: 'active' }])
      expect(recheckWith(answer), JSON.stringify(answer)).toEqual({ live: false, denial: 'entitlement-inactive' });
  });

  test(
    'every failed access read during a refresh leaves the business `unknown`, the scope survives it, and it is live once the service answers',
    async () => {
      const session = await signedIn('owner@juniper.test');
      const { scopes, bound } = observing(session, orgs.juniper);
      const real = await cloud.handle(new Request(`http://faux.local/account/organizations/${orgs.juniper}/access`, {
        headers: { authorization: `Bearer ${await tokenFor('owner@juniper.test')}` },
      })).then((response) => response.json() as Promise<Record<string, unknown>>);
      expect(real.organizationId, 'precondition: a real answer').toBe(orgs.juniper);
      const modes: Record<string, () => Promise<Response>> = {
        '503': async () => json(503, { error: 'upstream unavailable' }),
        '429': async () => json(429, { error: 'slow down' }, { 'retry-after': '1' }),
        network: async () => Promise.reject(new TypeError('fetch failed')),
        'cut-off body': async () => brokenBody('{"organizationId":"'),
        '200 not JSON': async () => new Response('<html>gateway</html>', { status: 200 }),
        '200 {}': async () => json(200, {}),
        '200 another business': async () => json(200, { ...real, organizationId: orgs.harbor }),
        '200 features missing': async () => json(200, { ...real, features: undefined }),
        '403 edge page': async () => new Response('<html>Access denied</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
      };
      for (const [mode, answer] of Object.entries(modes)) {
        const scope = bound(`turn-${mode}`);
        expect(scopes.recheck(scope), `${mode}: live before`).toEqual({ live: true });
        intercept = (request) => (isAccess(request) ? answer() : null);
        await session.reload();
        intercept = null;
        const during = session.entitlement(orgs.juniper);
        expect(during, mode).toMatchObject({ agent: false, state: 'unknown' });
        expect(scopes.recheck(scope), `${mode}: during`).toEqual({ live: false, denial: 'account-service-unavailable' });
        await session.reload();
        expect(session.entitlement(orgs.juniper), `${mode}: recovered`).toMatchObject({ agent: true, state: 'active' });
        expect(scopes.recheck(scope), `${mode}: not final`).toEqual({ live: true });
      }
    },
    60_000,
  );

  test(
    'an affirmative answer still ends the scope for good: a withdrawn grant, and a membership the service lists as not active',
    async () => {
      // Withdrawn grant: the service answers `revoked`.
      const juniperOwner = await signedIn('owner@juniper.test');
      const juniper = observing(juniperOwner, orgs.juniper);
      const granted = juniper.bound('turn-grant');
      const billing = await tokenFor('billing@diomedes.test');
      const customer = await cloud.commercial.customer(billing, orgs.juniper);
      await cloud.commercial.revokeGrant(billing, orgs.juniper, customer.grants.find((item) => item.state === 'active')!.id, { reason: 'R3 repair.' });
      await juniperOwner.reload();
      expect(juniperOwner.entitlement(orgs.juniper)).toMatchObject({ agent: false, state: 'revoked' });
      expect(juniper.scopes.recheck(granted)).toEqual({ live: false, denial: 'entitlement-inactive' });

      // Membership withdrawn: Harbor is entitled, the Juniper owner is its admin, then removed.
      await cloud.commercial.issueGrant(billing, orgs.harbor, { planId: 'business', source: 'internal-test', reference: 'R3 repair', note: 'Fixture.' });
      const harborOwner = await tokenFor('owner@harbor.test');
      const code = await cloud.accounts.createInvitationCode(harborOwner, orgs.harbor, { role: 'admin', email: 'owner@juniper.test', ttlMs: 86_400_000 });
      await cloud.accounts.redeemInvitationCode(await tokenFor('owner@juniper.test'), code.code);
      await juniperOwner.reload();
      expect(juniperOwner.entitlement(orgs.harbor)).toMatchObject({ agent: true, state: 'active' });
      const harbor = observing(juniperOwner, orgs.harbor);
      const member = harbor.bound('turn-member');
      expect(harbor.scopes.recheck(member)).toEqual({ live: true });
      await cloud.accounts.setMembership(harborOwner, orgs.harbor, juniperOwner.personId()!, { role: 'admin', state: 'revoked' });
      await juniperOwner.reload();
      const after = juniperOwner.entitlement(orgs.harbor);
      // An answer, never `unknown`: either the service no longer lists Harbor, or lists it as not active.
      expect(after === null || (after.agent === false && after.state !== 'unknown'), JSON.stringify(after)).toBe(true);
      expect(harbor.scopes.recheck(member)).toEqual({ live: false, denial: 'entitlement-inactive' });

      // Final: once the service answers `active` again for both businesses, both scopes stay ended.
      await cloud.commercial.issueGrant(billing, orgs.juniper, { planId: 'business', source: 'internal-test', reference: 'R3 repair', note: 'Back.' });
      const again = await cloud.accounts.createInvitationCode(harborOwner, orgs.harbor, { role: 'admin', email: 'owner@juniper.test', ttlMs: 86_400_000 });
      await cloud.accounts.redeemInvitationCode(await tokenFor('owner@juniper.test'), again.code);
      await juniperOwner.reload();
      expect(juniperOwner.entitlement(orgs.juniper)).toMatchObject({ agent: true, state: 'active' });
      expect(juniperOwner.entitlement(orgs.harbor)).toMatchObject({ agent: true, state: 'active' });
      expect(juniper.scopes.recheck(granted)).toEqual({ live: false, denial: 'entitlement-inactive' });
      expect(harbor.scopes.recheck(member)).toEqual({ live: false, denial: 'entitlement-inactive' });
    },
    60_000,
  );
});

// =================================================================================================
// R3-2
// =================================================================================================

describe('R3-2 only the account service’s own membership refusal is `not_a_member`', () => {
  test('the host’s list is the service’s own sentences, each a 403 in the account service', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const source = await fs.readFile(path.join(root, 'services', 'control-plane', 'src', 'account-service.ts'), 'utf8');
    expect(MEMBERSHIP_REFUSALS.size).toBe(2);
    for (const sentence of MEMBERSHIP_REFUSALS) expect(source, sentence).toContain(`new AccountError(403, '${sentence}')`);
  });

  test('refusedMembership reads the status and the service’s body, never a bare status', () => {
    for (const sentence of MEMBERSHIP_REFUSALS) expect(refusedMembership(new ApiError(403, sentence)), sentence).toBe(true);
    expect(refusedMembership(new ApiError(403, 'Anything.', { code: 'not_a_member' }))).toBe(true);
    // The client's own sentence for a body that is not the service's JSON, and other refusals.
    expect(refusedMembership(new ApiError(403, 'The account service refused the request.'))).toBe(false);
    expect(refusedMembership(new ApiError(403, 'This origin is not allowed.'))).toBe(false);
    expect(refusedMembership(new ApiError(404, 'This account action was not found.'))).toBe(false);
    expect(refusedMembership(new ApiError(404, 'This Business workspace is unavailable to this person.'))).toBe(false);
    expect(refusedMembership(new Error('This Business workspace is unavailable to this person.'))).toBe(false);
  });

  test(
    'an admission answered by an edge page, a missing route or another 403 is the service not answering; its membership refusal is `not_a_member`',
    async () => {
      const session = await signedIn('owner@juniper.test');
      const admit = async (answer: (() => Response) | null) => {
        intercept = answer ? (request) => (isAdmission(request) ? Promise.resolve(answer()) : null) : null;
        try {
          return await session.admitAgent({ organizationId: orgs.juniper, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-1', phase: 'admit' });
        } finally {
          intercept = null;
        }
      };
      const unknown: Record<string, () => Response> = {
        '404 unknown action': () => json(404, { error: 'This account action was not found.' }),
        '404 HTML': () => new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
        '403 edge page': () => new Response('<html><body>Access denied</body></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
        '403 origin': () => json(403, { error: 'This origin is not allowed.' }),
        '403 empty': () => new Response(null, { status: 403 }),
      };
      for (const [mode, answer] of Object.entries(unknown)) expect(await admit(answer), mode).toMatchObject({ admitted: false, code: 'entitlement_unknown' });
      const member: Record<string, () => Response> = {
        'workspace unavailable': () => json(403, { error: 'This Business workspace is unavailable to this person.' }),
        'membership not established': () => json(403, { error: 'Current membership could not be established.' }),
        'coded refusal': () => json(403, { error: 'Not a member.', code: 'not_a_member' }),
      };
      for (const [mode, answer] of Object.entries(member)) expect(await admit(answer), mode).toMatchObject({ admitted: false, code: 'not_a_member' });
      expect(await admit(null), 'control: the service admits').toMatchObject({ admitted: true });

      // Through the gate: only the membership refusal ends observation.
      const gate = new AccountAgentGate(session, { projectOwner: () => null, active: () => ({ kind: 'business', organizationId: orgs.juniper }) } as never);
      const thrown = async (answer: () => Response) => {
        intercept = (request) => (isAdmission(request) ? Promise.resolve(answer()) : null);
        try {
          return await gate.check({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'job-2' }).then(
            () => null,
            (error: unknown) => error,
          );
        } finally {
          intercept = null;
        }
      };
      expect(refusalEndsObservation(await thrown(unknown['404 unknown action']))).toBe(false);
      expect(refusalEndsObservation(await thrown(unknown['403 edge page']))).toBe(false);
      expect(refusalEndsObservation(await thrown(member['workspace unavailable']))).toBe(true);
    },
    60_000,
  );

  test(
    'positive control: the service’s real refusal of a withdrawn member is `not_a_member`',
    async () => {
      const billing = await tokenFor('billing@diomedes.test');
      await cloud.commercial.issueGrant(billing, orgs.harbor, { planId: 'business', source: 'internal-test', reference: 'R3 repair', note: 'Fixture.' });
      const harborOwner = await tokenFor('owner@harbor.test');
      const code = await cloud.accounts.createInvitationCode(harborOwner, orgs.harbor, { role: 'admin', email: 'owner@juniper.test', ttlMs: 86_400_000 });
      await cloud.accounts.redeemInvitationCode(await tokenFor('owner@juniper.test'), code.code);
      const session = await signedIn('owner@juniper.test');
      const ask = () => session.admitAgent({ organizationId: orgs.harbor, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-h', phase: 'admit' });
      expect(await ask()).toMatchObject({ admitted: true });
      await cloud.accounts.setMembership(harborOwner, orgs.harbor, session.personId()!, { role: 'admin', state: 'revoked' });
      expect(await ask()).toMatchObject({ admitted: false, code: 'not_a_member' });
    },
    60_000,
  );
});

// =================================================================================================
// R3-3
// =================================================================================================

describe('R3-3 a scope is measured from the ask, before the round trip', () => {
  const setup = () => {
    let active: string | null = 'org_a';
    const scopes = new ObservationScopes({
      operator: operator(['org_a', 'org_b']),
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => active, entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => 1_000,
    });
    return { scopes, switchTo: (organizationId: string | null) => ((active = organizationId), scopes.observeContext()) };
  };
  const bindWith = (scopes: ObservationScopes, ask: ReturnType<ObservationScopes['ask']> | undefined, organizationId = 'org_a', job = 'turn-1') => {
    const decision = scopes.decide({ admission: admission(organizationId, `adm_${job}`), rootJobId: job, route: 'aws-bedrock', connectionId: 'c1', model: null, ask });
    if (!decision.eligible) throw new Error(decision.denial);
    return decision.scope;
  };

  test('a switch while the account service answers ends the admitted business’s scope, even once undone; its baseline is the business asked about', () => {
    const { scopes, switchTo } = setup();
    const ask = scopes.ask(null);
    expect(ask).toMatchObject({ organizationId: 'org_a', activeOrganizationId: 'org_a' });
    switchTo('org_b'); // lands while the admission is on the wire
    const scope = bindWith(scopes, ask);
    expect(scope.organizationId).toBe('org_a');
    expect(scope.activeOrganizationAtBind).toBe('org_a');
    expect(scopes.recheck(scope)).toEqual({ live: false, denial: 'workspace-changed' });
    switchTo('org_a');
    expect(scopes.recheck(scope)).toEqual({ live: false, denial: 'workspace-changed' });
  });

  test('control: no switch while it answers, the scope is live; a switch before the ask is the baseline, not a change', () => {
    const { scopes, switchTo } = setup();
    expect(scopes.recheck(bindWith(scopes, scopes.ask(null), 'org_a', 'turn-1'))).toEqual({ live: true });
    switchTo('org_b');
    const ask = scopes.ask(null);
    const scope = bindWith(scopes, ask, 'org_b', 'turn-2');
    expect(scope.activeOrganizationAtBind).toBe('org_b');
    expect(scopes.recheck(scope)).toEqual({ live: true });
  });

  test('an admission for another business than the one asked about binds nothing', () => {
    const { scopes } = setup();
    const ask = scopes.ask(null);
    const decision = scopes.decide({ admission: admission('org_b', 'adm_x'), rootJobId: 'turn-x', route: 'aws-bedrock', connectionId: 'c1', model: null, ask });
    expect(decision).toEqual({ eligible: false, denial: 'workspace-changed' });
    expect(scopes.size).toBe(0);
  });
});

// =================================================================================================
// R3-4
// =================================================================================================

describe('R3-4 the scope map never forgets a live run’s scope, and counts what it forgets', () => {
  let seq = 0;
  const event = (runId: string, type: string, at: number, stepId?: string, attempt?: number): HarnessEvent => ({
    v: 1,
    seq: ++seq,
    runId,
    at: new Date(Date.UTC(2026, 8, 26, 12) + at).toISOString(),
    type,
    ...(stepId === undefined ? {} : { stepId }),
    ...(attempt === undefined ? {} : { attempt }),
    attributes: {},
  });
  const modelStep = (stepId: string, state: 'running' | 'succeeded'): StepRecord =>
    ({
      intent: { stepId, stepVersion: '1', kind: 'model', effect: 'read', name: 'model-api', input: { request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] } } },
      intentHash: 'h',
      attempt: 1,
      state,
      output: state === 'succeeded' ? { response: { type: 'final', text: 'x' } } : null,
      leaseFence: 1,
      startedAt: null,
      endedAt: null,
      error: null,
    }) as unknown as StepRecord;
  const loopRun = (id: string, state: 'running' | 'completed'): HarnessRun => {
    const events =
      state === 'running'
        ? [event(id, 'run.created', 1), event(id, 'step.started', 2, 'model:0', 1)]
        : [event(id, 'run.created', 1), event(id, 'step.started', 2, 'model:0', 1), event(id, 'step.succeeded', 3, 'model:0', 1), event(id, 'run.completed', 4)];
    return {
      v: 1,
      id,
      tenantId: 't',
      projectId: 'p',
      taskId: null,
      sessionId: null,
      capabilityId: 'diomedes-loop',
      capabilityVersion: '1',
      capabilityTools: [],
      policyVersion: '1',
      principal: {},
      input: {},
      state,
      budget: {},
      used: {},
      owner: null,
      fence: 1,
      leaseExpiresAt: null,
      parentRunId: null,
      forkPoint: null,
      contextRevision: 0,
      transcripts: {},
      result: null,
      failure: null,
      cancelReason: null,
      createdAt: new Date(Date.UTC(2026, 8, 26, 12)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 8, 26, 12) + 4).toISOString(),
      steps: [modelStep('model:0', state === 'running' ? 'running' : 'succeeded')],
      approvals: [],
      lastSeq: events.at(-1)!.seq,
      events,
    } as unknown as HarnessRun;
  };
  const turn = (id: string) => ({ id, capabilityId: 'model-api-turn', input: { conversationRunId: 'lineage-1' }, state: 'completed', events: [], steps: [], lastSeq: 0, sessionId: null }) as unknown as HarnessRun;
  const setup = (limit?: number) => {
    const scopes = new ObservationScopes({
      operator: operator(['org_a']),
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => Date.UTC(2026, 8, 26, 12),
      limit,
    });
    const seen: Observation[] = [];
    const projector = new ObservationProjector({
      scopes,
      exporter: { enqueue: (item: Observation) => void seen.push(item), flush: async () => {}, discard: () => 0, health: () => ({}) as never, close: async () => {} },
      build: '0.2.0',
    });
    const bind = (surface: AdmittedAgentWork['surface'], job: string) =>
      scopes.decide({ admission: admission('org_a', `adm_${job}`, surface), rootJobId: job, route: 'aws-bedrock', connectionId: 'c1', model: null });
    return { scopes, projector, seen, bind };
  };

  test('a running loop, saved once, survives 2,000 later messages at the production limit, and its trace is projected when it ends', () => {
    seq = 0;
    const { scopes, projector, seen, bind } = setup();
    bind('loop', 'loop-L');
    projector.onRunSaved(loopRun('loop-L', 'running'));
    for (let i = 0; i < 2_000; i += 1) bind('conversation', `lineage-1.t${i}`);
    expect(scopes.size).toBe(2_000);
    projector.onRunSaved(loopRun('loop-L', 'completed'));
    expect(seen.filter((item) => item.kind === 'trace')).toHaveLength(1);
    // The one forgotten was the oldest message no run had claimed, and that is counted.
    expect(scopes.resolve(turn('lineage-1.t0'))).toBeNull();
    expect(scopes.denials()['scope-evicted']).toBe(1);
  });

  test('when every scope is claimed by a live run, none is forgotten: the map holds more than its bound', () => {
    seq = 0;
    const { scopes, projector, bind } = setup(2);
    for (const id of ['loop-a', 'loop-b', 'loop-c']) {
      bind('loop', id);
      projector.onRunSaved(loopRun(id, 'running'));
    }
    expect(scopes.size).toBe(3);
    for (const id of ['loop-a', 'loop-b', 'loop-c']) expect(scopes.resolve(loopRun(id, 'running')), id).not.toBeNull();
    expect(scopes.denials()['scope-evicted'] ?? 0).toBe(0);
  });

  test('ended scopes go first, uncounted; then the oldest unclaimed, counted; a run saved after its scope was forgotten is counted once as lost', () => {
    seq = 0;
    const { scopes, projector, bind } = setup(2);
    bind('loop', 'loop-a');
    projector.onRunSaved(loopRun('loop-a', 'running'));
    bind('loop', 'loop-b');
    projector.onRunSaved(loopRun('loop-b', 'completed')); // ended
    bind('loop', 'loop-c'); // over the bound: loop-b, ended, goes; loop-a is live
    expect(scopes.resolve(loopRun('loop-a', 'running'))).not.toBeNull();
    expect(scopes.resolve(loopRun('loop-b', 'completed'))).toBeNull();
    expect(scopes.denials()['scope-evicted'] ?? 0).toBe(0);
    bind('loop', 'loop-d'); // loop-c was never claimed: it goes, counted
    expect(scopes.denials()['scope-evicted']).toBe(1);
    expect(scopes.resolve(loopRun('loop-a', 'running'))).not.toBeNull();
    expect(scopes.resolve(loopRun('loop-d', 'running'))).not.toBeNull();

    // loop-c's run starts after all: it is lost, and counted once however often it is saved.
    projector.onRunSaved(loopRun('loop-c', 'running'));
    projector.onRunSaved(loopRun('loop-c', 'completed'));
    // A run that was never scoped is not observed, and is not a loss.
    projector.onRunSaved(loopRun('loop-never', 'completed'));
    expect(projector.stats()).toMatchObject({ scopeEvicted: 1, failures: 0 });

    // Rebinding a forgotten key (a loop resuming) makes it observable again.
    bind('loop', 'loop-c');
    expect(scopes.resolve(loopRun('loop-c', 'running'))).not.toBeNull();
  });

  test('a loop child that took its root’s scope never ends the root’s', () => {
    seq = 0;
    const { scopes, projector, bind } = setup(1);
    bind('loop', 'loop-root');
    projector.onRunSaved(loopRun('loop-root', 'running'));
    const child = { ...loopRun('child-1', 'completed'), capabilityId: 'diomedes-loop-delegate', input: { parent: { runId: 'loop-root', stepId: 'tool:1' }, rootRunId: 'loop-root' } } as HarnessRun;
    projector.onRunSaved(child);
    bind('conversation', 'lineage-1.t0'); // over the bound: the root is still live, so the new one stays too
    expect(scopes.resolve(loopRun('loop-root', 'running'))).not.toBeNull();
    expect(scopes.size).toBe(2);
  });
});
