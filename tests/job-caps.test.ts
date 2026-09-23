/**
 * Parent-job caps by tier (owner decision 2026-09-23): Efficient 20, Focused 50
 * and Thorough 100 credits a job, a pre-send estimate that warns ahead of time,
 * a one-job raise the person agrees to, and a stop at the next step boundary
 * when a running job would pass its cap. Fakes only: no provider, no key, no
 * money. The mid-run stop runs the real NativeAgent, RunService and AWS adapter
 * with the network replaced.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  APPROVED_JOB_CAP_CREDITS,
  DEFAULT_JOB_TIER,
  approvedJobCap,
  capWarningCopy,
  decideJobStep,
  estimateJob,
  jobTierOf,
  nextTierUp,
  oneJobRaise,
  overrunCopy,
  worstCaseNote,
  type JobEstimate,
  type JobRates,
  type JobShape,
  type JobTier,
} from '../shared/job-caps.js';
import { CREDIT_MICRO_USD, creditAmount, micro, type MicroUsd } from '../shared/managed-usage.js';
import { JobCaps, jobKeyFor } from '../server/job-caps.js';
import { estimateView, mountJobCapRoutes, type JobPlan } from '../server/job-cap-routes.js';
import { JobCapReached, SpendExposure, type ExposureAttempt } from '../server/spend-exposure.js';
import {
  AWS_LUNA_MODEL,
  AWS_LUNA_RATE_CARD,
  AWS_RESPONSES_ENDPOINTS,
  awsAccountRoute,
  type AwsConnection,
} from '../server/engines/aws-bedrock.js';
import { ModelApiError } from '../server/engines/model-api-core.js';
import { createAwsModelAdapter } from '../server/harness/aws-model-adapter.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { sourceSha, sourceTools } from '../server/harness/capabilities/conversation-sources.js';
import { FileRunStore, NativeAgent, RunService } from '../server/harness/index.js';
import { MODEL_TURN_CAPABILITY, modelApiDispatchAuthorizer } from '../server/harness/model-session-run.js';
import { FileModelTranscripts } from '../server/harness/model-transcripts.js';
import { responsesAnswer } from './fixtures/model-api-streams.js';

const credits = (n: number) => creditAmount(n);
/** A deliberately dear fixture price, in micro-USD per million tokens. */
const DEAR: JobRates = { input: 150_000_000, output: 600_000_000, cacheRead: 15_000_000, cacheWrite: 187_500_000 };

