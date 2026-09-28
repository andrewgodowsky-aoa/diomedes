import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AccountBackend } from '../server/accounts/backend.js';
import { checkBrowserToken, type BrowserIdentity, type BrowserSession } from '../server/accounts/browser-identity.js';
import { ControlPlaneClient, type AgentAdmissionAnswer } from '../server/accounts/client.js';
import { AccountSessionService, type AccountProjection } from '../server/accounts/session.js';
import { createFauxCloud, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, seedDemo, type DemoAccount } from '../services/control-plane/src/faux/seed.js';
import { WORKOS_ISSUER } from '../services/control-plane/src/faux/workos-standin.js';
import type { PersonAccessView } from '../shared/individual-plan.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let dir: string;
let cloud: FauxCloud;
let session: AccountSessionService;
let clock: number;
let juniper: string;
let kept: BrowserSession | null;
let projections: (AccountProjection | null)[];
let requests: { method: string; pathname: string; bearer: string | null }[];
let intercept: ((request: Request) => Promise<Response> | null) | null;

const pathOf = (request: Request) => new URL(request.url).pathname;
const isAdmission = (request: Request) => request.method === 'POST' && pathOf(request).endsWith('/agent-admissions');
const admissionRequests = () => requests.filter((request) => request.method === 'POST' && request.pathname.endsWith('/agent-admissions'));
const settled = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
const expectedBrowser = () => ({
  clientId: cloud.standIn!.clientId,
  issuers: [WORKOS_ISSUER, `${WORKOS_ISSUER}/user_management/${cloud.standIn!.clientId}`],
  audience: cloud.standIn!.audience,
});

async function tokenFor(who: DemoAccount) {
  return (await cloud.standIn!.signInDirect(DEMO_ACCOUNTS[who].email)).access_token;
}

async function issueIndividual(who: DemoAccount) {
  const personId = (await cloud.accounts.signIn(await tokenFor(who))).person.id;
  const staffToken = await tokenFor('staffBilling');
  const { grant } = await cloud.commercial.issuePersonGrant(staffToken, personId, {
    planId: 'individual', source: 'subscription', reference: 'personal-security-fixture', note: '',
  });
  return { personId, staffToken, grant };
}

/** A fresh native sign-in after explicit sign-out, including a different real stand-in SID. */
async function signInAs(who: DemoAccount) {
  expect(session.signedIn(), 'this helper starts a new sign-in, never a token renewal').toBe(false);
  const reply = await cloud.standIn!.signInDirect(DEMO_ACCOUNTS[who].email);
  kept = { accessToken: reply.access_token, user: { id: reply.user.id, email: reply.user.email, name: DEMO_ACCOUNTS[who].name } };
  const state = await session.signInWithBrowser();
  expect(state.signedIn).toBe(true);
  const token = await session.token();
  expect(token).toBe(kept.accessToken);
  const claims = checkBrowserToken(token, expectedBrowser(), clock);
  expect(claims).not.toBeNull();
  return { state, token, claims: claims! };
}

/** Hold the real service's next Personal access response, after it has read the old grant. */
function holdNextPersonAccess() {
  const entered = deferred<{ status: number; body: PersonAccessView; bearer: string | null }>();
  const resume = deferred<void>();
  let calls = 0;
  intercept = (request) => {
    if (request.method !== 'GET' || pathOf(request) !== '/account/access') return null;
    intercept = null;
    calls++;
    return cloud.handle(request).then(async (response) => {
      entered.resolve({ status: response.status, body: await response.clone().json() as PersonAccessView, bearer: request.headers.get('authorization') });
      await resume.promise;
      return response;
    });
  };
  return { entered, resume, calls: () => calls };
}

/** Change only the pins on an otherwise genuine, successful account-service admission. */
function changeAdmissionPins(change: (pins: AgentAdmissionAnswer['pins']) => AgentAdmissionAnswer['pins']) {
  const originals: { status: number; answer: AgentAdmissionAnswer }[] = [];
  intercept = (request) => {
    if (!isAdmission(request)) return null;
    return cloud.handle(request).then(async (response) => {
      const answer = await response.json() as AgentAdmissionAnswer;
      originals.push({ status: response.status, answer });
      return Response.json({ ...answer, pins: change(answer.pins) });
    });
  };
  // Assertions belong outside the intercepted request: the session deliberately catches failures.
  return originals;
}

