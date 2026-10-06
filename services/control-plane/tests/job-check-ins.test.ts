/**
 * Job check-ins (Andrew, 2026-10-05): the amount a job runs to before it asks, where that amount comes
 * from (code, staff, the business itself), where it is enforced (the gateway's job open and every
 * hold), and Keep going. Every figure here is a test figure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_CHECK_IN_CREDITS, creditAmount, defaultCheckIn, micro } from '../../../shared/managed-usage.js';
import { checkInAmount, codeCheckIns, resolveCheckIns, viewOf } from '../../../shared/job-check-ins.js';
import { FundingError, FundingService } from '../src/funding.js';
import { FundingMemoryRepository } from './support/funding-memory.js';
import { createFauxCloud, type FauxCloud } from '../src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../src/faux/seed.js';
import { MANAGED_PROVIDERS, scriptedResponsesFetch } from '../src/managed-providers.js';
import { providerSpy, readAll, type ProviderRequest, type ProviderSpy } from './support/managed.js';

// --- the pure rules --------------------------------------------------------------------------------

describe('the check-in amounts', () => {
  it('has one code default per tier: 100, 250 and 500 credits', () => {
    expect(JOB_CHECK_IN_CREDITS.credits).toEqual({ efficient: 100, focused: 250, thorough: 500 });
    expect(defaultCheckIn('focused')).toBe(creditAmount(250));
    expect(codeCheckIns().credits).toEqual({ efficient: 100, focused: 250, thorough: 500 });
  });

  it('takes the business setting, then the staff default, then the code default, tier by tier', () => {
    const defaults = { version: 3, amounts: { efficient: 120, focused: 300, thorough: 600 } };
    expect(resolveCheckIns(undefined, undefined)).toMatchObject({ credits: { efficient: 100, focused: 250, thorough: 500 }, source: { efficient: 'code', focused: 'code', thorough: 'code' }, defaultsVersion: null });
    expect(resolveCheckIns(defaults, undefined)).toMatchObject({ credits: { efficient: 120, focused: 300, thorough: 600 }, source: { efficient: 'staff', focused: 'staff', thorough: 'staff' }, defaultsVersion: 3 });
    const own = resolveCheckIns(defaults, { efficient: 40, focused: null, thorough: 900 });
    expect(own.credits).toEqual({ efficient: 40, focused: 300, thorough: 900 });
    expect(own.source).toEqual({ efficient: 'business', focused: 'staff', thorough: 'business' });
    expect(checkInAmount(own, 'efficient')).toBe(creditAmount(40));
    expect(viewOf(own).amounts).toEqual(own.credits);
  });
});

// --- Keep going at the funding service -------------------------------------------------------------

const T = 'tenant_1';
const O = 'org_1';
const RATE = { version: 'fixture-rate-1', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000, cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000 };
const AMOUNTS = { efficient: creditAmount(100), focused: creditAmount(250), thorough: creditAmount(500) };

async function funded() {
  const service = new FundingService(new FundingMemoryRepository(), { now: () => Date.parse('2026-09-10T12:00:00.000Z') });
  await service.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_1' });
  const open = (rootJobId: string, tier: 'efficient' | 'focused' | 'thorough' = 'efficient', checkInMicroUsd?: number) =>
    service.openJob({ tenantId: T, organizationId: O, rootJobId, runRef: `run_${rootJobId}`, parentRunRef: null, tier, capMicroUsd: null, ...(checkInMicroUsd === undefined ? {} : { checkInMicroUsd: micro(checkInMicroUsd) }) });
  const reserve = (attemptId: string, credits: number, rootJobId = 'job_1') => service.reserve({
    tenantId: T, organizationId: O, attemptId, rootJobId, parentAttemptId: null, kind: 'generation', route: 'aws-bedrock',
    requestDigest: `digest_${attemptId}`, rateSnapshot: RATE, maxMicroUsd: creditAmount(credits), usageClass: 'metered-work',
  });
  const keep = (rootJobId: string, atCap: number, amounts = AMOUNTS) =>
    service.keepGoing({ tenantId: T, organizationId: O, rootJobId, atCapMicroUsd: micro(atCap), amounts });
  return { service, open, reserve, keep };
}

describe('a job at its check-in amount', () => {
  it('opens with the amount the gateway resolved, never above it', async () => {
    const f = await funded();
    expect((await f.open('job_a', 'efficient', creditAmount(40))).capMicroUsd).toBe(creditAmount(40));
    // Without one, the tier's code default.
    expect((await f.open('job_b', 'focused')).capMicroUsd).toBe(creditAmount(250));
    // A caller cannot ask for more than the amount through the cap field.
    await expect(f.service.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_c', runRef: 'run_c', parentRunRef: null, tier: 'efficient', capMicroUsd: creditAmount(41), checkInMicroUsd: creditAmount(40) }))
      .rejects.toMatchObject({ code: 'cap_request_required' });
  });

  it('refuses a hold that would cross the cap, before anything is sent, as cap_request_required', async () => {
    const f = await funded();
    await f.open('job_1', 'efficient', creditAmount(10));
    await f.reserve('a', 6);
    const refused = await f.reserve('b', 6).catch((error) => error);
    expect(refused).toBeInstanceOf(FundingError);
    expect(refused).toMatchObject({ code: 'cap_request_required', status: 402 });
  });

  it('keeps going by exactly one more amount, for the tier the job was opened under', async () => {
    const f = await funded();
    await f.open('job_1', 'focused', creditAmount(10));
    await f.reserve('a', 6);
    expect(await f.reserve('b', 6).catch((e) => e.code)).toBe('cap_request_required');
    const raised = await f.keep('job_1', creditAmount(10), { ...AMOUNTS, focused: creditAmount(10) });
    expect(raised).toMatchObject({ raised: true, addedMicroUsd: creditAmount(10), job: { capMicroUsd: creditAmount(20), capGeneration: 1 } });
    // The hold that was refused now fits, and the next check-in is again one amount away.
    await f.reserve('b', 6);
    expect(await f.reserve('c', 9).catch((e) => e.code)).toBe('cap_request_required');
  });

  it('adds nothing twice for one check-in: a repeat answers the same, a stale one is refused', async () => {
    const f = await funded();
    await f.open('job_1', 'efficient', creditAmount(10));
    const amounts = { ...AMOUNTS, efficient: creditAmount(10) };
    expect(await f.keep('job_1', creditAmount(10), amounts)).toMatchObject({ raised: true, job: { capMicroUsd: creditAmount(20) } });
    // A second press, a retry after a lost answer, or a second window: the same raise, once.
    expect(await f.keep('job_1', creditAmount(10), amounts)).toMatchObject({ raised: false, job: { capMicroUsd: creditAmount(20), capGeneration: 1 } });
    // A cap the person never saw is refused: the job has not checked in at it.
    const stale = await f.keep('job_1', creditAmount(15), amounts).catch((e) => e);
    expect(stale).toMatchObject({ code: 'check_in_stale', status: 409 });
    // The next check-in, at the new cap, is one more amount.
    expect(await f.keep('job_1', creditAmount(20), amounts)).toMatchObject({ raised: true, job: { capMicroUsd: creditAmount(30), capGeneration: 2 } });
  });

  it('refuses a job that is not there, another business’s job, and a job opened before check-ins', async () => {
    const f = await funded();
    await f.open('job_1', 'efficient', creditAmount(10));
    expect(await f.keep('nope', creditAmount(10)).catch((e) => e.code)).toBe('unknown_job');
    expect(await f.service.keepGoing({ tenantId: T, organizationId: 'org_2', rootJobId: 'job_1', atCapMicroUsd: creditAmount(10), amounts: AMOUNTS }).catch((e) => e.code)).toBe('unknown_job');
    // A job with no recorded tier (opened before migration 020) is never raised by a tier it does not have.
    const repository = new FundingMemoryRepository();
    const old = new FundingService(repository, { now: () => Date.parse('2026-09-10T12:00:00.000Z') });
    await repository.transaction(async (tx) => tx.saveJob({ tenantId: T, organizationId: O, rootJobId: 'old', runRef: 'run_old', capMicroUsd: creditAmount(10), capGeneration: 0, state: 'open', openedAt: '2026-09-01T00:00:00.000Z' }));
    expect(await old.keepGoing({ tenantId: T, organizationId: O, rootJobId: 'old', atCapMicroUsd: creditAmount(10), amounts: AMOUNTS }).catch((e) => e.code)).toBe('job_tier_unknown');
  });

  it('still needs the credits: a raise lends none', async () => {
    const f = await funded();
    // Business credits are 1,000; one hold of 2,000 credits cannot be made at any cap.
    await f.open('job_1', 'thorough', creditAmount(10));
    await f.keep('job_1', creditAmount(10), { ...AMOUNTS, thorough: creditAmount(5_000) });
    expect(await f.reserve('big', 2_000).catch((e) => e.code)).toBe('insufficient_allowance');
  });
});

// --- through the faux cloud's real handler ----------------------------------------------------------

const LUNA = MANAGED_PROVIDERS[0];
let clock = Date.parse('2026-09-25T12:00:00.000Z');
let cloud: FauxCloud;
let orgs: { juniper: string; harbor: string };
let spy: ProviderSpy;
const scripted = scriptedResponsesFetch({ now: () => clock });

beforeEach(async () => {
  clock = Date.parse('2026-09-25T12:00:00.000Z');
  spy = providerSpy((request: ProviderRequest) => scripted(request.url, { method: 'POST', headers: request.headers, body: request.rawBody }));
  cloud = await createFauxCloud({ file: null, now: () => clock, passwordIterations: 1_000, managed: { transport: spy.fetch, credential: 'ABSK-fixture-credential', settings: {} } });
  orgs = (await seedDemo(cloud)).organizations!;
});
afterEach(async () => { await cloud.idle(); vi.restoreAllMocks(); });

async function call(method: string, pathname: string, token?: string, body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await cloud.handle(new Request(`http://127.0.0.1:8795${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function signIn(who: DemoAccount) {
  return (await call('POST', '/auth/sign-in', undefined, { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD })).body.accessToken as string;
}
/** One managed call as the employee, under a job; `maxOutput` sizes its hold (10 ledger units a token). */
async function ask(job: string, attempt: string, opts: { tier?: string; maxOutput?: number; who?: DemoAccount } = {}) {
  const token = await signIn(opts.who ?? 'employee');
  const admission = await call('POST', `/account/organizations/${orgs.juniper}/agent-admissions`, token, { surface: 'conversation', routeKind: 'managed', rootJobId: job });
  expect(admission.status).toBe(200);
  const body = { model: LUNA.model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] }], store: false, stream: true, max_output_tokens: opts.maxOutput ?? 1_000 };
  return cloud.handle(new Request('http://127.0.0.1:8795/managed/v1/responses', { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-nectovia-organization': orgs.juniper,
    'x-nectovia-admission': admission.body.admissionId, 'x-nectovia-job': job, 'x-nectovia-attempt': attempt,
    'x-nectovia-tier': opts.tier ?? 'efficient', 'x-nectovia-usage-class': 'included-chat', 'x-nectovia-policy-revision': '1',
  }, body: JSON.stringify(body) }));
}
async function refusal(response: Response) {
  const body = await response.json() as { error: { code: string; message: string } };
  return { status: response.status, ...body.error };
}
const jobs = () => cloud.store.snapshot().funding.jobs;
const jobOf = (id: string) => jobs().find((row) => row.rootJobId === id);
const defaultsOf = () => cloud.store.snapshot().commercial.checkInDefaults;
const publish = (token: string, over: Record<string, unknown> = {}) =>
  call('POST', '/ops/job-check-ins/publish', token, { baseVersion: 0, amounts: { efficient: 120, focused: 300, thorough: 600 }, note: 'Test defaults.', ...over });
