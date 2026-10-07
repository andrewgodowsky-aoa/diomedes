/**
 * Pay as you go at the desktop (DIO-219): the routing session's gate, the Nectovia route and the gateway's refusal words, for a
 * person with no plan who bought credits for their own Personal work.
 *
 * The account service is the real control-plane handler over the faux store, in this process, read through the desktop's own
 * client; the model is a scripted transport. Nothing leaves this process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { createFauxCloud, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { seedDemo, DEMO_ACCOUNTS, FAUX_DEMO_PASSWORD, type DemoAccount } from '../services/control-plane/src/faux/seed';
import { ControlPlaneClient } from '../server/accounts/client';
import { AccountRoutingSession } from '../server/accounts/routing-session';
import type { AccountSessionService } from '../server/accounts/session';
import type { WorkspaceService } from '../server/workspaces';
import { ROUTING_CONSENT_VERSION, STRICT_RESTRICTIONS, type AccountScope, type ModelBinding, type ProviderConnection } from '../shared/routing-policy';
import { creditAmount, micro, publishedMonthlyGrant, type RateSnapshot } from '../shared/managed-usage';
import {
  AGENT_FREE_VERSION_REASON, AGENT_PERSONAL_REASON, BUSINESS_PLAN_NEEDED_BUYER, BUSINESS_PLAN_NEEDED_MEMBER, OUT_OF_CREDITS_PERSONAL,
  PAY_AS_YOU_GO_PLAN_ONLY_REASON,
} from '../shared/access';
import { decidePayAsYouGo } from '../shared/pay-as-you-go';
import { ensureNectoviaGuard, gatewayRefusal, nectoviaConnectionId, nectoviaRateCard, OUT_OF_CREDITS_BUYER, respondNectovia } from '../server/engines/nectovia';
import { CONVERSATION_LIMITS } from '../server/engines/model-api-core';
import { exposureAttempt } from '../server/engines/aws-bedrock';
import { SpendExposure, type ModelRateCard } from '../server/spend-exposure';

let cloud: FauxCloud, client: ControlPlaneClient, exposure: SpendExposure, directory: string, juniper: string;
let sent: number;
const connection: ProviderConnection = { id: 'fixture-azure', revision: 1, label: 'Synthetic Azure', provider: 'azure-openai',
  secretRef: 'AZURE_OPENAI_API_KEY', payer: 'company', account: 'fixture', enabled: true,
  resource: 'fixture-resource', apiVersion: 'v1', deployments: ['primary'] };
const answer = () => new Response([
  { id: 'fixture-response', model: 'fixture-model', choices: [{ delta: { content: 'A complete answer.' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-provider-request' } });
const RATE: RateSnapshot = { version: 'fixture-rate-1', inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 1_000_000 };

async function api(method: string, url: string, bearer: string, value?: unknown) {
  const response = await cloud.handle(new Request(`${client.base}${url}`, { method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) }));
  const body = await response.json(); expect(response.ok, JSON.stringify(body)).toBe(true); return body;
}
const login = async (who: DemoAccount) =>
  ((await api('POST', '/auth/sign-in', '', { email: DEMO_ACCOUNTS[who].email, password: FAUX_DEMO_PASSWORD })) as { accessToken: string }).accessToken;

beforeEach(async () => {
  sent = 0;
  const now = Date.now(), at = new Date(now).toISOString(), until = new Date(now + 3_600_000).toISOString();
  cloud = await createFauxCloud({ file: null, now: () => now, passwordIterations: 1000, managed: {
    bindings: { MANAGED_CONNECTIONS: JSON.stringify([connection]), AZURE_OPENAI_API_KEY: 'synthetic-provider-key' },
    transport: async () => { sent++; return answer(); },
  } });
  juniper = (await seedDemo(cloud)).organizations!.juniper;
  client = new ControlPlaneClient('http://127.0.0.1:8795', request => cloud.handle(request));
  const staff = await login('staffRouting');
  const binding: ModelBinding = { connectionId: connection.id, connectionRevision: 1, protocol: 'chat-completions', deployment: 'primary',
    modelVersion: 'fixture-model', upstreamEndpoint: null, capabilities: { contextTokens: 100_000, outputTokens: 4096, tools: true, images: false, reasoning: false },
    qualification: { id: 'fixture', evidence: 'Synthetic only', validUntil: until, tiers: ['efficient', 'focused', 'thorough'], qualityFloor: 1 },
    access: { state: 'ready', evidence: 'Synthetic only', validUntil: until, availableRequests: 10 },
    privacy: { connectionRevision: 1, modelVersion: 'fixture-model', protocol: 'chat-completions', evidence: 'Synthetic only', validUntil: until,
      ingressCountries: ['US'], decryptionCountries: ['US'], processingCountries: ['US'], retentionPolicy: 'fixture-zdr', zeroRetention: true, training: false,
      contentLogging: false, caching: 'off', transientCacheEvidence: null, features: ['text', 'tools'], allowedRetentionModes: [], effectiveRetentionMode: null, regionalEntitlement: false },
    health: { state: 'healthy', observedAt: at, validUntil: until, cooldownUntil: null, reason: 'Synthetic only' },
    price: { version: 'fixture-v1', observedAt: at, validUntil: until, evidence: 'Synthetic only', inputMicroUsdPerMillion: 100_000,
      outputMicroUsdPerMillion: 200_000, reasoningMicroUsdPerMillion: 200_000, cacheReadMicroUsdPerMillion: 10_000, cacheWriteMicroUsdPerMillion: 125_000,
      requestFeeMicroUsd: 2, longContext: [] } };
  await api('POST', '/ops/routes', staff, { id: 'primary', provider: 'azure-openai', model: 'fixture-model',
    label: 'primary', region: 'US', processing: 'Synthetic only', status: 'qualified', evidence: 'Synthetic only', binding });
  const tier = { primary: 'primary', backups: [], fallbackEnabled: false, maxAttempts: 1, cost: { sameOrLower: true, qualityFloor: 1, maxAttemptMicroUsd: null } };
  await api('POST', '/ops/routing/scopes/publish', staff, { scope: { kind: 'global' }, baseRevision: 1, baseGlobalRevision: 1,
    routing: { efficient: tier, focused: tier, thorough: tier }, note: 'Synthetic pay as you go test' });
  directory = await mkdtemp(path.join(os.tmpdir(), 'payg-desktop-'));
  exposure = new SpendExposure(directory); await exposure.init();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cloud?.idle();
  if (directory) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('payg-desktop-')) throw new Error('Unexpected test directory.');
    await rm(directory, { recursive: true, force: true });
  }
});

/** The desktop side for one signed-in person: a routing session over the real client, with Personal or a business selected. */
async function desktop(who: DemoAccount, options: { plan?: 'free' | 'paid'; owner?: string | null; roleOf?: () => string } = {}) {
  const token = await login(who);
  const person = (await cloud.accounts.signIn(token)).person;
  const individual = await client.individualAccount(token);
  const scope: AccountScope = { kind: 'individual', id: individual.id };
  await client.acceptRoutingPreference(token, { scope, baseRevision: 0, profile: 'strict', restrictions: STRICT_RESTRICTIONS,
    consentVersion: ROUTING_CONSENT_VERSION, exceptions: [], acknowledge: true });
  const session = { personId: () => person.id, backend: { client }, call: <T>(fn: (value: string) => Promise<T>) => fn(token),
    agentPlan: () => options.plan ?? 'free', entitlement: () => ({ state: 'none' }), includes: () => false, roleIn: () => options.roleOf?.() ?? 'owner',
    confirmDowngrade: async () => {}, confirmAdmitted: async () => {},
    confirmPersonalDowngrade: async () => {}, confirmPersonalAdmitted: async () => {} } as unknown as AccountSessionService;
  const workspaces = { projectOwner: (projectId: string) => (options.owner && projectId === 'business-project' ? { organizationId: options.owner } : null),
    active: () => ({ kind: 'personal' }) } as unknown as WorkspaceService;
  const routing = new AccountRoutingSession(session, workspaces);
  return { token, person, scope, routing };
}
/** A paid purchase for the signed-in person's own Personal work, through the faux Checkout page. */
async function buy(token: string, credits: number) {
  const started = await client.startPersonalCreditPurchase(token, credits);
  await cloud.completeCheckout(new URL(started.checkoutUrl).pathname.split('/').pop()!);
}
/** Other work of the person's that holds everything they have left. */
async function holdTheRest(token: string, personId: string, scope: AccountScope) {
  const left = (await client.personalPurchasedBalance(token)).availableMicroUsd;
  await cloud.funding.openJob({ tenantId: personId, organizationId: scope.id, rootJobId: 'other-work', runRef: 'run_other_work', parentRunRef: null, tier: 'thorough', capMicroUsd: null });
  await cloud.funding.reserve({ tenantId: personId, organizationId: scope.id, attemptId: 'other-hold', rootJobId: 'other-work', parentAttemptId: null,
    kind: 'generation', route: 'primary', requestDigest: 'digest_other', rateSnapshot: RATE, maxMicroUsd: micro(left), usageClass: 'metered-work', boughtOnly: true });
}
/** One step of a Personal job, as the Nectovia route sends it. */
const admitJob = (d: Awaited<ReturnType<typeof desktop>>, job: string) =>
  d.routing.admit({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: job, routeKind: 'managed' });