/** List prices in micro-USD per million tokens, easy to reason about. */
const RATES: JobRates = { input: 1_000_000, output: 4_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 };
const SHAPE: JobShape = {
  inputBytes: 20_000,
  messages: 3,
  maxOutputTokensPerStep: 4_096,
  maxSteps: 8,
  maxRequestBytes: 200_000,
  toolResultBytesPerStep: 200_000,
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-job-caps-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('caps per tier', () => {
  test('Efficient 20, Focused 50 and Thorough 100 credits are the approved defaults', () => {
    expect(APPROVED_JOB_CAP_CREDITS.status).toBe('approved');
    expect(approvedJobCap('efficient')).toBe(20 * CREDIT_MICRO_USD);
    expect(approvedJobCap('focused')).toBe(50 * CREDIT_MICRO_USD);
    expect(approvedJobCap('thorough')).toBe(100 * CREDIT_MICRO_USD);
  });

  test("a job's tier is its thread's style, else the placeholder default", () => {
    expect(jobTierOf('focused')).toBe('focused');
    expect(jobTierOf(null)).toBe(DEFAULT_JOB_TIER);
    expect(nextTierUp('efficient')).toBe('focused');
    expect(nextTierUp('focused')).toBe('thorough');
    expect(nextTierUp('thorough')).toBeNull();
  });
});

describe('the pre-send estimate', () => {
  test('known rates give low, likely and worst in order, against the cap', () => {
    const estimate = estimateJob({ tier: 'focused', metering: 'metered', rates: RATES, shape: SHAPE });
    expect(estimate.kind).toBe('estimate');
    if (estimate.kind !== 'estimate') return;
    expect(estimate.capMicroUsd).toBe(credits(50));
    expect(estimate.lowMicroUsd).toBeGreaterThan(0);
    expect(estimate.lowMicroUsd).toBeLessThanOrEqual(estimate.likelyMicroUsd);
    expect(estimate.likelyMicroUsd).toBeLessThanOrEqual(estimate.worstMicroUsd);
    // Worst is every step at its bound with a cold cache: the dearest input rate on each step's
    // capped input, plus the full output ceiling. Recomputed here from first principles.
    let worst = 0n;
    const ceiling = SHAPE.maxRequestBytes + 1_024 + (SHAPE.messages + 2 * SHAPE.maxSteps) * 16;
    for (let step = 0; step < SHAPE.maxSteps; step++) {
      const grown =
        SHAPE.inputBytes + step * (SHAPE.maxOutputTokensPerStep + SHAPE.toolResultBytesPerStep) + 1_024 + (SHAPE.messages + 2 * step) * 16;
      worst += BigInt(Math.min(grown, ceiling)) * 1_250_000n + 4_096n * 4_000_000n;
    }
    expect(estimate.worstMicroUsd).toBe(Number((worst + 999_999n) / 1_000_000n));
  });

  test('unknown rates on a metered route cannot estimate, and still warn: never zero', () => {
    const estimate = estimateJob({ tier: 'efficient', metering: 'metered', rates: null, shape: SHAPE });
    expect(estimate).toMatchObject({ kind: 'unknown', warn: true, capMicroUsd: credits(20) });
    expect('likelyMicroUsd' in estimate).toBe(false);
    const copy = capWarningCopy(estimate, oneJobRaise({ tier: 'efficient', capMicroUsd: credits(20), neededMicroUsd: null }));
    expect(copy.body).toMatch(/can't estimate this job/);
    expect(copy.upgrade).toEqual({ tier: 'focused', label: 'Use Focused' });
  });

  test('zero or invalid rates are unknown, not free', () => {
    expect(estimateJob({ tier: 'focused', metering: 'metered', rates: { ...RATES, input: 0 }, shape: SHAPE }).kind).toBe('unknown');
    expect(estimateJob({ tier: 'focused', metering: 'metered', rates: { ...RATES, output: -1 }, shape: SHAPE }).kind).toBe('unknown');
  });

  test('a route that spends no credits never warns', () => {
    expect(estimateJob({ tier: 'efficient', metering: 'not-metered', rates: null, shape: SHAPE })).toMatchObject({
      kind: 'not-metered',
      warn: false,
    });
  });
});

describe('over-cap thresholds', () => {
  const scaled = (factor: number): JobRates => ({
    input: RATES.input * factor,
    output: RATES.output * factor,
    cacheRead: RATES.cacheRead * factor,
    cacheWrite: RATES.cacheWrite * factor,
  });
  const at = (tier: JobTier, factor: number) =>
    estimateJob({ tier, metering: 'metered', rates: scaled(factor), shape: SHAPE }) as Extract<JobEstimate, { kind: 'estimate' }>;

  test('likely over the cap warns; only worst over the cap is a note that does not block', () => {
    // Find a price where likely fits Focused but worst does not.
    let factor = 1;
    while (at('focused', factor).worstMicroUsd <= credits(50)) factor *= 2;
    const noted = at('focused', factor);
    expect(noted.likelyExceeds).toBe(false);
    expect(noted.worstExceeds).toBe(true);
    expect(noted.warn).toBe(false);
    expect(worstCaseNote(noted)).toMatch(/stops at the 50-credit cap and asks/);
    while (!at('focused', factor).likelyExceeds) factor *= 2;
    const warned = at('focused', factor);
    expect(warned.warn).toBe(true);
    expect(worstCaseNote(warned)).toBeNull();
  });

  test('the warning says it plainly and offers the tier above, where there is one', () => {
    const estimate: JobEstimate = {
      kind: 'estimate',
      tier: 'focused',
      capMicroUsd: credits(50),
      lowMicroUsd: credits(10),
      likelyMicroUsd: credits(60),
      worstMicroUsd: credits(140),
      likelyExceeds: true,
      worstExceeds: true,
      warn: true,
      basis: '',
    };
    const copy = capWarningCopy(estimate, oneJobRaise({ tier: 'focused', capMicroUsd: credits(50), neededMicroUsd: credits(60) }));
    expect(copy.body).toBe('This will likely use about 60 credits. Focused jobs are capped at 50.');
    expect(copy.upgrade).toEqual({ tier: 'thorough', label: 'Use Thorough' });
    expect(capWarningCopy({ ...estimate, tier: 'thorough', capMicroUsd: credits(100) }, credits(200)).upgrade).toBeNull();
  });

  test('a step that lands exactly on the cap runs; one micro-USD past it stops', () => {
    expect(decideJobStep({ capMicroUsd: credits(20), usedMicroUsd: credits(15), nextMicroUsd: credits(5) }).ok).toBe(true);
    expect(decideJobStep({ capMicroUsd: credits(20), usedMicroUsd: credits(15), nextMicroUsd: micro(credits(5) + 1) })).toMatchObject({
      ok: false,
      code: 'job_cap_reached',
      neededMicroUsd: credits(20) + 1,
    });
  });

  test('a one-job raise is finite: at least a tier more, and whole credits past what is needed', () => {
    expect(oneJobRaise({ tier: 'focused', capMicroUsd: credits(50), neededMicroUsd: credits(60) })).toBe(credits(100));
    expect(oneJobRaise({ tier: 'focused', capMicroUsd: credits(50), neededMicroUsd: micro(credits(130) + 1) })).toBe(credits(131));
    expect(oneJobRaise({ tier: 'efficient', capMicroUsd: credits(20), neededMicroUsd: null })).toBe(credits(40));
  });
});

/** A host whose threads carry a style the test can change, as the Console's style picker does. */
function host() {
  const styles = new Map<string, JobTier>();
  const caps = new JobCaps(path.join(dir, 'data'), {
    tierOf: (_projectId, threadId) => jobTierOf(threadId ? (styles.get(threadId) ?? null) : null),
  });
  return { caps, styles };
}

describe('"Use Thorough" re-resolves the tier', () => {
  test('changing the thread style moves the next estimate to the higher cap, and a pinned job keeps its tier', async () => {
    const { caps, styles } = host();
    await caps.init();
    styles.set('thread-1', 'focused');
    // Dear enough that one typical step is about 74 credits: over Focused, inside Thorough.
    const rates: JobRates = DEAR;
    const plan: JobPlan = { threadId: 'thread-1', metering: 'metered', rates, shape: { ...SHAPE, maxSteps: 4, inputBytes: 180_000 } };
    const before = estimateView(caps.tierFor('p', 'thread-1'), plan);
    expect(before.estimate.tier).toBe('focused');
    expect(before.estimate.capMicroUsd).toBe(credits(50));
    expect(before.warning?.upgrade?.label).toBe('Use Thorough');

    // A job already running keeps the tier it was pinned under.
    const running = await caps.scope('p', 'cmd-running', 'thread-1');
    expect(running.tier).toBe('focused');

    styles.set('thread-1', 'thorough');
    const after = estimateView(caps.tierFor('p', 'thread-1'), plan);
    expect(after.estimate.tier).toBe('thorough');
    expect(after.estimate.capMicroUsd).toBe(credits(100));
    expect(after.warning?.upgrade ?? null).toBeNull();
    expect((await caps.scope('p', 'cmd-running', 'thread-1')).tier).toBe('focused');
    expect((await caps.scope('p', 'cmd-next', 'thread-1')).capMicroUsd).toBe(credits(100));
  });
});

describe('the one-job raise is scoped to exactly that job', () => {
  test('a raise before sending covers that job, not the next one on the thread', async () => {
    const { caps, styles } = host();
    await caps.init();
    styles.set('thread-1', 'focused');
    const raised = await caps.raiseBeforeSend({ projectId: 'p', jobId: 'cmd-1', threadId: 'thread-1', neededMicroUsd: credits(60), by: 'local-person' });
    expect(raised.raise).toMatchObject({ toMicroUsd: credits(100), basis: 'estimate', by: 'local-person' });
    expect((await caps.scope('p', 'cmd-1', 'thread-1')).capMicroUsd).toBe(credits(100));
    expect((await caps.scope('p', 'cmd-2', 'thread-1')).capMicroUsd).toBe(credits(50));
    // Agreeing again for the same job does not raise it twice.
    const again = await caps.raiseBeforeSend({ projectId: 'p', jobId: 'cmd-1', threadId: 'thread-1', neededMicroUsd: credits(500), by: 'local-person' });
    expect(again.raise?.toMicroUsd).toBe(credits(100));
    // Another project's job of the same id is another job.
    expect((await caps.scope('q', 'cmd-1', 'thread-1')).capMicroUsd).toBe(credits(50));
  });

  test('the raise survives a restart, because it is recorded, and it is never standing', async () => {
    const first = host();
    await first.caps.init();
    first.styles.set('t', 'efficient');
    await first.caps.raiseBeforeSend({ projectId: 'p', jobId: 'cmd-1', threadId: 't', neededMicroUsd: null, by: 'local-person' });
    const second = host();
    await second.caps.init();
    expect(second.caps.get('p', 'cmd-1')?.raise?.toMicroUsd).toBe(credits(40));
    expect(second.caps.get('p', 'cmd-2')).toBeNull();
  });

  test('an armed team-wake raise is consumed by the first job on that thread and by no other', async () => {
    const { caps, styles } = host();
    await caps.init();
    styles.set('member-thread', 'efficient');
    caps.arm({ projectId: 'p', threadId: 'member-thread', neededMicroUsd: credits(30), by: 'local-person' });
    // A job on another thread does not take it.
    expect((await caps.scope('p', 'session-other', 'other-thread')).capMicroUsd).toBe(credits(20));
    expect((await caps.scope('p', 'session-1', 'member-thread')).capMicroUsd).toBe(credits(40));
    expect((await caps.scope('p', 'session-2', 'member-thread')).capMicroUsd).toBe(credits(20));
  });

  test('a disarmed raise covers nothing', async () => {
    const { caps } = host();
    await caps.init();
    const ticket = caps.arm({ projectId: 'p', threadId: 'member-thread', neededMicroUsd: null, by: 'local-person' });
    caps.disarm(ticket);
    expect((await caps.scope('p', 'session-1', 'member-thread')).capMicroUsd).toBe(credits(20));
  });

  test('going over after a stop raises exactly one new job, once', async () => {
    const { caps, styles } = host();
    await caps.init();
    styles.set('t', 'focused');
    const stopped = await caps.scope('p', 'cmd-1', 't');
    await caps.noteStop(stopped.id, { usedMicroUsd: credits(45), capMicroUsd: credits(50), neededMicroUsd: credits(57) });
    // The stopped job is never resumed under a raise.
    await expect(caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-1', fromJobId: 'cmd-1', threadId: 't', by: 'local-person' })).rejects.toMatchObject({
      details: { code: 'job_stopped' },
    });
    const resend = await caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-2', fromJobId: 'cmd-1', threadId: 't', by: 'local-person' });
    expect(resend.raise).toMatchObject({ basis: 'overrun', fromJobId: 'cmd-1', toMicroUsd: credits(100) });
    // The same agreement repeated for the same resend is the same record.
    expect((await caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-2', fromJobId: 'cmd-1', threadId: 't', by: 'local-person' })).key).toBe(resend.key);
    // It does not raise a third job, and a job that already started is not raised afterwards.
    await expect(caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-3', fromJobId: 'cmd-1', threadId: 't', by: 'local-person' })).rejects.toMatchObject({
      details: { code: 'stop_consumed' },
    });
    await caps.scope('p', 'cmd-4', 't');
    const other = await caps.scope('p', 'cmd-5', 't');
    await caps.noteStop(other.id, { usedMicroUsd: credits(49), capMicroUsd: credits(50), neededMicroUsd: credits(52) });
    await expect(caps.raiseAfterStop({ projectId: 'p', jobId: 'cmd-4', fromJobId: 'cmd-5', threadId: 't', by: 'local-person' })).rejects.toMatchObject({
      details: { code: 'job_started' },
    });
  });
});

// --- the ledger: children and retries share one cap -------------------------------------

const CONNECTION_ID = 'aws-bedrock-1';
const attempt = (runId: string, n = 1): ExposureAttempt => ({
  runId,
  stepId: 'model:0',
  attempt: n,
  requestDigest: createHash('sha256').update(`${runId}-${n}`).digest('hex'),
});

describe('the spend ledger holds every child and retry of a job to its cap', () => {
  async function ledger() {
    const exposure = new SpendExposure(path.join(dir, 'spend'));
    await exposure.init();
    await exposure.setCap(CONNECTION_ID, micro(100 * CREDIT_MICRO_USD), { approvedBy: 'test owner', note: 'fixture' });
    return exposure;
  }
  const hold = (exposure: SpendExposure, runId: string, amount: MicroUsd, n = 1) =>
    exposure.reserve({
      connectionId: CONNECTION_ID,
      route: AWS_LUNA_RATE_CARD.route,
      modelId: AWS_LUNA_RATE_CARD.modelId,
      card: AWS_LUNA_RATE_CARD,
      attempt: attempt(runId, n),
      maxMicroUsd: amount,
    });

  test('a child run and a retry count against the parent job, and pass it only by being refused', async () => {
    const exposure = await ledger();
    const job = exposure.forJob({ id: jobKeyFor('p', 'cmd-1'), capMicroUsd: credits(20) });
    await hold(job, 'parent-run', credits(8));
    // A child run of the same job.
    await hold(job, 'child-run', credits(8));
    // A retry is a new attempt number: it holds again under the same job.
    await expect(hold(job, 'child-run', credits(8), 2)).rejects.toBeInstanceOf(JobCapReached);
    expect(exposure.jobUsed(jobKeyFor('p', 'cmd-1'))).toBe(credits(16));
    // Another job is not covered by this one's room, and has its own.
    const other = exposure.forJob({ id: jobKeyFor('p', 'cmd-2'), capMicroUsd: credits(20) });
    await expect(hold(other, 'other-run', credits(20))).resolves.toMatchObject({ jobId: jobKeyFor('p', 'cmd-2') });
  });

  test('a job view cannot be re-scoped, and a raw key the host did not issue is refused', async () => {
    const exposure = await ledger();
    const job = exposure.forJob({ id: jobKeyFor('p', 'cmd-1'), capMicroUsd: credits(20) });
    expect(() => job.forJob({ id: jobKeyFor('p', 'cmd-9'), capMicroUsd: credits(1_000) })).toThrow();
    expect(() => exposure.forJob({ id: 'cmd-1', capMicroUsd: credits(1_000) })).toThrow();
  });
});

// --- the mid-run stop, in the real loop ----------------------------------------------------

const BASE = AWS_RESPONSES_ENDPOINTS['us-east-1'];
const SECRET = 'test-only-bedrock-key-0123456789abcdef';
const CONNECTION: AwsConnection = {
  v: 1,
  id: CONNECTION_ID,
  accountId: '123456789012',
  region: 'us-east-1',
  baseUrl: BASE,
  modelId: AWS_LUNA_MODEL,
  processing: 'us-geo',
  credential: { kind: 'bedrock-api-key', fingerprint: 'abcdef123456', savedAt: '2026-09-21T08:00:00.000Z', expiresAt: null },
  revision: 1,
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T08:00:00.000Z',
};
const PROJECT = 'linen-project';
const principal = localHarnessPrincipal(PROJECT);
const SOURCES = [{ path: 'orders/linen-order.txt', text: 'Order 1182: 100 napkins, 40 tablecloths, delivery Friday.' }];
type Item = Record<string, unknown>;
const envelope = (id: string, output: Item[]) => ({
  id,
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: AWS_LUNA_MODEL,
  output,
  usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 150, output_tokens_details: { reasoning_tokens: 60 }, total_tokens: 1_050 },
  incomplete_details: null,
  error: null,
});
const readCall: Item = {
  type: 'function_call',
  id: 'fc_call_1',
  call_id: 'call_1',
  name: 'read_source',
  arguments: JSON.stringify({ path: 'orders/linen-order.txt' }),
  status: 'completed',
};
const finalAnswer: Item = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Order 1182 asked for 100 napkins (orders/linen-order.txt).', annotations: [] }],
};

