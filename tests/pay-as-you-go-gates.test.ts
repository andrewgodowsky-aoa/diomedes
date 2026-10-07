/**
 * Pay as you go opens Nectovia at the desktop (DIO-245). While a person on the free version holds credits they bought for their
 * own Personal work, the account session's plan view says `payAsYouGo`, and the Nectovia gates (`useNectoviaLocked`) read it.
 * The plan stays `free`, so Routines, the team lead and the rest of a plan stay closed.
 *
 * The account service is the real control-plane handler over the faux store, in this process, read through the desktop's own
 * client and session. Nothing leaves this process.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountBackend } from '../server/accounts/backend.js';
import { ControlPlaneClient } from '../server/accounts/client.js';
import { AccountSessionService } from '../server/accounts/session.js';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud.js';
import { DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, seedDemo, type DemoAccount } from '../services/control-plane/src/faux/seed.js';
import { micro, type RateSnapshot } from '../shared/managed-usage.js';
import type { AccountPlanView } from '../shared/accounts.js';
import { nectoviaLockedBy } from '../client/console/FreePlanNotice';

let cloud: FauxCloud;
let dir: string;
/** Every request the desktop's client sent, as "METHOD /path". */
let sent: string[];
/** Answers `GET /account/purchased-usage` with a failure when set. */
let balanceFails: boolean;
const client = new ControlPlaneClient('http://faux.local', async (request) => {
  const pathname = new URL(request.url).pathname;
  sent.push(`${request.method} ${pathname}`);
  if (balanceFails && pathname === '/account/purchased-usage') return Response.json({ error: 'unavailable' }, { status: 503 });
  return cloud.handle(request);
});
const RATE: RateSnapshot = { version: 'fixture-rate-1', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000 };

