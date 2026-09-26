/**
 * PH-01: the exporter's bounded queue with the memory sink. A virtual clock; no timers; no network.
 */
import { describe, expect, test } from 'vitest';
import type { ObservationScope, ScopeRecheck } from '../server/observability/eligibility.js';
import {
  BoundedObservationExporter,
  EXPORTER_LIMITS,
  MemoryObservationSink,
  NoopObservationExporter,
  type ObservationSink,
  type ScopeRecheckPort,
} from '../server/observability/exporter.js';
import { spanIdFor, traceIdFor, uuidFor } from '../server/observability/sanitize.js';
import { encodeBatch, toWireEvent } from '../server/observability/wire.js';
import { known, unknown, type ParkedObservation, type ScopeFacts } from '../shared/observability.js';

const facts: ScopeFacts = {
  class: 'internal-synthetic',
  synthetic: true,
  sourceTrust: 'company-host',
  environment: 'test',
  organizationKey: `oorg_${'a'.repeat(32)}`,
  admissionId: 'adm_0123456789abcdef',
  surface: 'loop',
  route: 'aws-bedrock',
  payer: 'byo',
  plan: 'business',
  policyRevision: 1,
  telemetryRevision: null,
};
const scopeNamed = (name: string): ObservationScope => ({
  scopeId: `osc_${name}`,
  facts,
  organizationId: 'org_a',
  personId: 'person_1',
  activeOrganizationAtBind: 'org_a',
  bindKey: `loop:${name}`,
  connectionId: 'conn-1',
  requestedModel: null,
  boundAt: 0,
});
const parked = (index: number): ParkedObservation => ({
  kind: 'parked',
  contract: 'nectovia-observation/1',
  ids: { uuid: uuidFor('test', `p${index}`), traceId: traceIdFor('test', 'r'), spanId: spanIdFor('test', `r|${index}`), parentId: traceIdFor('test', 'r'), sessionId: null },
  at: new Date(Date.UTC(2026, 8, 25) + index).toISOString(),
  scope: facts,
  build: '0.1.12',
  capability: 'diomedes-loop',
  stepKind: 'model',
});

function setup(options: { live?: (scope: ObservationScope) => boolean; limits?: Partial<typeof EXPORTER_LIMITS>; sink?: ObservationSink } = {}) {
  let now = 1_000;
  const sink = options.sink ?? new MemoryObservationSink();
  const scopes: ScopeRecheckPort = {
    recheck: (scope): ScopeRecheck => ((options.live ?? (() => true))(scope) ? { live: true } : { live: false, denial: 'signed-out' }),
    denials: () => ({}),
  };
  const exporter = new BoundedObservationExporter({ sink, scopes, clock: () => now, limits: options.limits, timer: false });
  return { exporter, sink: sink as MemoryObservationSink, advance: (ms: number) => (now += ms) };
}

