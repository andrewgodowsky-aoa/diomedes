/**
 * The desktop reads the account service's `not_a_member` code.
 *
 * The service now sends `code: 'not_a_member'` with its membership 403s
 * (services/control-plane/tests/membership-refusal-code.test.ts). The host reads the code first, on
 * the Agent admission and on the access read, and falls back to the service's two sentences for an
 * older service that sends none. Any other 403 or 404 is still the service not answering: an
 * admission is `entitlement_unknown` and the business's access is `unknown`, never final (PH-07
 * R3-1, R3-2).
 *
 * The account service is the faux service in this process, reached through a fetcher the test may
 * intercept. Nothing here leaves the process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountBackend } from '../server/accounts/backend.js';
import { ControlPlaneClient, ControlPlaneError } from '../server/accounts/client.js';
import { AccountSessionService, refusedMembership } from '../server/accounts/session.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let dir: string;
let intercept: ((request: Request) => Promise<Response> | null) | null;

const pathOf = (request: Request) => new URL(request.url).pathname;
const isAccess = (request: Request) => request.method === 'GET' && /^\/account\/organizations\/[^/]+\/access$/.test(pathOf(request));
const isAdmission = (request: Request) => request.method === 'POST' && pathOf(request).endsWith('/agent-admissions');
const isSession = (request: Request) => request.method === 'GET' && pathOf(request) === '/account/session';
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

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
/** Remove the Juniper employee, as the owner does from the Console. */
async function removeEmployee(personId: string) {
  await cloud.accounts.setMembership(await tokenFor('owner@juniper.test'), orgs.juniper, personId, { role: 'member', state: 'revoked' });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-not-a-member-'));
  intercept = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
});
afterEach(async () => {
  intercept = null;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the Agent admission reads the code', () => {
  test('a removed member: the real service’s coded 403 is `not_a_member`', async () => {
    const session = await signedIn('employee@juniper.test');
    const admit = () => session.admitAgent({ organizationId: orgs.juniper, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-1', phase: 'admit' });
    expect(await admit()).toMatchObject({ admitted: true });
    let body: unknown = null;
    intercept = (request) =>
      isAdmission(request)
        ? cloud.handle(request).then(async (response) => {
            body = await response.clone().json();
            return response;
          })
        : null;
    await removeEmployee(session.personId()!);
    expect(await admit()).toMatchObject({ admitted: false, code: 'not_a_member' });
    expect(body, 'the service named it').toMatchObject({ code: 'not_a_member' });
  });

  test('the code is read, whatever the sentence says', async () => {
    const session = await signedIn('owner@juniper.test');
    intercept = (request) => (isAdmission(request) ? Promise.resolve(json(403, { error: 'You can’t use this business.', code: 'not_a_member' })) : null);
    expect(await session.admitAgent({ organizationId: orgs.juniper, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-1', phase: 'admit' })).toMatchObject({
      admitted: false,
      code: 'not_a_member',
    });
  });

  test('an older service that sends no code: its sentences still read as `not_a_member`; any other 403 does not', async () => {
    const session = await signedIn('owner@juniper.test');
    const admit = async (answer: () => Response) => {
      intercept = (request) => (isAdmission(request) ? Promise.resolve(answer()) : null);
      try {
        return await session.admitAgent({ organizationId: orgs.juniper, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-1', phase: 'admit' });
      } finally {
        intercept = null;
      }
    };
    expect(await admit(() => json(403, { error: 'This Business workspace is unavailable to this person.' }))).toMatchObject({ code: 'not_a_member' });
    expect(await admit(() => json(403, { error: 'Current membership could not be established.' }))).toMatchObject({ code: 'not_a_member' });
    expect(await admit(() => json(403, { error: 'This origin is not allowed.' }))).toMatchObject({ code: 'entitlement_unknown' });
    expect(await admit(() => json(404, { error: 'Not a member.', code: 'not_a_member' })), 'a 404 is never a membership refusal').toMatchObject({
      code: 'entitlement_unknown',
    });
  });
});

describe('the access read reads the code', () => {
  test('refusedMembership reads the client’s error the same way it reads the host’s', () => {
    expect(refusedMembership(new ControlPlaneError('Anything.', 403, 'not_a_member'))).toBe(true);
    expect(refusedMembership(new ControlPlaneError('This Business workspace is unavailable to this person.', 403, null))).toBe(true);
    expect(refusedMembership(new ControlPlaneError('Current membership could not be established.', 403, null))).toBe(true);
    expect(refusedMembership(new ControlPlaneError('The account service refused the request.', 403, null))).toBe(false);
    expect(refusedMembership(new ControlPlaneError('Anything.', 404, 'not_a_member'))).toBe(false);
    expect(refusedMembership(new ControlPlaneError('The account service could not be reached.', 503, 'unreachable'))).toBe(false);
  });

  test('a member removed between the session read and the access read: the business reads as not a member, not unknown', async () => {
    const session = await signedIn('employee@juniper.test');
    expect(session.entitlement(orgs.juniper)).toMatchObject({ agent: true, state: 'active' });
    // The session page as it was before the removal, so the access read is the one that meets it.
    const before = await cloud.handle(new Request('http://faux.local/account/session', { headers: { authorization: `Bearer ${await tokenFor('employee@juniper.test')}` } })).then(
      (response) => response.text(),
    );
    await removeEmployee(session.personId()!);
    intercept = (request) => (isSession(request) ? Promise.resolve(new Response(before, { status: 200, headers: { 'content-type': 'application/json' } })) : null);
    await session.reload();
    intercept = null;
    expect(session.entitlement(orgs.juniper)).toMatchObject({
      agent: false,
      state: 'none',
      source: 'account-service',
      reason: 'You are no longer a member of this business, so nothing that needs its plan can start.',
    });
    expect(session.includes(orgs.juniper)).toBe(false);
    // The next reload reads the membership itself as ended: no longer listed, or listed as not active.
    await session.reload();
    const after = session.entitlement(orgs.juniper);
    expect(after === null || (after.agent === false && after.state !== 'unknown'), JSON.stringify(after)).toBe(true);
  });

  test('each answer on the access read, with the service’s code, its sentence, or neither', async () => {
    const session = await signedIn('owner@juniper.test');
    const read = async (answer: () => Response) => {
      intercept = (request) => (isAccess(request) ? Promise.resolve(answer()) : null);
      await session.reload();
      intercept = null;
      return session.entitlement(orgs.juniper);
    };
    const notMember = { agent: false, state: 'none', reason: 'You are no longer a member of this business, so nothing that needs its plan can start.' };
    expect(await read(() => json(403, { error: 'Anything.', code: 'not_a_member' })), 'coded').toMatchObject(notMember);
    expect(await read(() => json(403, { error: 'This Business workspace is unavailable to this person.' })), 'an older service').toMatchObject(notMember);
    expect(await read(() => json(403, { error: 'This origin is not allowed.' })), 'another 403').toMatchObject({ agent: false, state: 'unknown' });
    expect(await read(() => new Response('<html>Access denied</html>', { status: 403 })), 'an edge page').toMatchObject({ state: 'unknown' });
    expect(await read(() => json(404, { error: 'Anything.', code: 'not_a_member' })), 'a 404').toMatchObject({ state: 'unknown' });
    expect(await read(() => json(503, { error: 'upstream unavailable' })), 'an outage').toMatchObject({ state: 'unknown' });
    // Nothing above is kept once the service answers.
    await session.reload();
    expect(session.entitlement(orgs.juniper)).toMatchObject({ agent: true, state: 'active' });
  });
});
