/**
 * PH-02: the PostHog transport, the exporter's retries, backoff, circuit, budget and funding, and
 * late cost from the real spend ledger. A fake fetch and a virtual clock; nothing leaves.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdmittedAgentWork } from '../server/accounts/agent-gate.js';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock.js';
import { exposureStepId } from '../server/harness/model-api-adapter.js';
import type { ObservationOperatorConfig, ObservationScope, ScopeRecheck } from '../server/observability/eligibility.js';
import { BoundedObservationExporter, EXPORTER_LIMITS, type ExportGate, type ScopeRecheckPort } from '../server/observability/exporter.js';
import { PostHogTransport, parseRetryAfter, withApiKey } from '../server/observability/posthog-transport.js';
import { ObservationProjector } from '../server/observability/projector.js';
import { spanIdFor, traceIdFor, uuidFor } from '../server/observability/sanitize.js';
import { ObservationScopes } from '../server/observability/scopes.js';
import { encodeBatch, toWireEvent, type PostHogWireEvent } from '../server/observability/wire.js';
import { SpendExposure, type ModelRateCard } from '../server/spend-exposure.js';
import { VENDOR_ALLOWLIST } from '../services/control-plane/contract/vendors.js';
import type { HarnessEvent, HarnessRun, StepRecord } from '../shared/harness.js';
import { micro } from '../shared/managed-usage.js';
import type { ParkedObservation, ScopeFacts } from '../shared/observability.js';

const KEY = 'phc_testOnlyNotAKey';
const HOST = 'https://posthog.invalid';
const DAY = Date.UTC(2026, 8, 25, 12, 0, 0);

const facts: ScopeFacts = {
  class: 'internal',
  synthetic: false,
  sourceTrust: 'company-host',
  environment: 'test',
  organizationKey: `oorg_${'b'.repeat(32)}`,
  admissionId: 'adm_0123456789abcdef',
  surface: 'conversation',
  route: 'aws-bedrock',
  payer: 'byo',
  plan: 'business',
  policyRevision: 1,
  telemetryRevision: null,
};
const scope: ObservationScope = {
  scopeId: 'osc_a',
  facts,
  organizationId: 'org_a',
  personId: 'person_1',
  activeOrganizationAtBind: 'org_a',
  bindKey: 'conversation:a',
  connectionId: 'conn-1',
  requestedModel: null,
  boundAt: 0,
};
const parked = (index: number): ParkedObservation => ({
  kind: 'parked',
  contract: 'nectovia-observation/1',
  ids: { uuid: uuidFor('test', `p${index}`), traceId: traceIdFor('test', 'r'), spanId: spanIdFor('test', `r|${index}`), parentId: traceIdFor('test', 'r'), sessionId: null },
  at: new Date(DAY + index).toISOString(),
  scope: facts,
  build: '0.1.12',
  capability: 'model-api-turn',
  stepKind: 'model',
});

type Answer = { status: number; headers?: Record<string, string> } | 'throw' | 'hang';
function fakeFetch(answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    if (answer === 'throw') throw new TypeError('fetch failed');
    if (answer === 'hang')
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    // A 204 or 304 carries no body.
    return new Response(answer.status === 204 ? null : '{"status":1}', { status: answer.status, headers: answer.headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function exporterWith(answers: Answer[], options: { gate?: ExportGate | null; live?: () => boolean } = {}) {
  let now = DAY;
  const { fetch, calls } = fakeFetch(answers);
  const scopes: ScopeRecheckPort = {
    recheck: (): ScopeRecheck => ((options.live ?? (() => true))() ? { live: true } : { live: false, denial: 'signed-out' }),
    denials: () => ({}),
  };
  const exporter = new BoundedObservationExporter({
    sink: new PostHogTransport({ host: HOST, captureKey: KEY, fetch, now: () => now }),
    scopes,
    clock: () => now,
    timer: false,
    random: () => 0,
    gate: options.gate === undefined ? { fundedUntil: '2026-12-31', dailyEvents: 10_000 } : options.gate,
  });
  return { exporter, calls, advance: (ms: number) => (now += ms), at: () => now };
}

describe('the transport', () => {
  test('the key is added at send, first, byte-equal to JSON.stringify({ api_key, batch })', () => {
    const events = [toWireEvent(parked(0)), toWireEvent(parked(1))];
    expect(withApiKey(encodeBatch(events), KEY)).toBe(JSON.stringify({ api_key: KEY, batch: events }));
    expect(() => withApiKey('[1]', KEY)).toThrow();
  });

  test('one POST to /batch/ on the configured https origin; redirects refused; the answer is classified, never read', async () => {
    const answers: [Answer, unknown][] = [
      [{ status: 200 }, { ok: true }],
      [{ status: 204 }, { ok: true }],
      [{ status: 429, headers: { 'retry-after': '2' } }, { ok: false, failure: 'http-429', retryAfterMs: 2_000 }],
      [{ status: 429, headers: { 'retry-after': new Date(DAY + 7_000).toUTCString() } }, { ok: false, failure: 'http-429', retryAfterMs: 7_000 }],
      [{ status: 503 }, { ok: false, failure: 'http-5xx', retryAfterMs: null }],
      [{ status: 400 }, { ok: false, failure: 'http-4xx', retryAfterMs: null }],
      [{ status: 401 }, { ok: false, failure: 'http-4xx', retryAfterMs: null }],
      ['throw', { ok: false, failure: 'network', retryAfterMs: null }],
    ];
    for (const [answer, expected] of answers) {
      const { fetch, calls } = fakeFetch([answer]);
      const transport = new PostHogTransport({ host: `${HOST}/`, captureKey: KEY, fetch, now: () => DAY });
      const body = encodeBatch([toWireEvent(parked(0))]);
      expect(await transport.send(body, new AbortController().signal)).toEqual(expected);
      expect(calls[0].url).toBe(`${HOST}/batch/`);
      expect(calls[0].init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ api_key: KEY, batch: [toWireEvent(parked(0))] });
    }
    const aborted = new AbortController();
    aborted.abort();
    const { fetch } = fakeFetch(['throw']);
    expect(await new PostHogTransport({ host: HOST, captureKey: KEY, fetch }).send('{"batch":[]}', aborted.signal)).toMatchObject({ failure: 'timeout' });
    expect(() => new PostHogTransport({ host: 'http://posthog.invalid', captureKey: KEY })).toThrow();
    expect(parseRetryAfter('soon', DAY)).toBeNull();
    expect(parseRetryAfter('1e9', DAY)).toBeNull();
  });
});

describe('the exporter over the transport', () => {
  test('a failed batch waits its backoff, then goes before anything newer; three sends at most', async () => {
    const { exporter, calls, advance } = exporterWith([{ status: 503 }, { status: 200 }]);
    exporter.enqueue(parked(0), scope);
    await exporter.flush();
    expect(calls).toHaveLength(1);
    exporter.enqueue(parked(1), scope);
    // The jitter is fixed at 0.5: the first backoff is 500 ms.
    advance(499);
    await exporter.flush();
    expect(calls).toHaveLength(1);
    advance(1);
    await exporter.flush();
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[1].init.body)).batch.map((event: PostHogWireEvent) => event.uuid)).toEqual([uuidFor('test', 'p0')]);
    expect(exporter.health()).toMatchObject({ exported: 2, queued: 0, lastFailure: 'http-5xx' });

    const exhausted = exporterWith([{ status: 500 }]);
    exhausted.exporter.enqueue(parked(0), scope);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await exhausted.exporter.flush();
      exhausted.advance(EXPORTER_LIMITS.backoffCapMs);
    }
    expect(exhausted.calls).toHaveLength(3);
    expect(exhausted.exporter.health().dropped['retries-exhausted']).toBe(1);
  });

  test('a 4xx is rejected at once; Retry-After is honoured up to 60 s and a longer one drops the batch', async () => {
    const rejected = exporterWith([{ status: 400 }]);
    rejected.exporter.enqueue(parked(0), scope);
    await rejected.exporter.flush();
    rejected.advance(60_000);
    await rejected.exporter.flush();
    expect(rejected.calls).toHaveLength(1);
    expect(rejected.exporter.health().dropped.rejected).toBe(1);

    const honoured = exporterWith([{ status: 429, headers: { 'retry-after': '10' } }, { status: 200 }]);
    honoured.exporter.enqueue(parked(0), scope);
    await honoured.exporter.flush();
    honoured.advance(9_999);
    await honoured.exporter.flush();
    expect(honoured.calls).toHaveLength(1);
    honoured.advance(1);
    await honoured.exporter.flush();
    expect(honoured.calls).toHaveLength(2);
    expect(honoured.exporter.health().exported).toBe(1);

    const tooLong = exporterWith([{ status: 429, headers: { 'retry-after': '61' } }]);
    tooLong.exporter.enqueue(parked(0), scope);
    await tooLong.exporter.flush();
    expect(tooLong.exporter.health().dropped['retry-after-too-long']).toBe(1);
  });

  test('three failed sends in a row pause export for five minutes; the queue stays bounded meanwhile', async () => {
    const { exporter, calls, advance } = exporterWith([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 }]);
    exporter.enqueue(parked(0), scope);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await exporter.flush();
      advance(EXPORTER_LIMITS.backoffCapMs);
    }
    expect(calls).toHaveLength(3);
    expect(exporter.health().state).toBe('paused');
    exporter.enqueue(parked(1), scope);
    await exporter.flush();
    expect(calls).toHaveLength(3);
    advance(EXPORTER_LIMITS.pauseMs);
    await exporter.flush();
    expect(calls).toHaveLength(4);
    expect(exporter.health()).toMatchObject({ state: 'exporting', exported: 1 });
  });

  test('a send that hangs times out at the deadline and is retried', async () => {
    const { exporter, calls, advance } = exporterWith(['hang', { status: 200 }]);
    exporter.enqueue(parked(0), scope);
    await exporter.flush(30);
    expect(exporter.health().lastFailure).toBe('timeout');
    advance(1_000);
    await exporter.flush();
    expect(calls).toHaveLength(2);
    expect(exporter.health().exported).toBe(1);
  });

  test('the daily budget: zero, the default, sends nothing; a small one sends that many and drops the rest; the next UTC day starts again', async () => {
    const none = exporterWith([{ status: 200 }], { gate: { fundedUntil: '2026-12-31', dailyEvents: 0 } });
    none.exporter.enqueue(parked(0), scope);
    await none.exporter.flush();
    expect(none.calls).toHaveLength(0);
    expect(none.exporter.health()).toMatchObject({ state: 'disabled:budget', dropped: { budget: 1 } });

    const two = exporterWith([{ status: 200 }], { gate: { fundedUntil: '2026-12-31', dailyEvents: 2 } });
    for (let index = 0; index < 3; index += 1) two.exporter.enqueue(parked(index), scope);
    await two.exporter.flush();
    expect(two.calls).toHaveLength(1);
    expect(JSON.parse(String(two.calls[0].init.body)).batch).toHaveLength(2);
    expect(two.exporter.health()).toMatchObject({ exported: 2, queued: 0, state: 'disabled:budget', dropped: { budget: 1 } });
    two.exporter.enqueue(parked(3), scope);
    expect(two.exporter.health().dropped.budget).toBe(2);
    two.advance(86_400_000);
    two.exporter.enqueue(parked(4), scope);
    await two.exporter.flush();
    expect(two.calls).toHaveLength(2);
  });

  test('funding: none or past sends nothing and keeps nothing; it ends at the close of its last day', async () => {
    for (const fundedUntil of [null, '2026-09-01', 'next year']) {
      const unfunded = exporterWith([{ status: 200 }], { gate: { fundedUntil, dailyEvents: 1_000 } });
      unfunded.exporter.enqueue(parked(0), scope);
      await unfunded.exporter.flush();
      expect(unfunded.calls, String(fundedUntil)).toHaveLength(0);
      expect(unfunded.exporter.health()).toMatchObject({ state: 'disabled:funding', queued: 0, dropped: { funding: 1 } });
    }
    const today = exporterWith([{ status: 200 }], { gate: { fundedUntil: '2026-09-25', dailyEvents: 1_000 } });
    // 23:00 UTC on the last funded day: still funded.
    today.advance(11 * 3_600_000);
    today.exporter.enqueue(parked(0), scope);
    await today.exporter.flush();
    expect(today.calls).toHaveLength(1);
    today.exporter.enqueue(parked(1), scope);
    today.advance(3_600_000);
    await today.exporter.flush();
    expect(today.calls).toHaveLength(1);
    expect(today.exporter.health()).toMatchObject({ state: 'disabled:funding', dropped: { funding: 1 } });
  });

  test('a scope that ends while its batch waits to be retried is dropped, not resent', async () => {
    let live = true;
    const { exporter, calls, advance } = exporterWith([{ status: 503 }, { status: 200 }], { live: () => live });
    exporter.enqueue(parked(0), scope);
    await exporter.flush();
    live = false;
    advance(EXPORTER_LIMITS.backoffCapMs);
    await exporter.flush();
    expect(calls).toHaveLength(1);
    expect(exporter.health()).toMatchObject({ queued: 0, dropped: { 'scope-ended': 1 } });
  });
});

describe('late cost from the real spend ledger', () => {
  const CARD: ModelRateCard = {
    version: 'aws-bedrock-luna-2026-09-21.1',
    route: 'aws-bedrock',
    modelId: AWS_LUNA_MODEL,
    source: 'Invented test figures in the shape of a provider price list.',
    shortContextMaxInputTokens: 272_000,
    short: { input: 220_000, cacheWrite: 275_000, cacheRead: 22_000, output: 1_320_000 },
    long: { input: 440_000, cacheWrite: 550_000, cacheRead: 44_000, output: 1_980_000 },
  };
  const operator: ObservationOperatorConfig = {
    mode: 'memory',
    environment: 'test',
    companyHost: true,
    internalOrganizations: new Set(['org_a']),
    pseudonymKey: new Uint8Array(32).fill(3),
    customerExport: false,
    posthog: null,
  };
  let dir = '';
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'observation-late-cost-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    const ledger = new SpendExposure(dir);
    await ledger.init();
    await ledger.setCap('conn-1', micro(1_000_000), { approvedBy: 'owner@example.test', note: 'Test cap.' });
    const scopes = new ObservationScopes({
      operator,
      backend: () => 'faux',
      authority: { personId: () => 'person_1', activeOrganizationId: () => 'org_a', entitlement: () => ({ agent: true, state: 'active' }) },
      now: () => 0,
    });
    const seen: PostHogWireEvent[] = [];
    const projector = new ObservationProjector({
      scopes,
      exporter: {
        enqueue: (observation) => seen.push(toWireEvent(observation)),
        flush: async () => {},
        discard: () => 0,
        health: () => ({}) as never,
        close: async () => {},
      },
      build: '0.1.12',
    });
    projector.attachLedger(ledger);
    const admission: AdmittedAgentWork = {
      admissionId: 'adm_0123456789abcdef',
      organizationId: 'org_a',
      personId: 'person_1',
      planId: 'business',
      policyRevision: 1,
      routeKind: 'byo',
      surface: 'conversation',
      validUntil: '2026-09-25T13:00:00.000Z',
    };
    // Each message is its own job: a conversation turn admits under its own turn run's id.
    for (const rootJobId of ['turn-1', 'turn-2'])
      scopes.bind({ admission, rootJobId, route: 'aws-bedrock', connectionId: 'conn-1', model: AWS_LUNA_MODEL });
    return { ledger, projector, seen };
  }
  const request = (text: string) => ({ messages: [{ role: 'user', text }] });
  const hold = (ledger: SpendExposure, text: string, runId = 'turn-1') =>
    ledger.reserve({
      connectionId: 'conn-1',
      route: CARD.route,
      modelId: CARD.modelId,
      card: CARD,
      attempt: { runId, stepId: exposureStepId(request(text) as never), attempt: 1, requestDigest: createHash('sha256').update(text).digest('hex') },
      maxMicroUsd: micro(100_000),
    });
  const turn = (text: string, state: StepRecord['state'], at: number, runId = 'turn-1'): HarnessRun => {
    const events: HarnessEvent[] = [
      { v: 1, seq: 1, runId, at: new Date(at).toISOString(), type: 'step.started', stepId: 'model:0', attempt: 1, attributes: {} },
      { v: 1, seq: 2, runId, at: new Date(at + 10).toISOString(), type: `step.${state}`, stepId: 'model:0', attempt: 1, attributes: {} },
    ];
    return {
      id: runId,
      capabilityId: 'model-api-turn',
      input: { conversationRunId: 'lineage-1' },
      state: state === 'succeeded' ? 'running' : 'reconcile_required',
      steps: [
        {
          intent: { stepId: 'model:0', kind: 'model', name: 'aws-bedrock', input: { provider: 'aws-bedrock', request: request(text) } },
          attempt: 1,
          state,
          output: state === 'succeeded' ? { response: { type: 'final', text: 'x' } } : null,
        },
      ],
      events,
      lastSeq: 2,
      sessionId: null,
      createdAt: new Date(at).toISOString(),
    } as unknown as HarnessRun;
  };
  const settleTurn = () => new Promise((resolve) => setImmediate(resolve));

  test('an uncertain hold reconciled later: one nectovia_cost_reconciled on the generation’s span, after the write, never a second generation', async () => {
    const { ledger, projector, seen } = await setup();
    const open = await hold(ledger, 'lost call');
    await ledger.markUncertain(open.id, 'The connection dropped mid-response.');
    projector.onRunSaved(turn('lost call', 'reconcile_required', DAY));
    const generation = seen.find((event) => event.event === '$ai_generation')!;
    expect(generation.properties).toMatchObject({ nectovia_cost_state: 'uncertain', nectovia_outcome: 'unknown-outcome' });
    expect(generation.properties).not.toHaveProperty('$ai_total_cost_usd');

    await ledger.reconcile(open.id, { microUsd: micro(1_234), note: 'From the provider bill.' });
    // The listener runs on a later turn, outside the ledger's queue.
    expect(seen.filter((event) => event.event === 'nectovia_cost_reconciled')).toHaveLength(0);
    await settleTurn();
    const late = seen.filter((event) => event.event === 'nectovia_cost_reconciled');
    expect(late).toHaveLength(1);
    expect(late[0].properties).toMatchObject({
      nectovia_generation_span_id: generation.properties.$ai_span_id,
      $ai_trace_id: generation.properties.$ai_trace_id,
      nectovia_reconciled_from: 'owner-entry',
      nectovia_cost_state: 'settled',
      nectovia_cost_micro_usd: 1_234,
      $ai_total_cost_usd: 0.001234,
    });
    expect(JSON.stringify(late)).not.toContain('From the provider bill');
    expect(seen.filter((event) => event.event === '$ai_generation')).toHaveLength(1);
  });

  test('a write-off counts the ceiling; a hold that settled before its generation sends no late event', async () => {
    const { ledger, projector, seen } = await setup();
    const lost = await hold(ledger, 'written off');
    await ledger.markUncertain(lost.id, 'No response within the timeout.');
    projector.onRunSaved(turn('written off', 'reconcile_required', DAY));
    await ledger.writeOff(lost.id, { note: 'Nobody can price it.' });
    await settleTurn();
    expect(seen.find((event) => event.event === 'nectovia_cost_reconciled')!.properties).toMatchObject({
      nectovia_reconciled_from: 'write-off',
      nectovia_cost_state: 'written-off',
      nectovia_cost_micro_usd: 100_000,
    });

    const before = seen.length;
    const normal = await hold(ledger, 'answered', 'turn-2');
    await ledger.settle(normal.id, { usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 }, card: CARD, providerRequestId: null });
    await settleTurn();
    projector.onRunSaved(turn('answered', 'succeeded', DAY + 1_000, 'turn-2'));
    const added = seen.slice(before);
    expect(added.map((event) => event.event)).toEqual(['$ai_generation']);
    expect(added[0].properties).toMatchObject({ nectovia_cost_state: 'settled', $ai_input_tokens: 100 });
  });
});

describe('the vendor record', () => {
  test('PostHog is admitted for observability at zero fixed spend, unverified, with dated primary sources', () => {
    const posthog = VENDOR_ALLOWLIST.find((vendor) => vendor.vendor === 'posthog')!;
    expect(posthog).toMatchObject({ role: 'observability', selected: true, monthlyFixedMicroUsd: 0, accountState: 'unverified' });
    expect(posthog.limits.join(' ')).toMatch(/100,000/);
    for (const source of posthog.sources) expect(source.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