describe('the exporter', () => {
  test('Noop records nothing and counts what it was offered', async () => {
    const noop = new NoopObservationExporter();
    noop.enqueue();
    await noop.flush();
    expect(noop.health()).toMatchObject({ state: 'off', enqueued: 0, exported: 0, queued: 0, dropped: { 'observation-off': 1 } });
  });

  test('memory keeps the exact batch bytes a transport would send, without api_key', async () => {
    const { exporter, sink } = setup();
    const scope = scopeNamed('a');
    for (let index = 0; index < 3; index += 1) exporter.enqueue(parked(index), scope);
    await exporter.flush();
    expect(sink.batches).toEqual([encodeBatch([0, 1, 2].map((index) => toWireEvent(parked(index))))]);
    expect(sink.batches[0]).not.toContain('api_key');
    expect(exporter.health()).toMatchObject({ state: 'memory', enqueued: 3, exported: 3, queued: 0, queuedBytes: 0 });
  });

  test('1,001 events: one queue-full drop, the first 1,000 intact, sent in batches of 50', async () => {
    const { exporter, sink } = setup();
    const scope = scopeNamed('a');
    for (let index = 0; index < 1_001; index += 1) exporter.enqueue(parked(index), scope);
    expect(exporter.health()).toMatchObject({ queued: 1_000, dropped: { 'queue-full': 1 } });
    await exporter.flush(60_000);
    const sent = sink.batches.flatMap((body) => (JSON.parse(body) as { batch: { uuid: string }[] }).batch);
    expect(sink.batches).toHaveLength(20);
    expect(sent.map((item) => item.uuid)).toEqual(Array.from({ length: 1_000 }, (_, index) => uuidFor('test', `p${index}`)));
  });

  test('the byte cap tail-drops; an oversized event is dropped whole, never truncated', async () => {
    const one = Buffer.byteLength(JSON.stringify(toWireEvent(parked(0))));
    const bytes = setup({ limits: { queueBytes: one * 2 + 10 } });
    for (let index = 0; index < 3; index += 1) bytes.exporter.enqueue(parked(index), scopeNamed('a'));
    expect(bytes.exporter.health()).toMatchObject({ queued: 2, dropped: { 'queue-full': 1 } });
    const small = setup({ limits: { eventBytes: one - 1 } });
    small.exporter.enqueue(parked(0), scopeNamed('a'));
    await small.exporter.flush();
    expect(small.exporter.health()).toMatchObject({ queued: 0, dropped: { oversized: 1 } });
    expect(small.sink.batches).toEqual([]);
    expect(EXPORTER_LIMITS).toMatchObject({ eventBytes: 8_192, queueEvents: 1_000, queueBytes: 8_388_608, maxAgeMs: 3_600_000, batchEvents: 50, batchBytes: 262_144 });
  });

  test('a batch is split at the byte cap', async () => {
    const one = Buffer.byteLength(JSON.stringify(toWireEvent(parked(0))));
    const { exporter, sink } = setup({ limits: { batchBytes: one * 2 + 20 } });
    for (let index = 0; index < 5; index += 1) exporter.enqueue(parked(index), scopeNamed('a'));
    await exporter.flush();
    expect(sink.batches.map((body) => (JSON.parse(body) as { batch: unknown[] }).batch.length)).toEqual([2, 2, 1]);
    for (const body of sink.batches) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(one * 2 + 20);
  });

  test('an hour in the queue expires; the clock is virtual', async () => {
    const { exporter, sink, advance } = setup();
    exporter.enqueue(parked(0), scopeNamed('a'));
    advance(EXPORTER_LIMITS.maxAgeMs + 1);
    exporter.enqueue(parked(1), scopeNamed('a'));
    await exporter.flush();
    expect(exporter.health().dropped.expired).toBe(1);
    expect(sink.batches).toEqual([encodeBatch([toWireEvent(parked(1))])]);
  });

  test('a scope that ends is dropped at enqueue, at flush, and by discard; nothing is relabelled', async () => {
    const ended = new Set<string>();
    const { exporter, sink } = setup({ live: (scope) => !ended.has(scope.scopeId) });
    const a = scopeNamed('a'),
      b = scopeNamed('b');
    exporter.enqueue(parked(0), a);
    exporter.enqueue(parked(1), b);
    ended.add(a.scopeId);
    exporter.enqueue(parked(2), a);
    expect(exporter.health().dropped['scope-ended']).toBe(1);
    await exporter.flush();
    expect(sink.batches).toEqual([encodeBatch([toWireEvent(parked(1))])]);
    expect(exporter.health().dropped['scope-ended']).toBe(2);
    exporter.enqueue(parked(3), b);
    exporter.enqueue(parked(4), b);
    expect(exporter.discard((scope) => scope === b, 'scope-ended')).toBe(2);
    expect(exporter.health().queued).toBe(0);
  });

  test('enqueue never throws: an event the wire refuses is encode-failed; health is never an event', async () => {
    const { exporter, sink } = setup();
    expect(() => exporter.enqueue({ ...parked(0), build: 'a sentence with spaces' }, scopeNamed('a'))).not.toThrow();
    expect(() => exporter.enqueue(null as never, scopeNamed('a'))).not.toThrow();
    const hostile = parked(1);
    Object.defineProperty(hostile, 'scope', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => exporter.enqueue(hostile, scopeNamed('a'))).not.toThrow();
    expect(exporter.health().dropped['encode-failed']).toBe(3);
    exporter.health();
    await exporter.flush();
    expect(sink.batches).toEqual([]);
  });

  test('a sink that hangs cannot hold a flush past its deadline', async () => {
    const hanging: ObservationSink = { kind: 'memory', send: () => new Promise(() => {}) };
    const { exporter } = setup({ sink: hanging });
    exporter.enqueue(parked(0), scopeNamed('a'));
    const started = Date.now();
    await exporter.flush(50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exporter.health()).toMatchObject({ lastFailure: 'timeout', exported: 0 });
  });

  test('close flushes what it can, drops the rest as shutdown, and refuses later events', async () => {
    const { exporter, sink } = setup();
    exporter.enqueue(parked(0), scopeNamed('a'));
    await exporter.close();
    expect(sink.batches).toHaveLength(1);
    exporter.enqueue(parked(1), scopeNamed('a'));
    expect(exporter.health().dropped.shutdown).toBe(1);
  });

  test('observations with every value unknown still encode, and carry no zero', () => {
    const wire = toWireEvent({ ...parked(0) });
    expect(Object.values(wire.properties)).not.toContain(0);
    expect(known(1)).toEqual({ known: true, value: 1 });
    expect(unknown('not-linked')).toEqual({ known: false, why: 'not-linked' });
  });
});
