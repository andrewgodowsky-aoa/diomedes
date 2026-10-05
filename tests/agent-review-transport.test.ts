/** Direct task review uses the installed SDK, a fake wire and a real fixture ledger. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { micro } from '../shared/managed-usage.js';
import { digest } from '../server/harness/policy.js';
import {
  normalizeSdkEvaluation,
  type EvaluationPort,
  type EvaluationPortCall,
  type openRouterEvaluationPort,
} from '../server/harness/evaluation-adapter.js';
import {
  SpendExposure,
  ceilingCost,
  type ModelRateCard,
  type ExposureReservation,
} from '../server/spend-exposure.js';

// The desired host contract is structural here so the missing factory fails an
// assertion during RED, rather than failing test collection with a missing import.
interface Binding {
  grantId: string; rootRunId: string; projectId: string; taskId: string;
  rootJobId: string; stepId: string; route: 'openrouter'; connectionId: string;
  modelId: 'typesafe/jev-1.13'; accountId: string; accountRevision: number;
  accountDigest: string; dataPolicyDigest: string; maxInputTokens: number; maxCalls: 1;
}
interface ProviderPolicy {
  only: string[]; allow_fallbacks: false; require_parameters: true;
  data_collection: 'deny'; zdr?: boolean;
}
interface Qualification {
  id: string; source: string; rateCard: ModelRateCard; inputFramingTokens: number;
}
interface Admission {
  binding: Binding; apiKey: string; provider: ProviderPolicy; qualification: Qualification | null;
}
interface FactoryOptions {
  binding: Binding; ledger: SpendExposure; stateDigest: string;
  resolveCurrent: (signal: AbortSignal) => Promise<Admission>;
  fetch?: typeof fetch;
  loadSdk?: Parameters<typeof openRouterEvaluationPort>[0]['loadSdk'];
}
interface Transport { port: EvaluationPort; ledger: SpendExposure; binding: Binding }
type Factory = (options: FactoryOptions) => Transport;
type OpenRouterSdk = Awaited<ReturnType<NonNullable<FactoryOptions['loadSdk']>>>;

async function factory(): Promise<Factory> {
  const source = fileURLToPath(new URL('../server/harness/agent-review-transport.ts', import.meta.url));
  const module = existsSync(source)
    ? await vi.importActual<{ createAgentReviewTransport?: Factory }>('../server/harness/agent-review-transport.js')
    : {};
  expect(module.createAgentReviewTransport, 'The direct root-scoped review factory is required.').toBeTypeOf('function');
  return module.createAgentReviewTransport!;
}

const POLICY: ProviderPolicy = {
  only: ['typesafe'], allow_fallbacks: false, require_parameters: true,
  data_collection: 'deny', zdr: true,
};
const CARD: ModelRateCard = {
  version: 'fixture-jev-qualification-1', route: 'openrouter', modelId: 'typesafe/jev-1.13',
  source: 'Synthetic qualification. These figures do not qualify a live account.',
  shortContextMaxInputTokens: 32_000,
  short: { input: 42_000, cacheRead: 42_000, cacheWrite: 42_000, output: 0 },
  long: { input: 42_000, cacheRead: 42_000, cacheWrite: 42_000, output: 0 },
};
const QUALIFICATION: Qualification = {
  id: 'fixture-only', source: CARD.source, rateCard: CARD, inputFramingTokens: 1_024,
};
const BINDING: Binding = {
  grantId: 'review-grant-1', rootRunId: 'root-run-1', projectId: 'inventory-project',
  taskId: 'reconciliation-task', rootJobId: `job-${'a'.repeat(40)}`,
  stepId: 'evaluation:inventory-review:1:fixture', route: 'openrouter',
  connectionId: 'openrouter-1', modelId: 'typesafe/jev-1.13',
  accountId: 'fixture-owner', accountRevision: 1, accountDigest: 'b'.repeat(64),
  dataPolicyDigest: digest(POLICY), maxInputTokens: 5_000, maxCalls: 1,
};
const STATE = { sources: [{ sourceId: 'inventory', text: 'A 10/10; B 8/6 at $3.75; C 5/5' }], report: 'B short 2; totals 23/21; $7.50. No inventory updated.' };
const QUESTIONS = { correct: { type: 'boolean' as const, instructions: 'Does the report match the selected input?' } };
const REPLY = {
  id: 'fixture-provider-request', model: BINDING.modelId,
  answers: { correct: { type: 'noul', noul: 0.99 } },
  usage: { input_tokens: 96, output_tokens: 3, cost: 0.0000041 },
};
const dirs: string[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', async () => { throw new Error('This offline suite refuses unbound global fetch.'); });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface Seen { url: string; method: string; headers: Headers; body: Record<string, unknown> }
async function fixture(input: { state?: unknown; cap?: number; reply?: unknown; fetch?: typeof fetch } = {}) {
  const make = await factory();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-review-transport-'));
  dirs.push(dataDir);
  const base = new SpendExposure(dataDir);
  await base.init();
  await base.setCap(BINDING.connectionId, micro(100_000), { approvedBy: 'fixture-owner', note: 'Synthetic fixture only.' });
  const ledger = base.forJob({ id: BINDING.rootJobId, capMicroUsd: micro(input.cap ?? 10_000) });
  const seen: Seen[] = [];
  const atDispatch: ExposureReservation[] = [];
  const persistedAtDispatch: ExposureReservation[] = [];
  const fake: typeof fetch = input.fetch ?? (async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    atDispatch.push(...base.list(BINDING.connectionId));
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'spend-exposure', `${BINDING.connectionId}.json`), 'utf8'));
    persistedAtDispatch.push(...stored.reservations);
    return new Response(JSON.stringify(input.reply ?? REPLY), { headers: { 'content-type': 'application/json' } });
  });
  let admission: Admission = {
    binding: structuredClone(BINDING), apiKey: 'fixture-explicit-key',
    provider: structuredClone(POLICY), qualification: structuredClone(QUALIFICATION),
  };
  const state = input.state ?? structuredClone(STATE);
  const options: FactoryOptions = {
    binding: structuredClone(BINDING), ledger, stateDigest: digest(JSON.stringify(state)),
    resolveCurrent: async (signal) => { signal.throwIfAborted(); return structuredClone(admission); }, fetch: fake,
  };
  const transport = make(options);
  const call = (signal = new AbortController().signal, over: Partial<EvaluationPortCall> = {}) =>
    transport.port.evaluate({ state, questions: structuredClone(QUESTIONS), signal, ...over });
  return { make, dataDir, base, ledger, state, options, transport, call, seen, atDispatch, persistedAtDispatch, change: (over: Partial<Admission>) => { admission = { ...admission, ...over }; } };
}

describe('SDK evaluation money evidence', () => {
  it.each([
    { usage: { inputTokens: 96, outputTokens: 3, cost: 0.0000041 } },
    { usage: { inputTokens: 96, outputTokens: 3 }, providerMetadata: { openrouter: { usage: { cost: 0.0000041 } } } },
    { usage: { inputTokens: 96, outputTokens: 3 }, response: { body: { model: BINDING.modelId, usage: { cost: 0.0000041 } } } },
  ])('preserves the provider-reported cost wherever the installed SDK carries it', (raw) => {
    expect(normalizeSdkEvaluation(raw)).toMatchObject({ usage: { cost: 0.0000041 } });
  });
});

describe('direct root-scoped Jev transport', () => {
  it('sends the exact model, credential and policy after persisting its supplied root reservation', async () => {
    const f = await fixture();
    const raw = await f.call();
    expect(f.transport.ledger).toBe(f.ledger);
    expect(f.transport.binding).toEqual(BINDING);
    expect(f.transport.port.scripted).toBe(false);
    expect(f.transport.port.requestedModel).toBe(BINDING.modelId);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(f.seen[0].method).toBe('POST');
    expect(f.seen[0].headers.get('authorization')).toBe('Bearer fixture-explicit-key');
    expect(f.seen[0].headers.has('x-provider-api-keys')).toBe(false);
    expect(f.seen[0].body).toEqual({ model: BINDING.modelId, provider: POLICY, state: STATE, questions: { correct: { type: 'noul', instructions: QUESTIONS.correct.instructions } } });
    const bound = new TextEncoder().encode(JSON.stringify(f.seen[0].body)).byteLength + QUALIFICATION.inputFramingTokens;
    expect(bound).toBeLessThanOrEqual(5_000);
    expect(f.atDispatch).toHaveLength(1);
    expect(f.atDispatch[0]).toMatchObject({ state: 'pending', jobId: BINDING.rootJobId, route: 'openrouter', modelId: BINDING.modelId, maxMicroUsd: 210, attempt: { runId: BINDING.rootRunId, stepId: BINDING.stepId, attempt: 1, requestDigest: digest(JSON.stringify(f.seen[0].body)) } });
    expect(f.persistedAtDispatch).toEqual(f.atDispatch);
    expect(raw).toMatchObject({ usage: { inputTokens: 96, outputTokens: 3, cost: 0.0000041 }, response: { modelId: BINDING.modelId, id: REPLY.id } });
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'settled', settledMicroUsd: 5, providerRequestId: REPLY.id, reconciledFrom: 'response' });
    expect(f.base.list(BINDING.connectionId)[0].reportedCost).toMatchObject({
      version: 1, usd: 0.0000041, microUsd: 5, reportedModel: BINDING.modelId,
      providerRequestId: REPLY.id, originalMaxMicroUsd: 210,
    });
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(5);
  });

  it('refuses an unscoped ledger instead of creating a root allowance', async () => {
    const f = await fixture();
    try { f.make({ ...f.options, ledger: f.base }); throw new Error('Unscoped transport unexpectedly admitted.'); }
    catch (error) { expect(error).toMatchObject({ code: 'invalid_transport' }); }
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('refuses a host input bound above the approved 5,000-token ceiling', async () => {
    const f = await fixture();
    try { f.make({ ...f.options, binding: { ...BINDING, maxInputTokens: 5_001 } }); throw new Error('Unbounded transport unexpectedly admitted.'); }
    catch (error) { expect(error).toMatchObject({ code: 'invalid_transport' }); }
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
  });

  it.each(['accountId', 'accountRevision', 'accountDigest', 'connectionId', 'rootJobId', 'dataPolicyDigest'] as const)('refuses changed live %s before reserving or disclosing', async (field) => {
    const f = await fixture();
    const current = { ...BINDING, [field]: field === 'accountRevision' ? 2 : `changed-${field}` };
    f.change({ binding: current });
    await expect(f.call()).rejects.toMatchObject({ code: 'invalid_transport' });
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('refuses a changed state even if it fits the byte bound', async () => {
    const f = await fixture();
    await expect(f.call(undefined, { state: { ...STATE, report: 'A different report.' } })).rejects.toMatchObject({ code: 'invalid_transport' });
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('requires current qualification and never takes the stale public card as account qualification', async () => {
    const f = await fixture();
    f.change({ qualification: null });
    await expect(f.call()).rejects.toMatchObject({ code: 'invalid_transport' });
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('refuses nonzero output pricing because the Decisions request has no proven output cap', async () => {
    const f = await fixture();
    f.change({ qualification: { ...QUALIFICATION, rateCard: { ...CARD, long: { ...CARD.long, output: 1 } } } });
    await expect(f.call()).rejects.toMatchObject({ code: 'invalid_transport' });
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('counts the complete serialized provider policy and qualified framing in the input bound', async () => {
    const f = await fixture({ state: { report: 'x'.repeat(4_200) } });
    await expect(f.call()).rejects.toMatchObject({ code: 'request_too_large' });
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('revalidates policy after SDK loading and before dispatch', async () => {
    const f = await fixture();
    const real = await import('@openrouter/ai-sdk-provider');
    const ai = await import('ai');
    const transport = f.make({ ...f.options, loadSdk: async () => {
      f.change({ provider: { ...POLICY, only: ['unapproved'] } });
      return { evaluate: ai.experimental_evaluate as OpenRouterSdk['evaluate'], createOpenRouter: real.createOpenRouter };
    } });
    await expect(transport.port.evaluate({ state: STATE, questions: QUESTIONS, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid_transport' });
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('checks the real serialized policy even when the SDK tries to replace admitted preferences', async () => {
    const f = await fixture();
    const real = await import('@openrouter/ai-sdk-provider');
    const ai = await import('ai');
    const transport = f.make({ ...f.options, loadSdk: async () => ({
      createOpenRouter: real.createOpenRouter,
      evaluate: ((input) => ai.experimental_evaluate({ ...input, providerOptions: { openrouter: { provider: { ...POLICY, data_collection: 'allow' } } } } as Parameters<typeof ai.experimental_evaluate>[0])) as OpenRouterSdk['evaluate'],
    }) });
    await expect(transport.port.evaluate({ state: STATE, questions: QUESTIONS, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid_transport' });
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('uses the shared root exposure already consumed by other roles', async () => {
    const f = await fixture({ cap: 400 });
    await f.base.setCap('other-role', micro(10_000), { approvedBy: 'fixture-owner', note: 'Fixture only.' });
    await f.ledger.reserve({ connectionId: 'other-role', route: CARD.route, modelId: CARD.modelId, card: CARD, attempt: { runId: BINDING.rootRunId, stepId: 'team-response', attempt: 1, requestDigest: 'c'.repeat(64) }, maxMicroUsd: micro(201) });
    await expect(f.call()).rejects.toMatchObject({ code: 'job_cap_reached', jobId: BINDING.rootJobId });
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(201);
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.seen).toHaveLength(0);
  });

  it('refuses a call above its immutable run allocation despite unused root funds', async () => {
    const f = await fixture();
    await f.ledger.limitRunBudget(BINDING.rootRunId, micro(200), BINDING.rootJobId);
    await f.ledger.limitRunBudget(BINDING.rootRunId, micro(200), BINDING.rootJobId);
    await expect(f.ledger.limitRunBudget(BINDING.rootRunId, micro(201), BINDING.rootJobId)).rejects.toMatchObject({ code: 'run_budget_changed' });
    await expect(f.base.limitRunBudget(BINDING.rootRunId, micro(200), BINDING.rootJobId)).rejects.toMatchObject({ code: 'invalid_job' });
    await expect(f.ledger.limitRunBudget('other-run', micro(200), `job-${'f'.repeat(40)}`)).rejects.toMatchObject({ code: 'invalid_job' });
    await expect(f.ledger.limitRunBudget('other-run', micro(10_001), BINDING.rootJobId)).rejects.toMatchObject({ code: 'invalid_run_budget' });
    await expect(f.call()).rejects.toMatchObject({ code: 'run_budget_reached', jobId: BINDING.rootJobId,
      runId: BINDING.rootRunId, usedMicroUsd: 0, capMicroUsd: 200, neededMicroUsd: 210 });
    expect(f.seen).toHaveLength(0);
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(0);
  });

  it('counts an unknown hold on another connection against the same run allocation after rebinding', async () => {
    const f = await fixture();
    await f.base.setCap('other-role', micro(10_000), { approvedBy: 'fixture-owner', note: 'Fixture only.' });
    const hold = await f.ledger.reserve({ connectionId: 'other-role', route: CARD.route, modelId: CARD.modelId, card: CARD,
      attempt: { runId: BINDING.rootRunId, stepId: 'earlier-worker-call', attempt: 1, requestDigest: 'c'.repeat(64) }, maxMicroUsd: micro(100) });
    await f.ledger.markUncertain(hold.id, 'Synthetic unknown worker charge.');
    await f.ledger.limitRunBudget(BINDING.rootRunId, micro(300), BINDING.rootJobId);
    await expect(f.call()).rejects.toMatchObject({ code: 'run_budget_reached', usedMicroUsd: 100, capMicroUsd: 300, neededMicroUsd: 310 });
    expect(f.seen).toHaveLength(0);
    expect(f.base.get(hold.id)).toMatchObject({ state: 'uncertain', maxMicroUsd: 100, settledMicroUsd: null });
    const reopened = new SpendExposure(f.dataDir); await reopened.init();
    const scoped = reopened.forJob({ id: BINDING.rootJobId, capMicroUsd: micro(10_000) });
    await scoped.limitRunBudget(BINDING.rootRunId, micro(300), BINDING.rootJobId);
    const transport = f.make({ ...f.options, ledger: scoped });
    await expect(transport.port.evaluate({ state: STATE, questions: QUESTIONS, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'run_budget_reached', usedMicroUsd: 100, capMicroUsd: 300, neededMicroUsd: 310 });
    expect(f.seen).toHaveLength(0);
    expect(reopened.jobUsed(BINDING.rootJobId)).toBe(100);
    expect(reopened.get(hold.id)?.state).toBe('uncertain');
  });

  it('refuses a second attempt after a settled call even through a new descriptor and changed question', async () => {
    const f = await fixture();
    await f.call();
    const other = f.make(f.options);
    await expect(other.port.evaluate({ state: STATE, questions: { correct: { ...QUESTIONS.correct, instructions: 'Ask a second question.' } }, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'attempt_exists' });
    expect(f.seen).toHaveLength(1);
    expect(f.base.list(BINDING.connectionId)).toHaveLength(1);
  });

  it('admits one of two concurrent descriptors with different request bytes under the same root step', async () => {
    const f = await fixture(); const other = f.make(f.options);
    const results = await Promise.allSettled([
      f.call(), other.port.evaluate({ state: STATE, questions: { correct: { ...QUESTIONS.correct, instructions: 'A different question.' } }, signal: new AbortController().signal }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'attempt_exists' });
    expect(f.seen).toHaveLength(1);
    expect(f.base.list(BINDING.connectionId)).toHaveLength(1);
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(5);
  });

  it('releases only a provably unsent hold when policy changes while the reservation is persisted', async () => {
    const f = await fixture();
    const transport = f.make({ ...f.options, resolveCurrent: async signal => {
      const admitted = await f.options.resolveCurrent(signal);
      return f.base.list(BINDING.connectionId).length
        ? { ...admitted, provider: { ...POLICY, only: ['unapproved'] } } : admitted;
    } });
    const call = () => transport.port.evaluate({ state: STATE, questions: QUESTIONS, signal: new AbortController().signal });
    await expect(call()).rejects.toMatchObject({ code: 'invalid_transport' });
    expect(f.seen).toHaveLength(0);
    expect(f.base.list(BINDING.connectionId)).toMatchObject([{ state: 'released', settledMicroUsd: null }]);
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(0);
    await expect(f.call()).rejects.toMatchObject({ code: 'attempt_exists' });
    expect(f.seen).toHaveLength(0);
  });

  it('refuses a cancelled call before reserving or loading its SDK', async () => {
    const f = await fixture(); const loadSdk = vi.fn(async () => { throw new Error('An aborted review loaded the SDK.'); });
    const transport = f.make({ ...f.options, loadSdk });
    const controller = new AbortController(); controller.abort(new Error('Synthetic Stop.'));
    await expect(transport.port.evaluate({ state: STATE, questions: QUESTIONS, signal: controller.signal })).rejects.toThrow('Synthetic Stop.');
    expect(loadSdk).not.toHaveBeenCalled();
    expect(f.seen).toHaveLength(0);
    expect(f.base.list(BINDING.connectionId)).toHaveLength(0);
  });

  it('makes one SDK attempt on a retryable provider failure and retains the uncertain ceiling', async () => {
    let sends = 0;
    const f = await fixture({ fetch: async () => { sends++; return new Response(JSON.stringify({ error: { message: 'Fixture busy.' } }), { status: 503, headers: { 'content-type': 'application/json' } }); } });
    await expect(f.call()).rejects.toBeTruthy();
    expect(sends).toBe(1);
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'uncertain', maxMicroUsd: 210, settledMicroUsd: null });
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(210);
    await expect(f.call()).rejects.toMatchObject({ code: 'attempt_exists' });
    expect(sends).toBe(1);
  });

  it('retains the hold on unknown usage even though an answer arrived', async () => {
    const f = await fixture({ reply: { ...REPLY, usage: undefined } });
    await f.call();
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'uncertain', settledMicroUsd: null });
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(210);
    expect(f.base.list(BINDING.connectionId)[0].reportedCost).toBeUndefined();
  });

  it.each([-1, '0', null])('never treats invalid provider cost %s as a zero charge', async cost => {
    const f = await fixture({ reply: { ...REPLY, usage: { cost } } });
    await f.call().catch(() => undefined); // SDK shape refusal is also a charged/unknown attempt.
    expect(f.seen).toHaveLength(1);
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'uncertain', settledMicroUsd: null });
    expect(f.base.list(BINDING.connectionId)[0].reportedCost).toBeUndefined();
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(210);
  });

  it('keeps a charged response receipt when the SDK refuses its malformed answer', async () => {
    const f = await fixture({ reply: { ...REPLY, answers: {} } });
    await expect(f.call()).rejects.toBeTruthy();
    expect(f.seen).toHaveLength(1);
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({
      state: 'settled', settledMicroUsd: 5,
      reportedCost: { usd: 0.0000041, microUsd: 5, reportedModel: BINDING.modelId, providerRequestId: REPLY.id },
    });
  });

  it('does not price a different answering model under the requested model card', async () => {
    const f = await fixture({ reply: { ...REPLY, model: 'typesafe/other-model' } });
    const raw = await f.call();
    expect(raw).toMatchObject({ response: { modelId: 'typesafe/other-model', id: REPLY.id }, usage: { cost: REPLY.usage.cost } });
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'uncertain', settledMicroUsd: null });
  });

  it('preserves a real zero cost and records reported cost above the ceiling honestly', async () => {
    const zero = await fixture({ reply: { ...REPLY, usage: { cost: 0 } } });
    await zero.call();
    expect(zero.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'settled', settledMicroUsd: 0 });
    expect(zero.base.list(BINDING.connectionId)[0].reportedCost).toMatchObject({ usd: 0, microUsd: 0 });
    const over = await fixture({ reply: { ...REPLY, usage: { cost: 0.01 } } });
    await over.call();
    expect(over.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'settled', settledMicroUsd: 10_000, overCeiling: true });
  });

  it.each(['reconcile', 'writeOff'] as const)('preserves the original wrong-model monetary receipt through %s and reopen', async method => {
    const f = await fixture({ reply: { ...REPLY, model: 'typesafe/other-model', usage: { cost: 0.01 } } });
    await f.call();
    const original = f.base.list(BINDING.connectionId)[0];
    expect(original).toMatchObject({ state: 'uncertain', maxMicroUsd: 10_000, overCeiling: true,
      reportedCost: { usd: 0.01, microUsd: 10_000, reportedModel: 'typesafe/other-model', originalMaxMicroUsd: 210 } });
    if (method === 'reconcile') await f.ledger.reconcile(original.id, { microUsd: micro(5), note: 'Explicit owner billing reconciliation fixture.' });
    else await f.ledger.writeOff(original.id, { note: 'Explicit owner write-off fixture.' });
    const updated = f.base.get(original.id)!;
    expect(updated.reportedCost).toEqual(original.reportedCost);
    expect(updated.overCeiling).toBe(true);
    expect(updated.note).not.toEqual(original.note);
    const reopened = new SpendExposure(f.dataDir); await reopened.init();
    expect(reopened.get(original.id)?.reportedCost).toEqual(original.reportedCost);
    expect(reopened.get(original.id)?.overCeiling).toBe(true);
    expect(f.seen).toHaveLength(1);
  });

  it('aborts a nonstreaming call promptly and ignores a late answer for settlement', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let reply!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { reply = resolve; });
    const f = await fixture({ fetch: async () => { entered(); return response; } });
    const controller = new AbortController();
    const result = f.call(controller.signal);
    const rejected = expect(result).rejects.toBeTruthy();
    await started;
    controller.abort(new Error('Fixture Stop.'));
    await rejected;
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'uncertain', settledMicroUsd: null });
    reply(new Response(JSON.stringify(REPLY), { headers: { 'content-type': 'application/json' } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.base.list(BINDING.connectionId)[0]).toMatchObject({ state: 'uncertain', settledMicroUsd: null });
    expect(f.base.jobUsed(BINDING.rootJobId)).toBe(210);
  });
});

describe('checked direct dollar settlement on the existing root hold', () => {
  it('checks root job, reserved card and monetary amount before changing a hold', async () => {
    const f = await fixture();
    const hold = await f.ledger.reserve({ connectionId: BINDING.connectionId, route: CARD.route, modelId: CARD.modelId, card: CARD, attempt: { runId: BINDING.rootRunId, stepId: 'settlement-check', attempt: 1, requestDigest: 'd'.repeat(64) }, maxMicroUsd: ceilingCost(CARD, { maxInputTokens: 5_000, maxOutputTokens: 0 }) });
    type Settle = (id: string, input: { jobId: string; microUsd: number; card: ModelRateCard; providerRequestId: string | null }) => Promise<ExposureReservation>;
    const settle = (f.ledger as unknown as { settleReportedCost?: Settle }).settleReportedCost;
    expect(settle, 'Provider dollar cost needs a checked settlement on its original hold.').toBeTypeOf('function');
    const valid = { jobId: BINDING.rootJobId, microUsd: 5, card: CARD, providerRequestId: REPLY.id };
    await expect(settle!(hold.id, { ...valid, jobId: `job-${'f'.repeat(40)}` })).rejects.toMatchObject({ code: 'invalid_job' });
    await expect(settle!(hold.id, { ...valid, card: { ...CARD, version: 'changed' } })).rejects.toMatchObject({ code: 'rate_card_changed' });
    await expect(settle!(hold.id, { ...valid, microUsd: -1 })).rejects.toMatchObject({ code: 'invalid_amount' });
    expect(f.base.get(hold.id)).toMatchObject({ state: 'pending', settledMicroUsd: null });
    await settle!(hold.id, valid);
    expect(f.base.get(hold.id)).toMatchObject({ state: 'settled', settledMicroUsd: 5, usage: null, jobId: BINDING.rootJobId, providerRequestId: REPLY.id });
    await expect(settle!(hold.id, valid)).rejects.toMatchObject({ code: 'illegal_transition' });
  });
});
