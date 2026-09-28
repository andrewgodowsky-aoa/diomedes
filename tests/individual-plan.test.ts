/**
 * The Individual plan at the host (2026-09-28): a person's own subscription admits their Personal
 * work and projects no business owns. Every Business requires its own plan.
 * The legacy gate has no managed-usage agreement, so it refuses the company route.
 *
 * The account service is the real control-plane handler over the faux store, in this process, read
 * through the desktop's own client and session. Nothing leaves this process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountBackend } from '../server/accounts/backend.js';
import { AccountAgentGate, AGENT_NOT_INCLUDED, AGENT_PROJECT_UNLINKED, type AgentWork } from '../server/accounts/agent-gate.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import { AccountSessionService } from '../server/accounts/session.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../services/control-plane/src/faux/seed.js';
import { AGENT_FREE_VERSION_REASON, AGENT_PERSONAL_REASON } from '../shared/access.js';
import { AGENT_PERSONAL_INDIVIDUAL_REASON, MANAGED_USAGE_NOT_INCLUDED_PERSONAL } from '../shared/individual-plan.js';

let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let dir: string;
let admissions: string[];
/** Replaces the answer to `GET /account/access` when set. */
let personAnswer: (() => Response) | null;

const pathOf = (request: Request) => new URL(request.url).pathname;

async function staffToken(who: DemoAccount) {
  const response = await cloud.handle(new Request('http://faux.local/auth/sign-in', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: false }),
  }));
  return (await response.json()).accessToken as string;
}

/** Billing issues an Individual grant to the named person. */
async function issueIndividual(who: DemoAccount) {
  const personId = (await cloud.accounts.signIn(await staffToken(who))).person.id;
  await cloud.commercial.issuePersonGrant(await staffToken('staffBilling'), personId,
    { planId: 'individual', source: 'subscription', reference: 'inv_individual', note: '' });
}

async function signedIn(who: DemoAccount) {
  const backend: AccountBackend = {
    client: new ControlPlaneClient('http://faux.local', async (request) => {
      if (request.method === 'POST' && pathOf(request).endsWith('/agent-admissions')) admissions.push(pathOf(request));
      if (personAnswer && pathOf(request) === '/account/access') return personAnswer();
      return cloud.handle(request);
    }),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, dir, null, () => Date.now());
  await session.init();
  await session.signIn({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: false });
  return session;
}

/** A gate whose active workspace is Personal, or the named business, and whose projects no business owns. */
function gateFor(session: AccountSessionService, active: string | null = null) {
  return new AccountAgentGate(session, {
    projectOwner: () => null,
    active: () => (active ? { kind: 'business', organizationId: active } : { kind: 'personal' }),
  } as never);
}
const work = (overrides: Partial<AgentWork> = {}): AgentWork =>
  ({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'job-1', routeKind: 'byo', ...overrides });
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as { code: string; message: string });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-individual-plan-'));
  admissions = [];
  personAnswer = null;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  orgs = (await seedDemo(cloud)).organizations!;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('Personal work under an Individual plan', () => {
  test('is admitted under the person own grant, pinned to no business', async () => {
    await issueIndividual('free');
    const session = await signedIn('free');
    const gate = gateFor(session);
    expect(session.personalIncludes()).toBe(true);
    expect(gate.paidFor(null)).toBe(true);
    expect(gate.paidFor('project_unlinked')).toBe(true);
    const admitted = await gate.check(work());
    expect(admitted).toMatchObject({ organizationId: null, planId: 'individual', routeKind: 'byo', surface: 'conversation' });
    expect(admissions).toEqual(['/account/agent-admissions']);
    // A project no business owns is covered the same way.
    await expect(gate.check(work({ projectId: 'project_unlinked', rootJobId: 'job-2' }))).resolves.toMatchObject({ organizationId: null });
  });

  test('is refused as the free version without one, before the service is asked', async () => {
    const session = await signedIn('free');
    const gate = gateFor(session);
    expect(gate.paidFor(null)).toBe(false);
    expect(await refusal(gate.check(work()))).toMatchObject({ code: AGENT_NOT_INCLUDED, message: AGENT_FREE_VERSION_REASON });
    expect(admissions).toEqual([]);
  });

  test('is refused in personal words when a business plan exists but no Individual plan', async () => {
    // The Juniper owner holds the Agent through the business only.
    const session = await signedIn('owner');
    const gate = gateFor(session);
    expect(session.agentPlan()).toBe('paid');
    expect(gate.paidFor(null)).toBe(false);
    expect(await refusal(gate.check(work()))).toMatchObject({ code: AGENT_NOT_INCLUDED, message: AGENT_PERSONAL_INDIVIDUAL_REASON });
    // A project that is not linked keeps its own sentence.
    expect(gate.unpaidReason('project_unlinked')).toBe(AGENT_PROJECT_UNLINKED);
    expect(admissions).toEqual([]);
  });

  test('is refused on the company route, which the plan does not include yet', async () => {
    await issueIndividual('free');
    const session = await signedIn('free');
    const gate = gateFor(session);
    const error = await refusal(gate.check(work({ routeKind: 'managed' })));
    expect(error).toMatchObject({ code: AGENT_NOT_INCLUDED, message: MANAGED_USAGE_NOT_INCLUDED_PERSONAL });
    expect((error as unknown as { refusalCode: string }).refusalCode).toBe('managed_inference_not_included');
    // The host's company-route refusal for this work reads the same sentence.
    expect(gate.unpaidReason(null)).toBe(MANAGED_USAGE_NOT_INCLUDED_PERSONAL);
    expect(admissions).toEqual([]);
  });

  test('lets the service decide while the person own access is unread, and never guesses free', async () => {
    personAnswer = () => new Response(JSON.stringify({ error: 'upstream unavailable' }), { status: 503 });
    const session = await signedIn('free');
    expect(session.personalUnknown()).toBe(true);
    expect(session.agentPlan()).toBe('unknown');
    expect(session.state().plan.notice).toBe(false);
    const gate = gateFor(session);
    expect(gate.paidFor(null)).toBe(true);
    // The service answers: no Individual plan, in the free-version words.
    expect(await refusal(gate.check(work()))).toMatchObject({ message: AGENT_FREE_VERSION_REASON });
    expect(admissions).toEqual(['/account/agent-admissions']);
    // Another person's answer is no answer either.
    personAnswer = () => Response.json({ v: 1, personId: 'person_someone_else', state: 'active', planId: 'individual', planLabel: 'Individual',
      features: ['nectovia-agent'], agent: { included: true, reason: '' }, validFrom: null, validUntil: null, revision: 1, grants: [], checkedAt: '' });
    await session.reload({ project: false });
    expect(session.personalIncludes()).toBe(false);
    expect(session.personalUnknown()).toBe(true);
  });

  test('reads a service from before Individual plans as none, so the free version still shows', async () => {
    personAnswer = () => Response.json({ error: 'This account action was not found.' }, { status: 404 });
    const session = await signedIn('free');
    expect(session.personalUnknown()).toBe(false);
    expect(session.agentPlan()).toBe('free');
    expect(gateFor(session).unpaidReason(null)).toBe(AGENT_FREE_VERSION_REASON);
  });

  test('a person whose plans are unread is not told to switch or pay', async () => {
    personAnswer = () => new Response('<html>edge</html>', { status: 200 });
    const session = await signedIn('free');
    expect(gateFor(session).unpaidReason(null)).toBe(AGENT_PERSONAL_REASON);
  });
});