async function loop(label: string, scope: ((exposure: SpendExposure) => SpendExposure) | null) {
  const root = path.join(dir, label);
  const exposure = new SpendExposure(path.join(root, 'spend'));
  await exposure.init();
  await exposure.setCap(CONNECTION.id, micro(500_000), { approvedBy: 'test owner', note: 'fifty cents' });
  const services = { 'aws-bedrock': true, 'aws-bedrockAccountRoute': awsAccountRoute(CONNECTION) };
  const authorize = modelApiDispatchAuthorizer(() => services);
  const runs: RunService = new RunService(new FileRunStore(path.join(root, 'runs')), {
    authorizeEgress: async (runId, intent, _principal, phase) => authorize(await runs.get(runId), intent, phase),
  });
  const registry = sourceTools(SOURCES);
  await runs.start({
    id: 'turn-1',
    projectId: PROJECT,
    tenantId: principal.tenantId,
    principal,
    capability: MODEL_TURN_CAPABILITY,
    tools: registry,
    input: {
      engine: 'aws-bedrock',
      route: 'aws-bedrock',
      accountRoute: awsAccountRoute(CONNECTION),
      model: AWS_LUNA_MODEL,
      sources: SOURCES.map((source) => ({ path: source.path, sha256: sourceSha(source.text) })),
    },
    budget: { units: 32, modelCalls: 8, toolCalls: 16, wallMs: 480_000 },
  });
  await runs.claim('turn-1', 'host', 600_000);
  const script = [
    () => responsesAnswer(envelope('resp_1', [readCall]), 200, { 'x-amzn-requestid': 'req-1' }),
    () => responsesAnswer(envelope('resp_2', [finalAnswer]), 200, { 'x-amzn-requestid': 'req-2' }),
  ];
  let sent = 0;
  const fetch = (async () => {
    sent += 1;
    const next = script.shift();
    if (!next) throw new Error('Unexpected provider request.');
    return next();
  }) as unknown as typeof globalThis.fetch;
  const adapter = createAwsModelAdapter({
    connection: CONNECTION,
    secret: SECRET,
    card: AWS_LUNA_RATE_CARD,
    exposure: scope ? scope(exposure) : exposure,
    transcripts: new FileModelTranscripts(path.join(root, 'transcripts'), 'aws-bedrock'),
    instructions: 'Answer from the attached files and cite their paths.',
    effort: 'low',
    transport: fetch,
  });
  const outcome = await new NativeAgent(runs, adapter, registry)
    .run('turn-1', 'host', 'What did we order?', principal)
    .then((text) => ({ text, error: null }))
    .catch((error: unknown) => ({ text: null, error }));
  return { outcome, exposure, run: await runs.get('turn-1'), sent: () => sent };
}

