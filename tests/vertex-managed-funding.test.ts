/**
 * Managed Vertex calls against the customer's credits: the real Vertex route
 * (real `ai` / `@ai-sdk/google-vertex` parsing, captured network), the local
 * spend ledger, and the control plane's real `FundingService` on its TEST ONLY
 * memory repository. This proves the seam's rules and ordering, not a hosted
 * boundary, PostgreSQL locking or a real provider.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { creditAmount, micro, payerForRoute, type MicroUsd } from '../shared/managed-usage.js';
import { respondVertex, vertexBaseUrl, vertexRateCard, type VertexConnection } from '../server/engines/google-vertex.js';
import { CONVERSATION_LIMITS, ModelApiError } from '../server/engines/model-api-core.js';
import { exposureAttempt } from '../server/engines/aws-bedrock.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { fundedExposure, fundedUsage, rateSnapshotOf, type ManagedEntitlement } from '../server/managed-funding.js';
import { FundingService } from '../services/control-plane/src/funding.js';
import { FundingMemoryRepository } from '../services/control-plane/tests/support/funding-memory.js';

const T = 'tenant_1';
const O = 'org_1';
const PROJECT = 'nectovia-managed-proof';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const CONNECTION: VertexConnection = {
  v: 1,
  id: 'google-vertex-1',
  projectId: PROJECT,
  location: 'global',
  baseUrl: vertexBaseUrl(PROJECT),
  model: 'gemini-3.8-flash',
  processing: 'google-global',
  payer: { kind: 'google-cloud-project', projectId: PROJECT },
  credential: {
    kind: 'google-adc',
    source: 'service-account',
    namedBy: 'GOOGLE_APPLICATION_CREDENTIALS',
    fingerprint: '0123456789abcdef',
    principal: 'managed-inference@nectovia-managed-proof.iam.gserviceaccount.com',
    quotaProject: null,
    savedAt: '2026-09-23T08:00:00.000Z',
    expiresAt: null,
  },
  revision: 1,
  createdAt: '2026-09-23T08:00:00.000Z',
  updatedAt: '2026-09-23T08:00:00.000Z',
};
const USAGE = { promptTokenCount: 20_000, cachedContentTokenCount: 10_000, candidatesTokenCount: 1_500, thoughtsTokenCount: 500, totalTokenCount: 22_000 };
const answer = (text: string) =>
  new Response(
    [
      { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }], modelVersion: 'gemini-3.8-flash', responseId: 'r1' },
      { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }], usageMetadata: USAGE, modelVersion: 'gemini-3.8-flash', responseId: 'r1' },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': 'goog-1' } },
  );

let dir: string;
let local: SpendExposure;
let repository: FundingMemoryRepository;
let funding: FundingService;
let sent: string[];
let run = 0;
const c = (credits: number) => creditAmount(credits);
const allow: ManagedEntitlement = async () => null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-vertex-funded-'));
  local = new SpendExposure(dir);
  await local.init();
  await local.setCap(CONNECTION.id, micro(50_000_000), { approvedBy: 'company owner', note: 'company provider cap' });
  repository = new FundingMemoryRepository();
  funding = new FundingService(repository, { now: () => NOW.getTime(), approvedDefaultJobCapMicroUsd: c(20) });
  await funding.allocatePeriod({ tenantId: T, organizationId: O, periodId: '2026-09', planId: 'business', sourceGrantId: 'grant_2026_09' });
  await funding.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_1', runRef: 'run_job_1', parentRunRef: null, capMicroUsd: c(20) });
  sent = [];
  run += 1;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const network = (response: () => Response | Promise<Response>) =>
  (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return response();
  }) as typeof globalThis.fetch;

function managedCall(options: {
  fetch: typeof globalThis.fetch;
  rootJobId?: string;
  parentAttemptId?: string | null;
  entitlement?: ManagedEntitlement;
  step?: string;
  signal?: AbortSignal;
}) {
  const messages: ModelMessage[] = [{ role: 'user', content: `Summarise the menu (${options.step ?? 'lead'}).` }];
  return respondVertex({
    connection: CONNECTION,
    secret: 'ya29.test-only',
    card: vertexRateCard(NOW),
    exposure: fundedExposure({
      local,
      funding,
      entitlement: options.entitlement ?? allow,
      job: { tenantId: T, organizationId: O, rootJobId: options.rootJobId ?? 'job_1', parentAttemptId: options.parentAttemptId ?? null, kind: 'generation' },
    }),
    attempt: exposureAttempt(`run-${run}`, `model@${options.step ?? 'lead'}`, messages),
    instructions: 'You are Nectovia.',
    messages,
    tools: [],
    effort: 'low',
    limits: CONVERSATION_LIMITS,
    signal: options.signal ?? new AbortController().signal,
    transport: options.fetch,
    now: () => NOW,
  });
}
const usage = async () => {
  const state = await funding.projection(T, O);
  if (state.state !== 'ready') throw new Error(`usage is ${state.state}`);
  return state.projection;
};
const attempts = () => (repository as unknown as { state: { attempts: { id: string; state: string; rootJobId: string; parentAttemptId: string | null; dispatchedAt: string | null }[] } }).state.attempts;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as ModelApiError;
  }
  throw new Error('Expected the call to fail.');
}

describe('a managed Gemini call spends the customer’s credits', () => {
  test('reserve before dispatch, settle from Vertex usage under the reserved rate snapshot, gross cost kept apart', async () => {
    const result = await managedCall({ fetch: network(() => answer('Soup and a sandwich.')) });
    expect(result.outcome).toEqual({ kind: 'final', text: 'Soup and a sandwich.' });
    expect(sent).toHaveLength(1);

    const card = vertexRateCard(NOW);
    // 10,000 fresh input at $0.75, 10,000 cached at $0.075 and 2,000 output (thinking included) at $3.75.
    const cost = Math.ceil((10_000 * 750_000 + 10_000 * 75_000 + 2_000 * 3_750_000) / 1_000_000);
    const projection = await usage();
    expect(projection.settledMicroUsd).toBe(cost);
    expect(projection.pendingMicroUsd).toBe(0);
    expect(projection.uncertainMicroUsd).toBe(0);
    // The company's own provider ledger records the same call at list price, separately.
    const [hold] = local.list(CONNECTION.id);
    expect(hold).toMatchObject({ state: 'settled', settledMicroUsd: cost, rateCardVersion: card.version });
    expect(fundedUsage(result.usage)).toEqual({ inputTokens: 10_000, cacheReadTokens: 10_000, cacheWriteTokens: 0, outputTokens: 2_000, reasoningTokens: 500 });
    expect(rateSnapshotOf(card)).toMatchObject({ version: card.version, inputMicroUsdPerMillion: 750_000, cacheReadMicroUsdPerMillion: 75_000, outputMicroUsdPerMillion: 3_750_000 });
  });

  test('a child call (worker, reviewer, advisor, retry) debits the same parent job', async () => {
    const lead = await managedCall({ fetch: network(() => answer('Plan.')), step: 'lead' });
    await managedCall({ fetch: network(() => answer('Worker result.')), step: 'worker', parentAttemptId: lead.reservation.id });
    await managedCall({ fetch: network(() => answer('Review.')), step: 'review', parentAttemptId: lead.reservation.id });
    const rows = attempts();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.rootJobId))).toEqual(new Set(['job_1']));
    expect(rows.filter((row) => row.parentAttemptId === lead.reservation.id)).toHaveLength(2);
    expect((await usage()).settledMicroUsd).toBe(3 * lead.reservation.settledMicroUsd!);
  });

  test('a job at its cap refuses the next call before anything is sent; nothing is lost', async () => {
    await funding.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_tiny', runRef: 'run_job_tiny', parentRunRef: null, capMicroUsd: micro(1_000) as MicroUsd });
    const error = await failure(managedCall({ fetch: network(() => answer('never')), rootJobId: 'job_tiny' }));
    expect(error).toBeInstanceOf(ModelApiError);
    expect(error.code).toBe('vertex_spend_refused');
    expect(error.dispatched).toBe(false);
    expect(sent).toHaveLength(0);
    expect(local.list(CONNECTION.id)[0].state).toBe('released');
  });

  test('concurrent jobs cannot overspend the month: exactly one fits, the other is refused unsent', async () => {
    const projection = await usage();
    const ceiling = local.list(CONNECTION.id).length; // no holds yet
    expect(ceiling).toBe(0);
    await funding.openJob({ tenantId: T, organizationId: O, rootJobId: 'job_2', runRef: 'run_job_2', parentRunRef: null, capMicroUsd: c(20) });
    // Leave room for one call's ceiling and not two.
    const probe = await managedCall({ fetch: network(() => answer('probe')), step: 'probe' });
    const oneCeiling = probe.reservation.maxMicroUsd;
    const after = await usage();
    await funding.recordCorrection({
      tenantId: T,
      organizationId: O,
      adjustmentId: 'adj_leave_room',
      periodId: '2026-09',
      direction: 'withdraw',
      amountMicroUsd: micro(after.availableMicroUsd - Math.floor(oneCeiling * 1.5)),
      attemptRef: null,
      note: 'Test: leave room for one ceiling only.',
    });
    const results = await Promise.allSettled([
      managedCall({ fetch: network(() => answer('first')), rootJobId: 'job_1', step: 'a' }),
      managedCall({ fetch: network(() => answer('second')), rootJobId: 'job_2', step: 'b' }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((entry) => entry.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as ModelApiError).dispatched).toBe(false);
    expect(sent).toHaveLength(2); // the probe and the one that fitted
    expect(projection.grantedMicroUsd).toBe(c(1_000));
  });
});

describe('entitlement and revocation', () => {
  test('no subscription entitlement: refused before any hold or paid request', async () => {
    const error = await failure(
      managedCall({ fetch: network(() => answer('never')), entitlement: async () => 'This organization has no active subscription.' }),
    );
    expect(error.code).toBe('vertex_spend_refused');
    expect(error.message).toMatch(/no active subscription/);
    expect(sent).toHaveLength(0);
    expect(attempts()).toHaveLength(0);
    expect(local.list(CONNECTION.id)).toHaveLength(0);
  });

  test('revoked between reserve and dispatch: the send is stopped and both holds are released', async () => {
    const entitlement: ManagedEntitlement = async ({ phase }) => (phase === 'dispatch' ? 'Access was revoked by the organization owner.' : null);
    const error = await failure(managedCall({ fetch: network(() => answer('never')), entitlement }));
    expect(error.code).toBe('vertex_dispatch_refused');
    expect(error.dispatched).toBe(false);
    expect(sent).toHaveLength(0);
    expect(attempts().map((row) => [row.state, row.dispatchedAt])).toEqual([['released', null]]);
    expect(local.list(CONNECTION.id)[0].state).toBe('released');
    expect((await usage()).pendingMicroUsd).toBe(0);
  });
});

describe('failures never refund what may have been spent', () => {
  test('429 after dispatch: Google bills only HTTP 200, so the credit settles at zero; payer and provider unchanged', async () => {
    const error = await failure(
      managedCall({
        fetch: network(() => new Response(JSON.stringify([{ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }]), { status: 429 })),
      }),
    );
    expect(error.code).toBe('vertex_provider_refused');
    expect(sent).toHaveLength(1);
    expect(attempts()[0].state).toBe('settled');
    const projection = await usage();
    expect(projection.settledMicroUsd).toBe(0);
    expect(projection.pendingMicroUsd).toBe(0);
  });

  test('Stop after dispatch keeps the credit hold uncertain, and a restart does not refund it', async () => {
    const controller = new AbortController();
    const error = await failure(
      managedCall({
        signal: controller.signal,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          sent.push(String(input));
          setTimeout(() => controller.abort(), 5);
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
        }) as typeof globalThis.fetch,
      }),
    );
    expect(error.code).toBe('vertex_cancelled');
    expect(attempts()[0].state).toBe('uncertain');
    const held = await usage();
    // Settled, pending, uncertain and remaining stay distinct; a held credit is not shown as spent or as free.
    expect(held.uncertainMicroUsd).toBeGreaterThan(0);
    expect(held.settledMicroUsd).toBe(0);
    expect(held.pendingMicroUsd).toBe(0);
    expect(held.availableMicroUsd).toBe(held.grantedMicroUsd - held.uncertainMicroUsd);
    expect(held).toMatchObject({ periodId: '2026-09', timezone: 'UTC', resetsAt: '2026-10-01T00:00:00.000Z', includedChat: null });
    expect(held.observedAt).toBeTruthy();

    // A new host over the same records: the uncertain hold stays, nothing is released.
    const restarted = new FundingService(repository, { now: () => NOW.getTime() + 60_000, approvedDefaultJobCapMicroUsd: c(20) });
    const recovered = await restarted.recoverAfterRestart({ tenantId: T, organizationId: O });
    expect(recovered.released).toEqual([]);
    const state = await restarted.projection(T, O);
    expect(state.state === 'ready' && state.projection.uncertainMicroUsd).toBe(held.uncertainMicroUsd);
  });

  test('a restart after dispatch commit and before an answer parks the hold uncertain, never released', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'x' }];
    const exposure = fundedExposure({ local, funding, entitlement: allow, job: { tenantId: T, organizationId: O, rootJobId: 'job_1', parentAttemptId: null, kind: 'generation' } });
    const card = vertexRateCard(NOW);
    const reservation = await exposure.reserve({
      connectionId: CONNECTION.id,
      route: 'google-vertex',
      modelId: 'gemini-3.8-flash',
      card,
      attempt: exposureAttempt(`run-${run}`, 'model@crash', messages),
      maxMicroUsd: micro(10_000),
    });
    await exposure.beforeDispatch!(reservation);
    const restarted = new FundingService(repository, { now: () => NOW.getTime() + 60_000, approvedDefaultJobCapMicroUsd: c(20) });
    const recovered = await restarted.recoverAfterRestart({ tenantId: T, organizationId: O });
    expect(recovered.uncertain).toEqual([reservation.id]);
    expect(recovered.released).toEqual([]);
  });
});

describe('who pays', () => {
  test('a BYO or local route never debits managed credits; the founder route holds only the local cap', async () => {
    expect(payerForRoute({ route: 'google-vertex', organizationRoute: 'byo' })).toMatchObject({ payer: 'byo', debitsAllowance: false });
    expect(payerForRoute({ route: 'ollama', organizationRoute: 'managed' })).toMatchObject({ payer: 'local', debitsAllowance: false });
    expect(payerForRoute({ route: 'google-vertex', organizationRoute: 'personal-subscription' })).toMatchObject({ payer: 'refused' });
    // Without a funded ledger (founder or BYO), a Vertex call touches no customer credit.
    await respondVertex({
      connection: CONNECTION,
      secret: 'ya29.test-only',
      card: vertexRateCard(NOW),
      exposure: local,
      attempt: exposureAttempt(`run-${run}`, 'model@byo', [{ role: 'user', content: 'x' }]),
      instructions: 'x',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      effort: 'low',
      limits: CONVERSATION_LIMITS,
      signal: new AbortController().signal,
      transport: network(() => answer('ok')),
      now: () => NOW,
    });
    expect(attempts()).toHaveLength(0);
    expect((await usage()).settledMicroUsd).toBe(0);
  });
});