/** One step of a Personal job, as the Nectovia route sends it, under the job's admission (admitted here unless given). */
async function step(d: Awaited<ReturnType<typeof desktop>>, job: string, attempt: string, given?: { admissionId: string }) {
  const admission = given ?? await admitJob(d, job);
  const policy = d.routing.policy(null)!;
  const connectionId = nectoviaConnectionId(d.scope.id, new Date());
  await exposure.setCap(connectionId, micro(1_000_000), { approvedBy: 'test host', note: 'Disposable guard' });
  const messages: ModelMessage[] = [{ role: 'user', content: 'Hello from Personal.' }];
  return respondNectovia({ base: client.base, account: { policy: () => d.routing.policy(null), refreshPolicy: () => d.routing.refresh(null) },
    connectionId, model: 'fixture-model', managed: { admissionId: admission.admissionId, organizationId: d.scope.id, scope: d.scope,
      policyRevision: policy.revision, routing: policy.resolved, tier: 'efficient', usageClass: 'metered-work', rootJobId: job },
    token: d.token, card: nectoviaRateCard('fixture-model', policy), exposure, attempt: exposureAttempt(job, attempt, messages),
    instructions: 'Answer the request.', messages, tools: [], effort: 'low', limits: CONVERSATION_LIMITS,
    signal: new AbortController().signal, transport: async (url, init) => cloud.handle(new Request(url, init)) });
}