const setOwn = (token: string, amounts: Record<string, number | null>, org = orgs.juniper) =>
  call('POST', `/account/organizations/${org}/job-check-ins`, token, { amounts: { efficient: null, focused: null, thorough: null, ...amounts } });

async function serve(job: string, attempt: string, opts: Parameters<typeof ask>[2] = {}) {
  const response = await ask(job, attempt, opts);
  expect(response.status).toBe(200);
  await readAll(response.body);
  await cloud.idle();
}

describe('where a job’s check-in amount comes from', () => {
  it('is the code default until staff or the business set one', async () => {
    await serve('job-code', 'job-code:1');
    expect(jobOf('job-code')).toMatchObject({ capMicroUsd: creditAmount(100), tier: 'efficient' });
    await serve('job-code-focused', 'job-code-focused:1', { tier: 'focused' });
    expect(jobOf('job-code-focused')).toMatchObject({ capMicroUsd: creditAmount(250), tier: 'focused' });
    await serve('job-code-thorough', 'job-code-thorough:1', { tier: 'thorough' });
    expect(jobOf('job-code-thorough')).toMatchObject({ capMicroUsd: creditAmount(500), tier: 'thorough' });
  });

  it('is the staff default once staff publish one, for every business', async () => {
    expect((await publish(await signIn('staffRouting'))).status).toBe(201);
    await serve('job-staff', 'job-staff:1');
    expect(jobOf('job-staff')?.capMicroUsd).toBe(creditAmount(120));
  });

  it('is the business’s own setting, for that business alone', async () => {
    await publish(await signIn('staffRouting'));
    const set = await setOwn(await signIn('owner'), { efficient: 40, thorough: 900 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({
      effective: { amounts: { efficient: 40, focused: 300, thorough: 900 }, source: { efficient: 'business', focused: 'staff', thorough: 'business' } },
      defaults: { efficient: 120, focused: 300, thorough: 600 }, override: { efficient: 40, focused: null, thorough: 900 },
    });
    await serve('job-own', 'job-own:1');
    expect(jobOf('job-own')?.capMicroUsd).toBe(creditAmount(40));
    await serve('job-own-focused', 'job-own-focused:1', { tier: 'focused' });
    expect(jobOf('job-own-focused')?.capMicroUsd).toBe(creditAmount(300));
    // Another business reads its own: the defaults.
    const harbor = await call('GET', `/account/routing/organization/${orgs.harbor}/check-ins`, await signIn('harborOwner'));
    expect(harbor.body).toMatchObject({ amounts: { efficient: 120, focused: 300, thorough: 600 }, source: { efficient: 'staff' } });
    // A job already open keeps the amount it was opened with when the setting changes.
    await setOwn(await signIn('owner'), { efficient: 55 });
    await serve('job-own', 'job-own:2');
    expect(jobOf('job-own')?.capMicroUsd).toBe(creditAmount(40));
    await serve('job-own-2', 'job-own-2:1');
    expect(jobOf('job-own-2')?.capMicroUsd).toBe(creditAmount(55));
  });

  it('is changed by an owner or an admin, and read by them, and by no one else', async () => {
    expect((await setOwn(await signIn('employee'), { efficient: 10 })).status).toBe(403);
    expect((await call('GET', `/account/organizations/${orgs.juniper}/job-check-ins`, await signIn('employee'))).status).toBe(403);
    expect((await setOwn(await signIn('free'), { efficient: 10 })).status).toBe(403);
    // Another business's owner cannot set this one's.
    expect((await setOwn(await signIn('harborOwner'), { efficient: 10 })).status).toBe(403);
    expect((await setOwn(await signIn('manager'), { efficient: 10 })).status).toBe(200);
    const read = await call('GET', `/account/organizations/${orgs.juniper}/job-check-ins`, await signIn('owner'));
    expect(read.body).toMatchObject({ override: { efficient: 10, focused: null, thorough: null }, effective: { amounts: { efficient: 10, focused: 250, thorough: 500 } } });
    expect(cloud.store.snapshot().commercial.checkInOverrides).toHaveLength(1);
  });

  it('takes whole credits from 1 to 100,000 only, and a client names nothing else', async () => {
    const owner = await signIn('owner');
    for (const bad of [0, -5, 1.5, 100_001]) expect((await setOwn(owner, { efficient: bad })).status, String(bad)).toBe(422);
    expect((await call('POST', `/account/organizations/${orgs.juniper}/job-check-ins`, owner, { amounts: { efficient: 10 } })).status).toBe(422);
    expect((await call('POST', `/account/organizations/${orgs.juniper}/job-check-ins`, owner, { amounts: { efficient: 10, focused: null, thorough: null }, extra: 1 })).status).toBe(422);
    expect(cloud.store.snapshot().commercial.checkInOverrides).toHaveLength(0);
  });

  it('lets any member read what their jobs check in at', async () => {
    const read = await call('GET', `/account/routing/organization/${orgs.juniper}/check-ins`, await signIn('employee'));
    expect(read.body).toEqual({ amounts: { efficient: 100, focused: 250, thorough: 500 }, source: { efficient: 'code', focused: 'code', thorough: 'code' }, defaultsVersion: null });
    expect((await call('GET', `/account/routing/organization/${orgs.juniper}/check-ins`, await signIn('harborOwner'))).status).toBe(403);
  });
});

describe('staff publishing the defaults', () => {
  it('is for routing staff and admins only', async () => {
    for (const who of ['staffSupport', 'staffBilling', 'owner', 'free'] as const) {
      const token = await signIn(who);
      expect((await call('GET', '/ops/job-check-ins', token)).status).toBe(403);
      expect((await publish(token)).status).toBe(403);
    }
    expect((await call('GET', '/ops/job-check-ins')).status).toBe(401);
    expect(defaultsOf()).toHaveLength(0);
  });

  it('publishes a version on the one read, audits it, keeps every version readable and never rewrites one', async () => {
    const routing = await signIn('staffRouting');
    const first = await publish(routing);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ v: 1, version: 1, amounts: { efficient: 120, focused: 300, thorough: 600 } });
    // Built on a version that is no longer the newest: refused, nothing written.
    expect((await publish(routing)).status).toBe(409);
    expect((await publish(routing, { baseVersion: 1, amounts: { efficient: 130, focused: 300, thorough: 600 } })).status).toBe(201);
    const read = await call('GET', '/ops/job-check-ins', await signIn('staffAdmin'));
    expect(read.body.defaults.version).toBe(2);
    expect(read.body.history.map((row: { version: number }) => row.version)).toEqual([2, 1]);
    const audit = cloud.store.snapshot().commercial.audit.filter((row) => row.action === 'job-check-ins.published');
    expect(audit.map((row) => [row.targetKind, row.targetId])).toEqual([['job-check-ins', '1'], ['job-check-ins', '2']]);
    expect(audit.map((row) => (row.detail as { basedOn: number }).basedOn)).toEqual([0, 1]);
    await expect(cloud.store.commercial.transaction((tx) => tx.saveCheckInDefaults(defaultsOf()[0]))).rejects.toThrow(/append-only/);
  });

  it('refuses amounts that are not whole credits from 1 to 100,000, and a note-less publish', async () => {
    const routing = await signIn('staffRouting');
    for (const amounts of [{ efficient: 0, focused: 1, thorough: 1 }, { efficient: 1.5, focused: 1, thorough: 1 }, { efficient: 1, focused: 1, thorough: 100_001 }, { efficient: 1, focused: 1 }])
      expect((await publish(routing, { amounts })).status).toBe(422);
    expect((await publish(routing, { note: '   ' })).status).toBe(422);
    expect(defaultsOf()).toHaveLength(0);
  });
});