describe('a job that runs past its cap mid-way', () => {
  test('stops at the next step boundary: nothing more is sent, nothing is left uncertain', async () => {
    // Calibrate: the same two-step job with no job cap, to read each step's ceiling and cost.
    const free = await loop('free', null);
    expect(free.outcome.error).toBeNull();
    const [first, second] = free.exposure.list(CONNECTION.id);
    expect(second.maxMicroUsd).toBeGreaterThanOrEqual(first.maxMicroUsd);
    // A cap that fits the first step's ceiling, and not the first step's cost plus the second's.
    const cap = first.maxMicroUsd;
    expect(first.settledMicroUsd! + second.maxMicroUsd).toBeGreaterThan(cap);

    const key = jobKeyFor(PROJECT, 'cmd-capped');
    const capped = await loop('capped', (exposure) => exposure.forJob({ id: key, capMicroUsd: cap }));
    const error = capped.outcome.error;
    expect(error).toBeInstanceOf(ModelApiError);
    const refusal = error as ModelApiError;
    expect(refusal.code).toBe('aws_job_cap_reached');
    // Refused before the step, so it is a plain failure that provably sent nothing.
    expect(refusal.dispatched).toBe(false);
    expect(refusal.evidence.job).toMatchObject({ id: key, capMicroUsd: cap, usedMicroUsd: first.settledMicroUsd });
    expect(capped.sent()).toBe(1);
    // The second model step never started; the run failed, it was not parked for reconciliation.
    expect(capped.run.state).toBe('failed');
    expect(capped.run.steps.map((step) => `${step.intent.stepId}:${step.state}`)).toEqual([
      'context:0:succeeded',
      'model:0:succeeded',
      'tool:0:succeeded',
      'context:1:succeeded',
    ]);
    // Exactly one hold, settled at its real cost, all under this job.
    expect(capped.exposure.list(CONNECTION.id).map((hold) => [hold.state, hold.jobId])).toEqual([['settled', key]]);
    expect(capped.exposure.jobUsed(key)).toBe(first.settledMicroUsd);

    // The honest words and the same two choices follow from the recorded stop.
    const copy = overrunCopy({
      tier: 'focused',
      capMicroUsd: credits(50),
      usedMicroUsd: credits(45),
      raisedToMicroUsd: oneJobRaise({ tier: 'focused', capMicroUsd: credits(50), neededMicroUsd: credits(57) }),
    });
    expect(copy.body).toMatch(/stopped before its next step/);
    expect(copy.body).toMatch(/Nothing more was spent/);
    expect(copy.upgrade?.label).toBe('Use Thorough');
  });
});