async function token(who: DemoAccount) {
  const response = await cloud.handle(new Request('http://faux.local/auth/sign-in', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: false }),
  }));
  return (await response.json()).accessToken as string;
}
async function signedIn(who: DemoAccount) {
  const backend: AccountBackend = {
    client,
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
  const session = new AccountSessionService(backend, dir, null, () => Date.now());
  await session.init();
  await session.signIn({ email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD, remember: false });
  return session;
}
/** A paid purchase for the person's own Personal work, through the faux Checkout page. */
async function buy(who: DemoAccount, credits: number) {
  const started = await client.startPersonalCreditPurchase(await token(who), credits);
  await cloud.completeCheckout(new URL(started.checkoutUrl).pathname.split('/').pop()!);
}
/** Other work of the person's that holds everything they have left, so nothing is available. */
async function holdTheRest(who: DemoAccount) {
  const bearer = await token(who);
  const personId = (await cloud.accounts.signIn(bearer)).person.id;
  const scopeId = (await client.individualAccount(bearer)).id;
  const left = (await client.personalPurchasedBalance(bearer)).availableMicroUsd;
  await cloud.funding.openJob({ tenantId: personId, organizationId: scopeId, rootJobId: 'other-work', runRef: 'run_other_work', parentRunRef: null,
    tier: 'thorough', capMicroUsd: null });
  await cloud.funding.reserve({ tenantId: personId, organizationId: scopeId, attemptId: 'other-hold', rootJobId: 'other-work', parentAttemptId: null,
    kind: 'generation', route: 'primary', requestDigest: 'digest_other', rateSnapshot: RATE, maxMicroUsd: micro(left), usageClass: 'metered-work', boughtOnly: true });
  return { tenantId: personId, organizationId: scopeId, attemptId: 'other-hold', left };
}
/** Billing issues an Individual grant to the named person. */
async function issueIndividual(who: DemoAccount) {
  const personId = (await cloud.accounts.signIn(await token(who))).person.id;
  await cloud.commercial.issuePersonGrant(await token('staffBilling'), personId,
    { planId: 'individual', source: 'subscription', reference: 'inv_individual', note: '' });
}
const balanceReads = () => sent.filter((line) => line === 'GET /account/purchased-usage').length;
const usageReads = () => sent.filter((line) => line === 'GET /account/usage').length;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-payg-gates-'));
  sent = [];
  balanceFails = false;
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  await seedDemo(cloud);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cloud?.idle();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the plan view of a person paying as they go', () => {
  test('keeps Nectovia closed on the free version with nothing bought, and makes no Individual account to look', async () => {
    const session = await signedIn('free');
    const plan = session.state().plan;
    expect(plan).toMatchObject({ agent: 'free', notice: true });
    expect(plan.payAsYouGo).toBeUndefined();
    expect(nectoviaLockedBy(plan)).toBe(plan);
    // The balance read makes the person's Individual billing scope when it's missing, so without one it isn't asked.
    expect(usageReads()).toBeGreaterThan(0);
    expect(balanceReads()).toBe(0);
    expect((await session.personalUsage()).accountId).toBeNull();
  });

  test('opens Nectovia once the account is read again after a purchase, and leaves the plan free', async () => {
    const session = await signedIn('free');
    await buy('free', 100);
    await session.reload({ project: false });
    const plan = session.state().plan;
    expect(plan).toMatchObject({ agent: 'free', payAsYouGo: true });
    expect(nectoviaLockedBy(plan)).toBeNull();
  });

  test('closes it again once everything bought is held or spent', async () => {
    const session = await signedIn('free');
    await buy('free', 100);
    await session.reload({ project: false });
    expect(session.state().plan.payAsYouGo).toBe(true);
    await holdTheRest('free');
    await session.reload({ project: false });
    expect(session.state().plan.payAsYouGo).toBeUndefined();
    expect(nectoviaLockedBy(session.state().plan)).not.toBeNull();
  });

  test('refreshes the bought-credit gate after final-credit consumption without reloading the account', async () => {
    const session = await signedIn('free');
    await buy('free', 100);
    await session.reload({ project: false });
    expect(nectoviaLockedBy(session.state().plan)).toBeNull();
    const { left, ...ref } = await holdTheRest('free');
    await cloud.funding.markDispatched(ref);
    const settled = await cloud.funding.settle({ ...ref, receiptRef: 'final-credit-response', reconciledFrom: 'response',
      usage: { inputTokens: left, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } });
    expect(settled.outcome).toBe('settled');
    expect((await client.personalPurchasedBalance(await token('free'))).availableMicroUsd).toBe(0);
    session.onProjection(async () => { throw new Error('A balance refresh must not project the account.'); });
    const requests = sent.length;
    const plan = await session.refreshPayAsYouGo();
    expect(plan.agent).toBe('free');
    expect(plan.payAsYouGo).toBeUndefined();
    expect(nectoviaLockedBy(plan)).not.toBeNull();
    expect(session.state().plan).toEqual(plan);
    expect(sent.slice(requests)).toEqual(['GET /account/usage', 'GET /account/purchased-usage']);
  });

  test('keeps it closed when the balance cannot be read, guessing nothing open', async () => {
    const session = await signedIn('free');
    await buy('free', 100);
    balanceFails = true;
    await session.reload({ project: false });
    expect(session.state().plan).toMatchObject({ agent: 'free' });
    expect(session.state().plan.payAsYouGo).toBeUndefined();
  });

  test('never asks a plan holder for the balance, and says nothing of credits on a plan', async () => {
    await issueIndividual('free');
    const session = await signedIn('free');
    expect(session.state().plan).toMatchObject({ agent: 'paid', notice: false });
    expect(session.state().plan.payAsYouGo).toBeUndefined();
    expect(balanceReads()).toBe(0);
    expect(usageReads()).toBe(0);
    const requests = sent.length;
    await session.refreshPayAsYouGo();
    expect(sent).toHaveLength(requests);
  });

  test('a work notification never creates a billing scope for a person who has never bought', async () => {
    const session = await signedIn('free');
    await session.refreshPayAsYouGo();
    expect(balanceReads()).toBe(0);
    expect((await session.personalUsage()).accountId).toBeNull();
  });

  test('released holds reopen bought credits, and an unavailable balance closes them', async () => {
    const session = await signedIn('free');
    await buy('free', 100);
    await session.reload({ project: false });
    const { left: _left, ...ref } = await holdTheRest('free');
    expect((await session.refreshPayAsYouGo()).payAsYouGo).toBeUndefined();
    await cloud.funding.release(ref);
    expect((await session.refreshPayAsYouGo()).payAsYouGo).toBe(true);
    balanceFails = true;
    expect((await session.refreshPayAsYouGo()).payAsYouGo).toBeUndefined();
  });

  test('an older positive read cannot overwrite a newer exhausted balance', async () => {
    const session = await signedIn('free');
    await buy('free', 100);
    await session.reload({ project: false });
    const balance = await client.personalPurchasedBalance(await token('free'));
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(client, 'personalPurchasedBalance').mockImplementationOnce(async () => {
      started();
      await pending;
      return balance;
    });
    const older = session.refreshPayAsYouGo();
    await reading;
    await holdTheRest('free');
    expect((await session.refreshPayAsYouGo()).payAsYouGo).toBeUndefined();
    release();
    expect((await older).payAsYouGo).toBeUndefined();
  });

  test('a balance read finishing after an account switch cannot change the next person', async () => {
    const session = await signedIn('free');
    await buy('free', 100);
    await session.reload({ project: false });
    const balance = await client.personalPurchasedBalance(await token('free'));
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(client, 'personalPurchasedBalance').mockImplementationOnce(async () => {
      started();
      await pending;
      return balance;
    });
    const older = session.refreshPayAsYouGo().then(() => null, (error: unknown) => error);
    await reading;
    await session.signIn({ email: DEMO_ACCOUNTS.manager.email, password: FAUX_DEMO_PASSWORD, remember: false });
    release();
    expect(await older).toMatchObject({ status: 401 });
    expect(session.state().person?.email).toBe(DEMO_ACCOUNTS.manager.email);
    expect(session.state().plan.payAsYouGo).toBeUndefined();
  });
});

describe('the Nectovia lock the view, the ask row and Home read', () => {
  const plan = (agent: AccountPlanView['agent'], payAsYouGo?: true): AccountPlanView =>
    ({ agent, plansUrl: 'https://example.test/plans', notice: false, ...(payAsYouGo ? { payAsYouGo } : {}) });

  test('locks only the free version without bought credits', () => {
    const free = plan('free');
    expect(nectoviaLockedBy(free)).toBe(free);
    expect(nectoviaLockedBy(plan('free', true))).toBeNull();
    expect(nectoviaLockedBy(plan('paid'))).toBeNull();
    // An unread plan never locks: the host decides at admission.
    expect(nectoviaLockedBy(plan('unknown'))).toBeNull();
    // No account service at all (accounts off).
    expect(nectoviaLockedBy(null)).toBeNull();
    expect(nectoviaLockedBy(undefined)).toBeNull();
  });
});
