/**
 * An Agent admission answer the host cannot read is a refusal, never a crash.
 *
 * `AccountSessionService.admitAgent` reads the account service's answer to
 * `POST /account/organizations/:id/agent-admissions`. A malformed answer (no decision, an admission
 * without its id or pins, a decision that is not a yes or a no, a `validUntil` that is not a time)
 * used to throw a TypeError or a RangeError out of the gate. Each is now `entitlement_unknown`, is
 * never cached, and the next piece of work asks again. A well-formed admission is still cached for
 * at most 60 seconds.
 *
 * The account service is the faux service in this process; the admission answers are written by the
 * test. Nothing here leaves the process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountBackend } from '../server/accounts/backend.js';
import { AccountAgentGate } from '../server/accounts/agent-gate.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import { AccountSessionService } from '../server/accounts/session.js';
import { EngineError } from '../server/engines/process.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { FAUX_DEMO_PASSWORD, seedDemo } from '../services/control-plane/src/faux/seed.js';

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let dir: string;
let clock: number;
let answer: (() => Response) | null;
let asked: number;

const pathOf = (request: Request) => new URL(request.url).pathname;
const isAdmission = (request: Request) => request.method === 'POST' && pathOf(request).endsWith('/agent-admissions');
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** A well-formed admission for Juniper, good until `validUntil`. */
const admitted = (validUntil: string, overrides: Record<string, unknown> = {}) => ({
  admissionId: 'agent_admission_00000000-0000-4000-8000-000000000001',
  decision: { admitted: true, planId: 'business', revision: 1, validUntil: null },
  pins: { organizationId: orgs.juniper, tenantId: 't', personId: 'person_1', planId: 'business', accessRevision: 1, policyRevision: 3, rootJobId: 'job-1' },
  validUntil,
  ...overrides,
});
const inAMinute = () => new Date(clock + 60_000).toISOString();

async function signedIn() {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', async (request) => {
      if (isAdmission(request)) {
        asked++;
        if (answer) return answer();
      }
      return cloud.handle(request);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, dir, null, () => clock);
  await session.init();
  await session.signIn({ email: 'owner@juniper.test', password: FAUX_DEMO_PASSWORD, remember: false });
  return session;
}
const admit = (session: AccountSessionService, phase: 'admit' | 'dispatch' = 'admit') =>
  session.admitAgent({ organizationId: orgs.juniper, surface: 'conversation', routeKind: 'byo', rootJobId: 'job-1', phase });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-admission-answer-'));
  clock = Date.now();
  answer = null;
  asked = 0;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
});
afterEach(async () => {
  answer = null;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a malformed admission answer is a refusal', () => {
  const malformed: Record<string, () => Response> = {
    '200 {}': () => json(200, {}),
    '200 not JSON': () => new Response('<html>gateway</html>', { status: 200 }),
    '200 null': () => json(200, null),
    'no decision': () => json(200, { ...admitted(inAMinute()), decision: undefined }),
    'decision.admitted is a string': () => json(200, admitted(inAMinute(), { decision: { admitted: 'true' } })),
    'decision.admitted is a number': () => json(200, admitted(inAMinute(), { decision: { admitted: 1 } })),
    'admitted without admissionId': () => json(200, { ...admitted(inAMinute()), admissionId: undefined }),
    'admitted with an empty admissionId': () => json(200, admitted(inAMinute(), { admissionId: '' })),
    'admitted without pins': () => json(200, { ...admitted(inAMinute()), pins: undefined }),
    'admitted with pins missing personId': () =>
      json(200, admitted(inAMinute(), { pins: { organizationId: orgs.juniper, planId: 'business', policyRevision: 3 } })),
    'admitted with a policyRevision that is not a number': () =>
      json(200, admitted(inAMinute(), { pins: { organizationId: orgs.juniper, personId: 'person_1', planId: 'business', policyRevision: '3' } })),
    'validUntil is not a time': () => json(200, admitted('soon')),
    'validUntil is missing': () => json(200, { ...admitted(inAMinute()), validUntil: undefined }),
    'validUntil is a number': () => json(200, admitted(inAMinute(), { validUntil: clock + 60_000 })),
    'admitted for another business': () =>
      json(200, admitted(inAMinute(), { pins: { organizationId: orgs.harbor, personId: 'person_1', planId: 'business', policyRevision: 3 } })),
    'refused without a reason': () => json(200, { ...admitted(inAMinute()), decision: { admitted: false, code: 'agent_not_included' } }),
    'refused without a code': () => json(200, { ...admitted(inAMinute()), decision: { admitted: false, reason: 'No.' } }),
  };

  test.each(Object.keys(malformed))('%s: entitlement_unknown, not a throw, and never cached', async (mode) => {
    const session = await signedIn();
    answer = malformed[mode];
    await expect(admit(session)).resolves.toEqual({
      admitted: false,
      code: 'entitlement_unknown',
      reason:
        'The account service answered in a way this app could not read, so the Nectovia Agent could not confirm this business includes it. Nothing was sent.',
    });
    // Not cached: a dispatch for the same work asks the service again, and gets the same refusal.
    expect(asked).toBe(1);
    await expect(admit(session, 'dispatch')).resolves.toMatchObject({ admitted: false, code: 'entitlement_unknown' });
    expect(asked).toBe(2);
    // Once the service answers properly, the same work is admitted.
    answer = null;
    await expect(admit(session, 'dispatch')).resolves.toMatchObject({ admitted: true, organizationId: orgs.juniper });
    expect(asked).toBe(3);
  });

  test('a malformed answer replaces a cached admission instead of leaving it in place', async () => {
    const session = await signedIn();
    answer = () => json(200, admitted(inAMinute()));
    await expect(admit(session)).resolves.toMatchObject({ admitted: true });
    answer = () => json(200, admitted('soon'));
    await expect(admit(session)).resolves.toMatchObject({ admitted: false, code: 'entitlement_unknown' });
    answer = () => json(503, { error: 'upstream unavailable' });
    await expect(admit(session, 'dispatch'), 'the earlier admission is gone').resolves.toMatchObject({ admitted: false, code: 'entitlement_unknown' });
  });

  test('through the gate: a refusal the person reads, with the code that ends nothing', async () => {
    const session = await signedIn();
    const gate = new AccountAgentGate(session, { projectOwner: () => null, active: () => ({ kind: 'business', organizationId: orgs.juniper }) } as never);
    answer = () => json(200, { ...admitted(inAMinute()), pins: undefined });
    const error = await gate.check({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'job-1' }).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('AGENT_NOT_INCLUDED');
    expect((error as EngineError).message).toMatch(/could not read/);
    expect((error as { refusalCode?: string }).refusalCode).toBe('entitlement_unknown');
  });

  test('a well-formed refusal is still the service’s own decision', async () => {
    const session = await signedIn();
    answer = () => json(200, { ...admitted(inAMinute()), decision: { admitted: false, code: 'entitlement_revoked', reason: 'Withdrawn.' } });
    await expect(admit(session)).resolves.toEqual({ admitted: false, code: 'entitlement_revoked', reason: 'Withdrawn.' });
  });
});