// --- the routes -----------------------------------------------------------------------------

describe('the job-cap routes', () => {
  async function serve(plan: (threadId: string) => JobPlan, wake: () => Promise<unknown> = async () => ({ ok: true })) {
    const { caps, styles } = host();
    await caps.init();
    const app = express();
    app.use(express.json());
    mountJobCapRoutes(app, {
      jobCaps: caps,
      messagePlan: async (_projectId, threadId) => plan(threadId),
      teamWakePlan: async () => ({ ...plan('member-thread'), threadId: 'member-thread' }),
      wake,
    });
    app.use((error: { status?: number; message: string; details?: object }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message, ...(error.details ?? {}) });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: (await response.json()) as Record<string, any> };
    };
    return { caps, styles, call, close: () => new Promise((resolve) => server.close(resolve)) };
  }
  const expensive = (threadId: string): JobPlan => ({
    threadId,
    metering: 'metered',
    rates: DEAR,
    shape: { ...SHAPE, inputBytes: 180_000 },
  });
  const draft = { text: 'Summarize every invoice.', mode: 'ask', sources: [] };

  test('an estimate warns, and going over once is recorded for exactly the job named', async () => {
    const s = await serve(expensive);
    try {
      const estimate = await s.call('POST', '/api/projects/p/threads/t/job-estimate', draft);
      expect(estimate.status).toBe(200);
      expect(estimate.data.estimate.warn).toBe(true);
      expect(estimate.data.warning.body).toMatch(/^This will likely use about \d[\d,]* credits\. Efficient jobs are capped at 20\.$/);
      const over = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-1/go-over', draft);
      expect(over.status).toBe(200);
      expect(over.data).toMatchObject({ jobId: 'cmd-1', raised: true });
      expect(over.data.capMicroUsd).toBe(estimate.data.raisedToMicroUsd);
      expect((await s.caps.scope('p', 'cmd-2', 't')).capMicroUsd).toBe(credits(20));
    } finally {
      await s.close();
    }
  });

  test('a client-named cap or amount is refused', async () => {
    const s = await serve(expensive);
    try {
      for (const field of ['capMicroUsd', 'neededMicroUsd', 'tier', 'parentEnvelopeMicroUsd']) {
        const refused = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-1/go-over', { ...draft, [field]: 1 });
        expect(refused.status).toBe(400);
        expect(refused.data.code).toBe('client_amount_refused');
      }
      expect(s.caps.get('p', 'cmd-1')).toBeNull();
    } finally {
      await s.close();
    }
  });

  test('going over is refused when nothing warns', async () => {
    const s = await serve((threadId) => ({ threadId, metering: 'not-metered', rates: null, shape: SHAPE }));
    try {
      const refused = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-1/go-over', draft);
      expect(refused.status).toBe(409);
      expect(refused.data.code).toBe('no_warning');
    } finally {
      await s.close();
    }
  });

  test("a stopped job's status carries the overrun words, and the resend is raised once", async () => {
    const s = await serve(expensive);
    try {
      const stopped = await s.caps.scope('p', 'cmd-1', 't');
      await s.caps.noteStop(stopped.id, { usedMicroUsd: credits(18), capMicroUsd: credits(20), neededMicroUsd: credits(24) });
      const status = await s.call('GET', '/api/projects/p/jobs/cmd-1');
      expect(status.data.overrun.title).toBe('This job reached its cap');
      expect(status.data.overrun.upgrade.label).toBe('Use Focused');
      const resend = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-2/go-over', { fromJobId: 'cmd-1' });
      expect(resend.status).toBe(200);
      expect(resend.data.capMicroUsd).toBe(credits(40));
      const third = await s.call('POST', '/api/projects/p/threads/t/jobs/cmd-3/go-over', { fromJobId: 'cmd-1' });
      expect(third.data.code).toBe('stop_consumed');
      expect((await s.call('GET', '/api/projects/p/jobs/cmd-1')).data.overrun).toBeNull();
      expect((await s.call('GET', '/api/projects/p/jobs/never')).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  test('a wake with going over agreed arms one raise, and a failed wake withdraws it', async () => {
    let fail = true;
    const s = await serve(expensive, async () => {
      if (fail) throw Object.assign(new Error('Nothing is waiting for this helper.'), { status: 400 });
      return { ok: true };
    });
    try {
      expect((await s.call('POST', '/api/projects/p/team/members/member-1/wake-over-cap', {})).status).toBe(400);
      expect((await s.caps.scope('p', 'session-0', 'member-thread')).capMicroUsd).toBe(credits(20));
      fail = false;
      expect((await s.call('POST', '/api/projects/p/team/members/member-1/wake-over-cap', {})).status).toBe(200);
      expect((await s.caps.scope('p', 'session-1', 'member-thread')).capMicroUsd).toBeGreaterThan(credits(20));
      expect((await s.caps.scope('p', 'session-2', 'member-thread')).capMicroUsd).toBe(credits(20));
    } finally {
      await s.close();
    }
  });
});