describe('the stop at the amount, and Keep going', () => {
  const keepGoing = (token: string, job: string, atCapMicroUsd: number, org = orgs.juniper) =>
    call('POST', `/account/routing/organization/${org}/check-ins/keep-going`, token, { jobId: job, atCapMicroUsd });

  it('refuses a hold that would cross the amount before dispatch, then goes on after Keep going', async () => {
    await setOwn(await signIn('owner'), { efficient: 1 });
    await serve('job-stop', 'job-stop:1', { maxOutput: 1_000 });
    const sent = spy.calls.length;
    // 16,000 output tokens hold about 1.6 credits: more than the one credit the job checks in at.
    expect(await refusal(await ask('job-stop', 'job-stop:2', { maxOutput: 16_000 }))).toMatchObject({ status: 402, code: 'cap_request_required' });
    expect(spy.calls.length).toBe(sent);
    expect(jobOf('job-stop')?.capMicroUsd).toBe(creditAmount(1));

    const employee = await signIn('employee');
    const kept = await keepGoing(employee, 'job-stop', creditAmount(1));
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body).toMatchObject({ jobId: 'job-stop', capMicroUsd: creditAmount(2), addedCredits: 1, raised: true });
    expect(jobOf('job-stop')).toMatchObject({ capMicroUsd: creditAmount(2), capGeneration: 1 });
    // The same press again is the same raise.
    expect((await keepGoing(employee, 'job-stop', creditAmount(1))).body).toMatchObject({ capMicroUsd: creditAmount(2), raised: false });
    expect(jobOf('job-stop')?.capGeneration).toBe(1);
    await serve('job-stop', 'job-stop:3', { maxOutput: 16_000 });
  });

  it('adds the amount of the job’s own tier, and only for a member of the business', async () => {
    await serve('job-tier', 'job-tier:1', { tier: 'focused' });
    const employee = await signIn('employee');
    expect((await keepGoing(employee, 'job-tier', creditAmount(250))).body).toMatchObject({ capMicroUsd: creditAmount(500), addedCredits: 250 });
    // Someone outside the business cannot raise its job, whatever they name.
    expect((await keepGoing(await signIn('harborOwner'), 'job-tier', creditAmount(500), orgs.juniper)).status).toBe(403);
    expect((await keepGoing(await signIn('harborOwner'), 'job-tier', creditAmount(500), orgs.harbor)).status).toBe(404);
    expect(jobOf('job-tier')?.capMicroUsd).toBe(creditAmount(500));
    // A request cannot name a tier or an amount.
    const named = await call('POST', `/account/routing/organization/${orgs.juniper}/check-ins/keep-going`, employee, { jobId: 'job-tier', atCapMicroUsd: creditAmount(500), tier: 'thorough', amount: 9_999 });
    expect(named.status).toBe(422);
    expect(jobOf('job-tier')?.capMicroUsd).toBe(creditAmount(500));
  });

  it('keeps a member’s monthly limit: Keep going does not lift it', async () => {
    await setOwn(await signIn('owner'), { efficient: 1 });
    // The employee may use 1.5 credits this month; the owner's setting is what it is.
    const limit = await call('POST', `/account/organizations/${orgs.juniper}/credit-limits`, await signIn('owner'),
      { subject: { kind: 'role', role: 'member' }, mode: 'limit', limitMicroUsd: 150_000 });
    expect(limit.status, JSON.stringify(limit.body)).toBe(200);
    await serve('job-limit', 'job-limit:1', { maxOutput: 1_000 });
    expect(await refusal(await ask('job-limit', 'job-limit:2', { maxOutput: 16_000 }))).toMatchObject({ code: 'cap_request_required' });
    expect((await keepGoing(await signIn('employee'), 'job-limit', creditAmount(1))).status).toBe(200);
    // The job has room now, but the month's limit does not.
    expect(await refusal(await ask('job-limit', 'job-limit:3', { maxOutput: 16_000 }))).toMatchObject({ status: 402, code: 'member_limit_reached' });
  });

  it('refuses a job the account service does not know', async () => {
    expect((await keepGoing(await signIn('employee'), 'job-never-opened', creditAmount(100))).status).toBe(404);
  });
});