describe('Business authority remains separate from Individual', () => {
  test('a sole proprietor Business needs its own plan for BYO and managed Agent work', async () => {
    await issueIndividual('harborOwner');
    const session = await signedIn('harborOwner');
    const entitlement = session.entitlement(orgs.harbor);
    expect(entitlement).toMatchObject({ state: 'none', plan: 'none', agent: false, managedInference: false });
    const gate = gateFor(session, orgs.harbor);
    expect(gate.paidFor(null)).toBe(false);
    expect(await refusal(gate.check(work({ surface: 'work' })))).toMatchObject({ code: AGENT_NOT_INCLUDED });
    expect(await refusal(gate.check(work({ routeKind: 'managed', rootJobId: 'job-3' }))))
      .toMatchObject({ code: AGENT_NOT_INCLUDED });
  });
});

describe('the free-version notice', () => {
  test('shows without a plan and hides once the person holds an Individual plan', async () => {
    const before = await signedIn('free');
    expect(before.state().plan).toMatchObject({ agent: 'free', notice: true });
    await issueIndividual('free');
    await before.reload({ project: false });
    expect(before.state().plan).toMatchObject({ agent: 'paid', notice: false });
  });
});

/**
 * One row of the paid-abilities matrix for the Individual plan (tests/paid-abilities-matrix.test.ts
 * belongs to another lane): who, where, which route, and whether the gate admits.
 */
describe('the Individual row of the paid-abilities matrix', () => {
  const rows: { who: DemoAccount; individual: boolean; where: 'personal' | 'harbor' | 'juniper'; route: 'byo' | 'managed'; admitted: boolean }[] = [
    { who: 'free', individual: true, where: 'personal', route: 'byo', admitted: true },
    { who: 'free', individual: true, where: 'personal', route: 'managed', admitted: false },
    { who: 'free', individual: false, where: 'personal', route: 'byo', admitted: false },
    { who: 'harborOwner', individual: true, where: 'harbor', route: 'byo', admitted: false },
    { who: 'harborOwner', individual: false, where: 'harbor', route: 'byo', admitted: false },
    { who: 'owner', individual: true, where: 'juniper', route: 'byo', admitted: true },
    { who: 'owner', individual: false, where: 'personal', route: 'byo', admitted: false },
  ];
  test.each(rows)('$who with Individual $individual, $where on $route: admitted $admitted', async (row) => {
    if (row.individual) await issueIndividual(row.who);
    const session = await signedIn(row.who);
    const gate = gateFor(session, row.where === 'personal' ? null : orgs[row.where]);
    const outcome = await gate.check(work({ routeKind: row.route })).then(() => true, () => false);
    expect(outcome).toBe(row.admitted);
  });
});