describe('Personal work with no plan and no credits', () => {
  it('is refused before the service is asked, in the free version’s words for a free person and in Personal words otherwise', async () => {
    const free = await desktop('free', { plan: 'free' });
    await free.routing.refreshAccess();
    expect(free.routing.mayHaveAgent(free.scope)).toBe(false);
    expect(free.routing.paysAsYouGo(free.scope)).toBe(false);
    expect(free.routing.personalRefusal(null)).toBe(AGENT_FREE_VERSION_REASON);
    expect(AGENT_FREE_VERSION_REASON).not.toContain('Nothing was sent');
    await expect(free.routing.admit({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'job', routeKind: 'managed' }))
      .rejects.toMatchObject({ message: AGENT_FREE_VERSION_REASON });
    // Someone whose plan is a business's has no plan for Personal work either: the sentence names both ways in.
    const owner = await desktop('owner', { plan: 'paid' });
    await owner.routing.refreshAccess();
    expect(owner.routing.personalRefusal(null)).toBe(AGENT_PERSONAL_REASON);
    expect(sent).toBe(0);
  });
});

describe('Personal work on bought credits', () => {
  it('is admitted at the desktop gate and the account service, runs on the Nectovia route, and grants no feature', async () => {
    const d = await desktop('free');
    await buy(d.token, 1000);
    await d.routing.refreshAccess();
    expect(d.routing.paysAsYouGo(d.scope)).toBe(true);
    expect(d.routing.mayHaveAgent(d.scope)).toBe(true);
    expect(d.routing.personalRefusal(null)).toBeNull();
    // Business rules, phone access and the Agent feature itself stay off: bought credits are not a plan.
    for (const feature of ['nectovia-agent', 'managed-inference', 'owner-rules', 'phone-relay', 'maintained-profiles'] as const)
      expect(d.routing.includes(d.scope, feature), feature).toBe(false);
    const result = await step(d, 'personal-job', 'step-1');
    expect(result.outcome).toMatchObject({ kind: 'final', text: 'A complete answer.' });
    expect(sent).toBe(1);
    const attempt = cloud.store.snapshot().funding.attempts.find(row => row.rootJobId === 'personal-job')!;
    expect(attempt).toMatchObject({ organizationId: d.scope.id, tenantId: d.person.id, periodId: 'bought-credits', monthlyHoldMicroUsd: 0 });
  });

  it('refuses what a plan keeps: the team lead, automations, and the Agent on the person’s own keys', async () => {
    const d = await desktop('free');
    await buy(d.token, 1000);
    for (const work of [{ surface: 'team', routeKind: 'managed' }, { surface: 'automation', routeKind: 'managed' }, { surface: 'conversation', routeKind: 'byo' },
      { surface: 'loop', routeKind: 'byo' }, { surface: 'work', routeKind: 'external-engine' }] as const) {
      const refused = await d.routing.admit({ phase: 'admit', surface: work.surface, projectId: null, rootJobId: `plan-only-${work.surface}`, routeKind: work.routeKind })
        .then(() => null, (error: unknown) => error as { message: string; refusalCode: string });
      expect(refused, JSON.stringify(work)).toMatchObject({ message: PAY_AS_YOU_GO_PLAN_ONLY_REASON, refusalCode: 'plan_required' });
    }
    expect(decidePayAsYouGo({ surface: 'conversation', routeKind: 'managed', usageClass: 'automation' }, true)).toMatchObject({ admitted: false, code: 'plan_required' });
    expect(decidePayAsYouGo({ surface: 'conversation', routeKind: 'managed', escalated: true }, true)).toMatchObject({ admitted: false, code: 'plan_required' });
    expect(sent).toBe(0);
  });

  it('stops the job at the step boundary when the credits run out, in the Personal out-of-credits words', async () => {
    const d = await desktop('free');
    await buy(d.token, 100);
    const admission = await admitJob(d, 'running-job');
    await step(d, 'running-job', 'step-1', admission);
    expect(sent).toBe(1);
    await holdTheRest(d.token, d.person.id, d.scope);
    // The next step of the same job carries its admission, and the gateway refuses it before anything is held or sent.
    await expect(step(d, 'running-job', 'step-2', admission)).rejects.toMatchObject({ code: 'nectovia_insufficient_allowance', message: OUT_OF_CREDITS_PERSONAL });
    expect(sent).toBe(1);
    // With everything spent or held, new work is refused at the gate in the same words.
    await d.routing.refreshAccess();
    expect(d.routing.personalRefusal(null)).toBe(OUT_OF_CREDITS_PERSONAL);
    await expect(d.routing.admit({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'new-job', routeKind: 'managed' }))
      .rejects.toMatchObject({ message: OUT_OF_CREDITS_PERSONAL, refusalCode: 'insufficient_allowance' });
  });
});

