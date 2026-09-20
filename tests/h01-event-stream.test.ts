/**
 * H01.I — the durable event stream contract.
 *
 * The run record's `events` are the one durable stream: monotonically
 * sequenced per run, written before presentation, replayable from any cursor.
 * A reconnecting reader asks for `seq > cursor` and a restart replays the
 * persisted record without a second provider call. `reconcile_required` is a
 * parked state, never a terminal one; an effect whose outcome is unknown is
 * not reported as finished.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CapabilityManifest,
  HarnessEvent,
  HarnessPrincipal,
} from '../shared/harness.js';
import { HARNESS_CONTRACT_VERSION } from '../shared/harness.js';
import {
  eventsAfterCursor,
  isRunEventType,
  streamIntegrity,
  terminalEvent,
} from '../shared/adapter-contract.js';
import {
  FileRunStore,
  RunService,
  type StepDefinition,
  type StepHandler,
} from '../server/harness/index.js';
import { streamChecks } from '../server/harness/conformance.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const principal: HarnessPrincipal = {
  id: 'worker',
  tenantId: 'a',
  projectId: 'p',
  capabilities: ['sum'],
  identityGeneration: 1,
};
const capability: CapabilityManifest = {
  id: 'fixture',
  version: 'v1',
  label: 'Fixture capability',
  description: 'A synthetic capability for the stream contract tests.',
  tools: ['sum'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32'],
};
const budget = { units: 20, modelCalls: 50, toolCalls: 50, wallMs: null };

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h01-stream-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = () => 1000;
  const service = new RunService(new FileRunStore(dir), { clock });
  await service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget });
  await service.claim('r', 'host', 100);
  return { service, dir };
}

const def = (overrides: Partial<StepDefinition> = {}): StepDefinition => ({
  id: 'one',
  version: '1',
  kind: 'tool',
  effect: 'pure',
  input: { x: 2 },
  cost: 1,
  ...overrides,
});
const execute = (service: RunService, d: StepDefinition, fn: StepHandler<unknown>) =>
  service.step<unknown>('r', 'host', d, fn, principal);

describe('cursor replay over the durable stream', () => {
  test('events are dense, versioned, run-bound and replayable from a cursor', async () => {
    const { service } = await setup();
    await execute(service, def(), () => ({ x: 3 }));
    const events = await service.events('r');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.v === HARNESS_CONTRACT_VERSION && e.runId === 'r')).toBe(true);
    expect(events.every((e) => isRunEventType(e.type))).toBe(true);
    // A reconnecting reader continues from its last seq, never from zero.
    const tail = await service.events('r', events[1].seq);
    expect(tail.map((e) => e.seq)).toEqual(events.slice(2).map((e) => e.seq));
    expect(eventsAfterCursor(events, events[0].seq).map((e) => e.seq)).toEqual(
      events.slice(1).map((e) => e.seq),
    );
  });

  test('a replayed step returns its persisted observation without a second handler call', async () => {
    const { service, dir } = await setup();
    let invocations = 0;
    await execute(service, def(), () => ({ value: ++invocations }));
    expect(invocations).toBe(1);
    // A second service over the same store answers from the record — the
    // handler is never invoked again, which is what "replay, don't
    // regenerate" means for a provider call.
    const restarted = new RunService(new FileRunStore(dir), { clock: () => 1000 });
    const replayed = await restarted.step<unknown>('r', 'host', def(), () => {
      invocations += 1;
      return { value: invocations };
    }, principal);
    expect(replayed).toEqual({ value: 1 });
    expect(invocations).toBe(1);
  });

  test('a restarted service parks an in-flight effect for reconciliation instead of finishing it', async () => {
    const { service, dir } = await setup();
    // A non-idempotent step whose handler never resolves stays 'running' in
    // the persisted record; the first service is abandoned without finishing.
    let handlerEntered!: () => void;
    let startFailed!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      handlerEntered = resolve;
      startFailed = reject;
    });
    const started = execute(
      service,
      def({ effect: 'non-idempotent', name: 'egress.send' }),
      () => {
        handlerEntered();
        return new Promise(() => {});
      },
    );
    started.catch(startFailed);
    // RunService persists the running step before invoking its handler.
    // Observe that boundary instead of assuming disk I/O finishes in 50 ms.
    await ready;
    const restarted = new RunService(new FileRunStore(dir), { clock: () => 2000 });
    await restarted.recover('r', principal);
    const run = await restarted.get('r');
    expect(run.state).toBe('reconcile_required');
    // reconcile_required is parked work, not an end. No terminal event exists.
    const events = await restarted.events('r');
    expect(terminalEvent(events)).toBeUndefined();
    const parked = run.steps.find((s) => s.intent.stepId === 'one');
    expect(parked?.state).toBe('reconcile_required');
    expect(events.some((e) => e.type === 'step.reconcile_required')).toBe(true);
  });
});

describe('stream integrity', () => {
  const event = (seq: number, type = 'step.started', runId = 'r'): HarnessEvent => ({
    v: 1,
    seq,
    runId,
    at: '2026-09-16T00:00:00.000Z',
    type,
    attributes: {},
  });

  test('a well-formed stream passes', async () => {
    const { service } = await setup();
    await execute(service, def(), () => 1);
    const events = await service.events('r');
    expect(streamIntegrity(events)).toEqual({ ok: true });
    const checks = streamChecks(await service.get('r'));
    expect(checks.every((c) => c.outcome === 'passed')).toBe(true);
  });

  test('a duplicated seq is rejected, not silently deduplicated', () => {
    const events = [event(1, 'run.created'), event(2), event(2, 'step.succeeded')];
    const result = streamIntegrity(events);
    expect(result.ok).toBe(false);
  });

  test('a gap in seq is rejected — replay cannot skip', () => {
    const events = [event(1, 'run.created'), event(3)];
    expect(streamIntegrity(events).ok).toBe(false);
  });

  test('an event after the terminal event is rejected', () => {
    const events = [event(1, 'run.created'), event(2, 'run.completed'), event(3, 'step.started')];
    expect(streamIntegrity(events).ok).toBe(false);
  });

  test('a foreign runId inside a stream is rejected', () => {
    const events = [event(1, 'run.created'), event(2, 'step.started', 'other-run')];
    expect(streamIntegrity(events).ok).toBe(false);
  });

  test('a stream with no terminal event is not "finished"', async () => {
    const { service } = await setup();
    const events = await service.events('r');
    expect(terminalEvent(events)).toBeUndefined();
    // The run is claimed but unfinished: transport-level receipt is never
    // treated as terminal completion.
    const checks = streamChecks(await service.get('r'));
    expect(checks.find((c) => c.id === 'single-terminal-event')?.outcome).toBe('passed');
    expect(checks.find((c) => c.id === 'terminal-only-at-end')).toBeDefined();
  });
});