describe('a valid admission is cached for at most 60 seconds', () => {
  test('from the faux service itself: reused for a dispatch while fresh, asked again after it', async () => {
    const session = await signedIn();
    const first = await admit(session);
    expect(first).toMatchObject({ admitted: true, organizationId: orgs.juniper });
    expect(asked).toBe(1);
    const until = Date.parse((first as { validUntil: string }).validUntil);
    expect(until - clock, 'held for no more than a minute').toBeLessThanOrEqual(60_000);
    expect(until).toBeGreaterThan(clock);
    clock = until - 1_000;
    expect(await admit(session, 'dispatch'), 'the same decision, from the cache').toEqual(first);
    expect(asked).toBe(1);
    clock = until + 1;
    const second = await admit(session, 'dispatch');
    expect(asked, 'once it is stale, the service is asked again').toBe(2);
    expect(second).toMatchObject({ admitted: true });
  });

  test('a validUntil the service sets further out is still held for only 60 seconds', async () => {
    const session = await signedIn();
    answer = () => json(200, admitted(new Date(clock + 3_600_000).toISOString()));
    const decision = await admit(session);
    expect(decision).toMatchObject({ admitted: true, admissionId: 'agent_admission_00000000-0000-4000-8000-000000000001', policyRevision: 3 });
    expect(Date.parse((decision as { validUntil: string }).validUntil)).toBe(clock + 60_000);
    clock += 60_001;
    await admit(session, 'dispatch');
    expect(asked).toBe(2);
  });

  test('a validUntil sooner than a minute is kept as the service set it', async () => {
    const session = await signedIn();
    answer = () => json(200, admitted(new Date(clock + 10_000).toISOString()));
    const decision = await admit(session);
    expect(Date.parse((decision as { validUntil: string }).validUntil)).toBe(clock + 10_000);
    clock += 9_000;
    await admit(session, 'dispatch');
    expect(asked, 'still fresh').toBe(1);
    clock += 2_000;
    await admit(session, 'dispatch');
    expect(asked, 'past the service’s own time').toBe(2);
  });

  test('the admit phase always asks the service, even with a fresh decision cached', async () => {
    const session = await signedIn();
    await admit(session);
    await admit(session);
    expect(asked).toBe(2);
  });
});