describe("the local guard follows what a person paying as they go bought (DIO-223)", () => {
  /** A synthetic card, priced so that one credit is 5,000 input tokens. Only the ledger's arithmetic matters here. */
  const LOCAL_CARD: ModelRateCard = { version: 'fixture-local-1', route: 'fixture-route', modelId: 'fixture-model', source: 'Synthetic fixture only.',
    shortContextMaxInputTokens: 1_000_000, short: { input: 20_000_000, cacheWrite: 0, cacheRead: 0, output: 20_000_000 },
    long: { input: 20_000_000, cacheWrite: 0, cacheRead: 0, output: 20_000_000 } };
  let guardCount = 0;
  const guardConnection = () => nectoviaConnectionId(`guard-fixture-${++guardCount}`, new Date());
  /** One call that held and settled this many credits on the connection, as a run does. */
  async function spend(connectionId: string, credits: number) {
    const held = await exposure.reserve({ connectionId, route: LOCAL_CARD.route, modelId: LOCAL_CARD.modelId, card: LOCAL_CARD,
      attempt: exposureAttempt('guard-run', `step-${++guardCount}`, { guardCount }), maxMicroUsd: creditAmount(credits) });
    return exposure.settle(held.id, { card: LOCAL_CARD, providerRequestId: `request-${guardCount}`,
      usage: { inputTokens: credits * 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } });
  }
  /** The account service's view of the bought balance, as it reaches this computer's session with the person's own scope. */
  async function boughtWith(credits: number) {
    const d = await desktop('free');
    await buy(d.token, credits);
    return d;
  }

  it('carries the service’s amount from the access view to the admission, and lets one computer settle past the default in a month', async () => {
    const d = await boughtWith(3000);
    const admitted = await admitJob(d, 'big-job');
    expect(admitted.planId).toBeNull();
    expect(admitted.boughtAvailable).toBe(creditAmount(3000));
    const connectionId = nectoviaConnectionId(d.scope.id, new Date());
    let guard = await ensureNectoviaGuard(exposure, connectionId, admitted.planId, admitted.boughtAvailable);
    expect(guard).toMatchObject({ capMicroUsd: creditAmount(3000), availableMicroUsd: creditAmount(3000) });
    // 1,500 credits settle on this computer: past the 1,000 default, and the guard still has room.
    await spend(connectionId, 1500);
    // The next admission reports what the service has left, which is what was bought less what was spent.
    guard = await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(3000 - 1500));
    expect(guard.settledMicroUsd).toBe(creditAmount(1500));
    expect(guard.availableMicroUsd).toBe(creditAmount(1500));
    await spend(connectionId, 1000);
    guard = await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(3000 - 2500));
    expect(guard.settledMicroUsd).toBe(creditAmount(2500));
    expect(guard.availableMicroUsd).toBe(creditAmount(500));
    // What was bought was spent exactly: the cap never moved, so it never needed a new revision.
    expect(exposure.allowance(connectionId)).toMatchObject({ capMicroUsd: creditAmount(3000), revision: 1 });
  });

  it('approves the cap again, as a new revision, whenever the figure differs from the approved one, and says whose balance it is', async () => {
    const connectionId = guardConnection();
    await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(3000));
    const first = exposure.allowance(connectionId)!;
    expect(first).toMatchObject({ capMicroUsd: creditAmount(3000), revision: 1 });
    expect(first.approvedBy).toMatch(/bought balance/);
    expect(first.approvedBy).toMatch(/this computer's host/);
    expect(first.note).toMatch(/bought balance/);
    expect(first.note).toMatch(/ledger is the authority/);
    // The same figure again changes nothing.
    await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(3000));
    expect(exposure.allowance(connectionId)!.revision).toBe(1);
    // They bought more, then the service held some for other work: each a new approval at the new figure.
    await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(3500));
    expect(exposure.allowance(connectionId)).toMatchObject({ capMicroUsd: creditAmount(3500), revision: 2 });
    await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(2000));
    expect(exposure.allowance(connectionId)).toMatchObject({ capMicroUsd: creditAmount(2000), revision: 3 });
  });

  it('never sets the cap above what is already out plus the balance the service reported', async () => {
    const connectionId = guardConnection();
    await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(2000));
    await spend(connectionId, 700);
    const open = await exposure.reserve({ connectionId, route: LOCAL_CARD.route, modelId: LOCAL_CARD.modelId, card: LOCAL_CARD,
      attempt: exposureAttempt('guard-run', 'still-running', { open: true }), maxMicroUsd: creditAmount(100) });
    for (const reported of [2000, 1300, 1299, 50, 0, 4000].map(creditAmount)) {
      const guard = await ensureNectoviaGuard(exposure, connectionId, null, reported);
      const out = guard.settledMicroUsd + guard.pendingMicroUsd + guard.uncertainMicroUsd + guard.writtenOffMicroUsd;
      expect(guard.capMicroUsd).toBe(out + reported);
      expect(guard.capMicroUsd).toBeLessThanOrEqual(guard.settledMicroUsd + creditAmount(100) + reported);
      expect(guard.availableMicroUsd).toBe(reported);
    }
    // With nothing held, the cap is the settled amount plus the reported balance, and no more.
    await exposure.settle(open.id, { card: LOCAL_CARD, providerRequestId: 'request-open',
      usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } });
    const settled = await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(900));
    expect(settled.capMicroUsd).toBe(settled.settledMicroUsd + creditAmount(900));
    // Within one admission the reported balance does not change, so the cap follows what settles: it rises by the spend and is
    // approved again. The local guard does not bind inside an admission; the service's refusal does, and the next admission
    // brings a fresh balance.
    const before = exposure.allowance(connectionId)!;
    await spend(connectionId, 200);
    const after = await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(900));
    expect(after.capMicroUsd).toBe(before.capMicroUsd + creditAmount(200));
    expect(exposure.allowance(connectionId)!.revision).toBe(before.revision + 1);
    expect(after.availableMicroUsd).toBe(creditAmount(900));
    // A balance of nothing leaves nothing to send with: the guard stops this computer too.
    expect((await ensureNectoviaGuard(exposure, connectionId, null, creditAmount(0))).availableMicroUsd).toBe(0);
  });

  it('keeps the plan’s published cap, set once, for a plan holder and for a business, whatever amount is passed', async () => {
    for (const planId of ['individual', 'business']) {
      const connectionId = guardConnection();
      const published = publishedMonthlyGrant(planId) ?? creditAmount(1_000);
      await ensureNectoviaGuard(exposure, connectionId, planId, creditAmount(3000));
      expect(exposure.allowance(connectionId)).toMatchObject({ capMicroUsd: published, revision: 1 });
      expect(exposure.allowance(connectionId)!.approvedBy).toBe(`the ${planId} plan, by this computer's host`);
      await ensureNectoviaGuard(exposure, connectionId, planId, creditAmount(7000));
      await ensureNectoviaGuard(exposure, connectionId, planId);
      expect(exposure.allowance(connectionId)).toMatchObject({ capMicroUsd: published, revision: 1 });
    }
    // A business scope's admission never carries an amount, even for an owner who bought credits for their own Personal work.
    const owner = await desktop('owner', { plan: 'paid', owner: juniper });
    await buy(owner.token, 100);
    const admitted = await owner.routing.admit({ phase: 'admit', surface: 'conversation', projectId: 'business-project', rootJobId: 'business-job', routeKind: 'managed' });
    expect(admitted.scope).toEqual({ kind: 'organization', id: juniper });
    expect(admitted.planId).not.toBeNull();
    expect(admitted).not.toHaveProperty('boughtAvailable');
    const connectionId = nectoviaConnectionId(juniper, new Date());
    await ensureNectoviaGuard(exposure, connectionId, admitted.planId, admitted.boughtAvailable);
    expect(exposure.allowance(connectionId)!.capMicroUsd).toBe(publishedMonthlyGrant(admitted.planId!) ?? creditAmount(1_000));
  });

  it('keeps the 1,000 credit default, set once and never guessed at, when the service sent no amount', async () => {
    // The service of before: the same access view without the amount.
    const original = client.scopedAccess.bind(client);
    vi.spyOn(client, 'scopedAccess').mockImplementation(async (...args) => {
      const view = await original(...args);
      const { boughtAvailable: _dropped, ...older } = view;
      return older;
    });
    const d = await boughtWith(3000);
    const admitted = await admitJob(d, 'older-service-job');
    expect(admitted.planId).toBeNull();
    expect(admitted).not.toHaveProperty('boughtAvailable');
    const connectionId = nectoviaConnectionId(d.scope.id, new Date());
    await ensureNectoviaGuard(exposure, connectionId, admitted.planId, admitted.boughtAvailable);
    expect(exposure.allowance(connectionId)).toMatchObject({ capMicroUsd: creditAmount(1_000), revision: 1 });
    await spend(connectionId, 400);
    await ensureNectoviaGuard(exposure, connectionId, admitted.planId, admitted.boughtAvailable);
    await ensureNectoviaGuard(exposure, connectionId, null, null);
    expect(exposure.allowance(connectionId)).toMatchObject({ capMicroUsd: creditAmount(1_000), revision: 1 });
    // The default still stops this computer at 1,000: that is today's behaviour, not a regression.
    await spend(connectionId, 600);
    expect((await ensureNectoviaGuard(exposure, connectionId, null)).availableMicroUsd).toBe(0);
  });

  it('reaches both places that hold on the guard, the same way the plan does', async () => {
    const fs = await import('node:fs');
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(read('server/engines/service.ts')).toContain('ensureNectoviaGuard(api.exposure, handle.connectionId, admitted.planId, admitted.boughtAvailable)');
    expect(read('server/harness/evaluation-managed.ts')).toContain('ensureNectoviaGuard(options.exposure, connectionId, admitted.planId, admitted.boughtAvailable)');
  });

  it('is not sent for a person whose own plan holds the Agent, even when they also bought credits', async () => {
    const d = await desktop('free');
    const grant = await api('POST', `/ops/people/${d.person.id}/grants`, await login('staffBilling'),
      { planId: 'individual', source: 'internal-test', reference: 'Synthetic Personal plan', note: '', validUntil: new Date(Date.now() + 86_400_000).toISOString() });
    expect(grant).toBeTruthy();
    await buy(d.token, 110);
    const admitted = await d.routing.admit({ phase: 'admit', surface: 'conversation', projectId: null, rootJobId: 'plan-job', routeKind: 'byo' });
    expect(admitted.planId).not.toBeNull();
    expect(admitted).not.toHaveProperty('boughtAvailable');
    expect(d.routing.paysAsYouGo(d.scope)).toBe(false);
  });
});