const admit = (organizationId: string | null, phase: 'admit' | 'dispatch' = 'admit') => session.admitAgent({
  organizationId, phase, surface: 'conversation', routeKind: 'byo', rootJobId: 'personal-security-job',
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-personal-security-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Personal security fixtures must stay in process.'); }));
  clock = Date.now();
  cloud = await createFauxCloud({ file: null, identity: 'workos-standin', now: () => clock });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  kept = null;
  projections = [];
  requests = [];
  intercept = null;
  const listeners = new Set<() => void>();
  const identity: BrowserIdentity = {
    async begin() {},
    async session() { return kept; },
    async signOut() { kept = null; for (const listener of listeners) listener(); },
    status: () => ({ status: kept ? 'signed-in' : 'signed-out', message: '' }),
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const backend: AccountBackend = {
    client: new ControlPlaneClient('https://accounts.example.test', (request) => {
      requests.push({ method: request.method, pathname: pathOf(request), bearer: request.headers.get('authorization') });
      return intercept?.(request) ?? cloud.handle(request);
    }),
    view: () => ({ kind: 'cloud', label: 'Offline Personal access fixture', url: 'https://accounts.example.test', reason: null, signIn: 'browser' }),
    close: async () => {},
  };
  session = new AccountSessionService(backend, dir, null, () => clock, { identity, expect: expectedBrowser() });
  session.onProjection(async (projection) => { projections.push(projection); });
  await session.init();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a delayed Personal access refresh belongs to its initiating sign-in', () => {
  test.each(['same person', 'another person'] as const)('refuses after a new native sign-in by the %s replaces it', async (replacement) => {
    const originalGrant = await issueIndividual('free');
    const original = await signInAs('free');
    expect(session.personalIncludes()).toBe(true);
    const held = holdNextPersonAccess();
    const pending = settled(session.reload());
    let next: Awaited<ReturnType<typeof signInAs>>;
    let projected: (AccountProjection | null)[];
    try {
      // A premature completion is a fixture failure, not evidence that this interleaving was reached.
      const boundary = await Promise.race([
        held.entered.promise.then((response) => ({ kind: 'held' as const, response })),
        pending.then(() => ({ kind: 'finished' as const })),
      ]);
      expect(boundary.kind).toBe('held');
      if (boundary.kind !== 'held') throw new Error('Reload finished before the Personal response was held.');
      expect(boundary.response).toMatchObject({ status: 200, bearer: `Bearer ${original.token}`, body: { personId: originalGrant.personId, agent: { included: true } } });
      expect(held.calls()).toBe(1);
      await session.signOut();
      await cloud.commercial.revokePersonGrant(originalGrant.staffToken, originalGrant.personId, originalGrant.grant.id, { reason: 'Withdraw old fixture access.' });
      next = await signInAs(replacement === 'same person' ? 'free' : 'harborOwner');
      expect(next.claims.sessionId).not.toBe(original.claims.sessionId);
      expect(next.token).not.toBe(original.token);
      if (replacement === 'same person') expect(next.state.person!.id).toBe(original.state.person!.id);
      else expect(next.state.person!.id).not.toBe(original.state.person!.id);
      expect(session.personalIncludes()).toBe(false);
      expect(session.personalUnknown()).toBe(false);
      projected = [...projections];
    } finally {
      held.resume.resolve();
      await pending;
    }
    expect(await pending).toMatchObject({ error: { status: 401, details: { code: 'sign_in_required' } } });
    expect(session.state().person?.id).toBe(next.state.person!.id);
    expect(await session.token()).toBe(next.token);
    expect(session.personalIncludes()).toBe(false);
    expect(session.personalUnknown()).toBe(false);
    expect(projections).toEqual(projected);
  });

  test('applies a delayed reply and projects exactly once when the sign-in is unchanged', async () => {
    const original = await signInAs('free');
    expect(session.personalIncludes()).toBe(false);
    const grant = await issueIndividual('free');
    const held = holdNextPersonAccess();
    const projected = [...projections];
    const pending = settled(session.reload());
    try {
      const boundary = await Promise.race([
        held.entered.promise.then((response) => ({ kind: 'held' as const, response })),
        pending.then(() => ({ kind: 'finished' as const })),
      ]);
      expect(boundary.kind).toBe('held');
      if (boundary.kind !== 'held') throw new Error('Reload finished before the Personal response was held.');
      expect(boundary.response).toMatchObject({ status: 200, bearer: `Bearer ${original.token}`, body: { personId: grant.personId, agent: { included: true } } });
      expect(held.calls()).toBe(1);
      expect(session.personalIncludes()).toBe(false);
      expect(projections).toEqual(projected);
    } finally {
      held.resume.resolve();
      await pending;
    }
    const outcome = await pending;
    expect(outcome).toMatchObject({ value: { reason: 'refresh', person: { id: original.state.person!.id } } });
    expect(session.personalIncludes()).toBe(true);
    expect(session.personalUnknown()).toBe(false);
    expect(await session.token()).toBe(original.token);
    expect(projections).toHaveLength(projected.length + 1);
    expect(projections.at(-1)).toMatchObject({ reason: 'refresh', person: { id: original.state.person!.id } });
  });
});

describe('Personal admissions are pinned to the initiating person and scope', () => {
  test('refuses another person in valid Personal pins and asks again instead of caching it', async () => {
    const ownGrant = await issueIndividual('free');
    await signInAs('free');
    const otherId = (await cloud.accounts.signIn(await tokenFor('harborOwner'))).person.id;
    expect(otherId).not.toBe(ownGrant.personId);
    const originals = changeAdmissionPins((pins) => ({ ...pins, personId: otherId }));
    const first = await admit(null);
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({ status: 200, answer: { decision: { admitted: true }, pins: { organizationId: null, personId: ownGrant.personId } } });
    expect(first).toMatchObject({ admitted: false, code: 'entitlement_unknown' });
    expect(admissionRequests()).toHaveLength(1);
    await expect(admit(null, 'dispatch')).resolves.toMatchObject({ admitted: false, code: 'entitlement_unknown' });
    expect(admissionRequests()).toHaveLength(2);
    expect(originals).toHaveLength(2);
    expect(originals[1]).toMatchObject({ status: 200, answer: { decision: { admitted: true }, pins: { organizationId: null, personId: ownGrant.personId } } });
    intercept = null;
    await expect(admit(null, 'dispatch')).resolves.toMatchObject({ admitted: true, organizationId: null, personId: ownGrant.personId });
    expect(admissionRequests()).toHaveLength(3);
  });

  test('accepts its own Personal admission and reuses that decision for a fresh same-work dispatch', async () => {
    const ownGrant = await issueIndividual('free');
    await signInAs('free');
    const decision = await admit(null);
    expect(decision).toMatchObject({ admitted: true, organizationId: null, personId: ownGrant.personId, planId: 'individual' });
    expect(admissionRequests().map((request) => request.pathname)).toEqual(['/account/agent-admissions']);
    expect(await admit(null, 'dispatch')).toEqual(decision);
    expect(admissionRequests()).toHaveLength(1);
  });

  test.each(['Personal', 'business'] as const)('refuses and does not cache the other scope for %s work', async (scope) => {
    if (scope === 'Personal') await issueIndividual('free');
    const own = await signInAs(scope === 'Personal' ? 'free' : 'owner');
    const organizationId = scope === 'Personal' ? null : juniper;
    const originals = changeAdmissionPins((pins) => ({ ...pins, organizationId: scope === 'Personal' ? juniper : null }));
    const first = await admit(organizationId);
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({ status: 200, answer: { decision: { admitted: true }, pins: { organizationId, personId: own.state.person!.id } } });
    expect(first).toMatchObject({ admitted: false, code: 'entitlement_unknown' });
    expect(admissionRequests()).toHaveLength(1);
    await expect(admit(organizationId, 'dispatch')).resolves.toMatchObject({ admitted: false, code: 'entitlement_unknown' });
    expect(admissionRequests()).toHaveLength(2);
    expect(originals).toHaveLength(2);
    expect(originals[1]).toMatchObject({ status: 200, answer: { decision: { admitted: true }, pins: { organizationId, personId: own.state.person!.id } } });
    intercept = null;
    await expect(admit(organizationId, 'dispatch')).resolves.toMatchObject({ admitted: true, organizationId, personId: own.state.person!.id });
    expect(admissionRequests()).toHaveLength(3);
  });
});