describe('a business workspace with no plan', () => {
  it('refuses the Agent in the words for the person’s role there, even when they bought credits for themselves', async () => {
    const ownerToken = await login('owner');
    const planless = (await api('POST', '/account/organizations', ownerToken, { name: 'Synthetic planless business' })) as { id: string };
    let role = 'owner';
    const d = await desktop('owner', { plan: 'paid', owner: planless.id, roleOf: () => role });
    await buy(d.token, 100);
    // The business's routing policy is not what this checks: the admission is.
    vi.spyOn(d.routing, 'refresh').mockResolvedValue(null);
    for (const [next, sentence] of [['owner', BUSINESS_PLAN_NEEDED_BUYER], ['admin', BUSINESS_PLAN_NEEDED_BUYER], ['member', BUSINESS_PLAN_NEEDED_MEMBER]] as const) {
      role = next;
      await expect(d.routing.admit({ phase: 'admit', surface: 'conversation', projectId: 'business-project', rootJobId: `business-${next}`, routeKind: 'managed' }))
        .rejects.toMatchObject({ message: sentence });
      expect(d.routing.businessPlanReason(planless.id)).toBe(sentence);
    }
    expect(sent).toBe(0);
    expect(juniper).toBeTruthy();
  });
});

describe('the gateway’s refusals in a customer’s words', () => {
  it('says the Personal out-of-credits sentence for a person’s own scope, and keeps the business’s for a business', () => {
    for (const code of ['insufficient_allowance', 'no_period']) {
      expect(gatewayRefusal(402, { code, message: 'service words' }, 'efficient', null, 'individual')).toEqual({ code: `nectovia_${code}`, message: OUT_OF_CREDITS_PERSONAL });
      expect(gatewayRefusal(402, { code, message: 'service words' }, 'efficient', 'owner', 'organization')).toEqual({ code: `nectovia_${code}`, message: OUT_OF_CREDITS_BUYER });
    }
    expect(gatewayRefusal(403, { code: 'plan_required', message: PAY_AS_YOU_GO_PLAN_ONLY_REASON }, 'efficient', null, 'individual'))
      .toEqual({ code: 'nectovia_plan_required', message: PAY_AS_YOU_GO_PLAN_ONLY_REASON });
    expect(gatewayRefusal(403, { code: 'plan_required', message: '' }, 'efficient', null, 'individual'))
      .toEqual({ code: 'nectovia_plan_required', message: PAY_AS_YOU_GO_PLAN_ONLY_REASON });
    expect(creditAmount(1)).toBeGreaterThan(0);
  });
});

describe('the strings (Model B section 7)', () => {
  it('are word for word, with the free-version refusal’s tail dropped and the engine menu line unchanged', async () => {
    const access = await import('../shared/access');
    const { NECTOVIA_LOCKED } = await import('../client/console/ask-row');
    expect(NECTOVIA_LOCKED).toBe('Buy credits or upgrade your plan to use Nectovia');
    expect(access.AGENT_PERSONAL_REASON).toBe('Buy credits or get a plan to use the Nectovia Agent here.');
    expect(access.OUT_OF_CREDITS_PERSONAL).toBe("You're out of credits for the Nectovia Agent. Buy more, or get a plan for a better price.");
    expect(access.BUSINESS_PLAN_NEEDED_BUYER).toBe('This business needs a plan to use the Nectovia Agent.');
    expect(access.BUSINESS_PLAN_NEEDED_MEMBER).toBe('Ask an owner or admin about a plan for this business.');
    expect(access.BUSINESS_CREDITS_NEED_PLAN).toBe('This business can use these credits once it has a plan.');
    expect(access.BOUGHT_CREDITS_LAST).toBe('Credits you buy last 12 months.');
    expect(access.FREE_ABILITIES).toContain('The Nectovia Agent for your own work, with credits you buy');
    expect(access.PAID_ABILITIES).toEqual(expect.arrayContaining(['Included AI usage every month', 'A better price on extra credits']));
    expect(access.PAID_ABILITIES).not.toContain('Included AI usage, with nothing to connect');
    expect(access.AGENT_FREE_VERSION_REASON).toBe("You're on the free version of Nectovia, so the Nectovia Agent isn't available here.");
    expect(access.freeVersionRefusal('Sign up for a plan to talk here.'))
      .toBe("You're on the free version of Nectovia, so the Nectovia Agent isn't available here. Sign up for a plan to talk here.");
    for (const sentence of [access.AGENT_PERSONAL_REASON, access.OUT_OF_CREDITS_PERSONAL, access.PAY_AS_YOU_GO_PLAN_ONLY_REASON, access.BUSINESS_PLAN_NEEDED_BUYER,
      access.BUSINESS_PLAN_NEEDED_MEMBER, access.BUSINESS_CREDITS_NEED_PLAN, access.BOUGHT_CREDITS_LAST, access.AGENT_FREE_VERSION_REASON,
      ...access.FREE_ABILITIES, ...access.PAID_ABILITIES]) {
      expect(sentence).not.toMatch(/[–—*_]/);
      expect(sentence).not.toMatch(/Nothing was (sent|charged)/);
      expect(sentence).not.toMatch(/claude|anthropic|openai|gpt|gemini|llama|mistral|deepseek|bedrock|vertex|azure|aws|stripe/i);
    }
  });
});

describe('what stays on a plan in the host', () => {
  it('business rules and phone access read a business’s own grants only, so Personal work on bought credits never has them', async () => {
    const fs = await import('node:fs');
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    // Owner rules: only where the work's business holds the feature; Personal (no business) gets none.
    expect(read('server/app.ts')).toMatch(/return organizationId !== null && accountSession\.includes\(organizationId, OWNER_RULES_FEATURE\);/);
    // Phone access: the relay asks for its business's feature.
    expect(read('server/relay/messages.ts')).toMatch(/this\.ports\.includes\(this\.options\.organizationId, PHONE_RELAY_FEATURE\)/);
    // Automations: refused unless the business's plan includes the Agent; there is no Personal automation.
    expect(read('server/automations.ts')).toMatch(/private planRefusal\(organizationId: string\)/);
  });
});
