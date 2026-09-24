/**
 * H12 — recorded-effect admission. Before a typed tool with an effect runs, its
 * intent (tool, exact inputs digest, targets, idempotency key, principal,
 * authorization) is durably written in the step record RunService already
 * keeps; its outcome is recorded against it afterwards. A crash between the
 * two leaves the effect `uncertain`, and nothing re-executes it until it is
 * reconciled — by the tool's own reconciler or by a person.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CapabilityManifest, EffectRecord, HarnessPrincipal, HarnessRun, Json } from '../shared/harness.js';
import { FileRunStore, RunService, Suspended, ToolRegistry } from '../server/harness/index.js';
import { digest } from '../server/harness/policy.js';
import { uncertainEffectsOf } from '../server/harness/run-service.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: HarnessPrincipal = {
  id: 'worker',
  tenantId: 'a',
  projectId: 'p',
  capabilities: ['write-project-file', 'send-mail'],
  identityGeneration: 4,
};
const capability: CapabilityManifest = {
  id: 'h12-fixture',
  version: 'v1',
  label: 'H12 fixture',
  description: 'Synthetic typed tools for effect admission.',
  tools: ['note', 'send', 'peek'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

interface Harness {
  dir: string;
  service: RunService;
  tools: ToolRegistry;
  calls: { tool: string; input: unknown; key: string; seen: EffectRecord | undefined }[];
  sink: Map<string, string>;
  hold: { release: () => void; reached: Promise<void> } | null;
}

async function setup(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h12-effects-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const harness: Harness = { dir, service: undefined as never, tools: new ToolRegistry(), calls: [], sink: new Map(), hold: null };
  harness.service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
  const seen = async (key: string) => {
    // What the durable record held when the handler started: re-read from disk.
    const run = JSON.parse(await fs.readFile(path.join(dir, 'r.json'), 'utf8')) as HarnessRun;
    return run.steps.flatMap((step) => step.effects ?? []).find((effect) => effect.idempotencyKey === key);
  };
  const common = { version: '1', trustedInputRequired: false, cost: 0 } as const;
  harness.tools.register({
    ...common,
    name: 'note',
    description: 'Write one note to the sink.',
    effect: 'idempotent',
    effectClass: 'idempotent-write',
    permission: 'write-project-file',
    approval: false,
    destination: 'local',
    schema: z.strictObject({ path: z.string(), text: z.string() }),
    outputSchema: z.strictObject({ written: z.string() }),
    targets: (input) => [input.path],
    reconcile: async ({ record }) => (harness.sink.has(record.idempotencyKey) ? 'applied' : 'not-applied'),
    execute: async ({ input, idempotencyKey }) => {
      harness.calls.push({ tool: 'note', input, key: idempotencyKey, seen: await seen(idempotencyKey) });
      if (harness.hold) {
        const hold = harness.hold;
        await new Promise<void>((resolve) => {
          hold.release = resolve;
          (hold as { arrive?: () => void }).arrive?.();
        });
      }
      harness.sink.set(idempotencyKey, input.text);
      return { written: input.path };
    },
  });
  harness.tools.register({
    ...common,
    name: 'send',
    description: 'Send one message out.',
    effect: 'non-idempotent',
    effectClass: 'external-send',
    permission: 'send-mail',
    approval: true,
    destination: 'external',
    label: { tenantId: 'a', projectId: 'p', integrity: 'trusted', confidentiality: 'public', provenance: [] },
    schema: z.strictObject({ to: z.string(), body: z.string() }),
    outputSchema: z.strictObject({ sent: z.boolean() }),
    targets: (input) => [`mailto:${input.to}`],
    execute: async ({ input, idempotencyKey }) => {
      harness.calls.push({ tool: 'send', input, key: idempotencyKey, seen: await seen(idempotencyKey) });
      return { sent: true };
    },
  });
  harness.tools.register({
    ...common,
    name: 'peek',
    description: 'Read the sink.',
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    destination: 'local',
    schema: z.strictObject({}),
    outputSchema: z.strictObject({ size: z.number() }),
    execute: async ({ idempotencyKey }) => {
      harness.calls.push({ tool: 'peek', input: {}, key: idempotencyKey, seen: await seen(idempotencyKey) });
      return { size: harness.sink.size };
    },
  });
  await harness.service.start({
    id: 'r',
    tenantId: 'a',
    projectId: 'p',
    capability,
    principal,
    budget: { units: 50, modelCalls: 5, toolCalls: 50, wallMs: null },
    tools: harness.tools,
  });
  await harness.service.claim('r', 'host', 60_000);
  return harness;
}

const call = (h: Harness, stepId: string, name: string, input: Json, extra: { authorization?: string; owner?: string } = {}) =>
  h.tools.dispatch(h.service, { runId: 'r', owner: extra.owner ?? 'host', principal, stepId, name, input, ...extra });

/** Hold the note handler at its start, after its intent is on disk. */
function holdNote(h: Harness) {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  h.hold = { release: () => {}, reached };
  (h.hold as { arrive?: () => void }).arrive = arrive;
  return h.hold;
}

describe('the intent is durable before the handler runs', () => {
  test('a write records tool, inputs digest, targets, key, principal and authorization, then its outcome', async () => {
    const h = await setup();
    const input = { path: 'notes/a.md', text: 'hello' };
    expect(await call(h, 'w1', 'note', input)).toEqual({ written: 'notes/a.md' });
    const [first] = h.calls;
    expect(first.seen).toMatchObject({
      v: 1,
      tool: 'note',
      effectClass: 'idempotent-write',
      attempt: 1,
      inputsDigest: digest(input),
      targets: ['notes/a.md'],
      idempotencyKey: first.key,
      principalId: 'worker',
      identityGeneration: 4,
      authorization: 'permission:write-project-file',
      status: 'intended',
      outcomeAt: null,
    });
    const step = (await h.service.get('r')).steps[0];
    expect(step.effects).toHaveLength(1);
    expect(step.effects![0]).toMatchObject({ status: 'applied', outputHash: digest({ written: 'notes/a.md' }), error: null });
    const types = (await h.service.events('r')).map((event) => event.type);
    expect(types.indexOf('effect.intended')).toBeLessThan(types.indexOf('effect.applied'));
    expect(types.indexOf('step.started')).toBeLessThan(types.indexOf('effect.intended'));
  });

  test('a host grant reference and a consumed exact approval are what the record names', async () => {
    const h = await setup();
    expect(await call(h, 'w-host', 'note', { path: 'b.md', text: 'x' }, { authorization: 'grant:abc' })).toEqual({ written: 'b.md' });
    expect((await h.service.get('r')).steps[0].effects![0].authorization).toBe('host:grant:abc');
    await expect(call(h, 'mail', 'send', { to: 'a@example.com', body: 'hi' })).rejects.toBeInstanceOf(Suspended);
    expect(h.calls.filter((c) => c.tool === 'send')).toHaveLength(0);
    await h.service.decide({ runId: 'r', stepId: 'mail', decision: 'approved', decidedBy: 'owner', ttlMs: 60_000 }, principal);
    await call(h, 'mail', 'send', { to: 'a@example.com', body: 'hi' });
    const send = (await h.service.get('r')).steps.find((s) => s.intent.stepId === 'mail')!;
    expect(send.effects![0]).toMatchObject({
      authorization: `approval:${send.intentHash}`,
      targets: ['mailto:a@example.com'],
      status: 'applied',
    });
  });

  test('a pure tool leaves no effect record; a read records one and its outcome', async () => {
    const h = await setup();
    await call(h, 'look', 'peek', {});
    expect((await h.service.get('r')).steps[0].effects).toEqual([
      expect.objectContaining({ tool: 'peek', effectClass: 'read', status: 'applied', targets: [], authorization: 'none' }),
    ]);
  });

  test('a replayed step never runs again and never adds a record', async () => {
    const h = await setup();
    await call(h, 'w1', 'note', { path: 'a.md', text: 'x' });
    await call(h, 'w1', 'note', { path: 'a.md', text: 'x' });
    expect(h.calls).toHaveLength(1);
    expect((await h.service.get('r')).steps[0].effects).toHaveLength(1);
  });

  test('a refused input or target leaves no intent at all', async () => {
    const h = await setup();
    await expect(call(h, 'bad', 'note', { path: 'a.md' })).rejects.toMatchObject({ code: 'tool_input_rejected' });
    expect((await h.service.get('r')).steps).toHaveLength(0);
  });
});

describe('a crash between intent and outcome is uncertain, never blindly re-executed', () => {
  async function crashDuringNote(h: Harness) {
    const hold = holdNote(h);
    const running = call(h, 'w1', 'note', { path: 'a.md', text: 'x' });
    await hold.reached;
    // The process dies here: a second service over the same folder recovers.
    const after = new RunService(new FileRunStore(h.dir), { clock: () => 1000 });
    await after.recover('r', principal);
    hold.release();
    await expect(running).rejects.toMatchObject({ code: 'stale_lease' });
    h.hold = null;
    return after;
  }

  test('an idempotent write interrupted by a crash is uncertain and refused with effect_uncertain', async () => {
    const h = await setup();
    const after = await crashDuringNote(h);
    const run = await after.get('r');
    expect(run.state).toBe('reconcile_required');
    expect(run.steps[0].state).toBe('reconcile_required');
    expect(run.steps[0].effects![0].status).toBe('uncertain');
    expect(uncertainEffectsOf(run)).toEqual([
      'The note effect on a.md may have happened; its outcome was never recorded.',
    ]);
    await after.claim('r', 'host-2', 60_000).catch(() => undefined);
    await expect(
      h.tools.dispatch(after, { runId: 'r', owner: 'host-2', principal, stepId: 'w1', name: 'note', input: { path: 'a.md', text: 'x' } }),
    ).rejects.toMatchObject({ code: 'effect_uncertain' });
    expect(h.calls).toHaveLength(1);
  });

  test('reconciled as not applied: one new attempt with the same idempotency key and a second record', async () => {
    const h = await setup();
    const after = await crashDuringNote(h);
    h.sink.clear(); // the sink never saw the write
    expect(await h.tools.reconcile(after, 'r', 'w1', principal)).toBe('not-applied');
    const reconciled = await after.get('r');
    expect(reconciled.state).toBe('queued');
    expect(reconciled.steps[0].effects![0]).toMatchObject({
      status: 'reconciled-not-applied',
      reconciliation: { by: 'tool:note', evidence: expect.stringMatching(/absent/) },
    });
    await after.claim('r', 'host-2', 60_000);
    expect(
      await h.tools.dispatch(after, { runId: 'r', owner: 'host-2', principal, stepId: 'w1', name: 'note', input: { path: 'a.md', text: 'x' } }),
    ).toEqual({ written: 'a.md' });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].key).toBe(h.calls[0].key);
    const effects = (await after.get('r')).steps[0].effects!;
    expect(effects.map((effect) => [effect.attempt, effect.status])).toEqual([
      [1, 'reconciled-not-applied'],
      [2, 'applied'],
    ]);
  });

  test('reconciled as applied: the step is settled and the handler never runs again', async () => {
    const h = await setup();
    const after = await crashDuringNote(h);
    expect(h.sink.size).toBe(1);
    expect(await h.tools.reconcile(after, 'r', 'w1', principal)).toBe('applied');
    await after.claim('r', 'host-2', 60_000);
    const replay = await h.tools.dispatch(after, { runId: 'r', owner: 'host-2', principal, stepId: 'w1', name: 'note', input: { path: 'a.md', text: 'x' } });
    expect(replay).toMatchObject({ reconciled: 'applied' });
    expect(h.calls).toHaveLength(1);
    expect((await after.get('r')).steps[0].effects![0].status).toBe('reconciled-applied');
  });

  test('a person reconciles when the tool cannot, and a second reconciliation is refused', async () => {
    const h = await setup();
    const after = await crashDuringNote(h);
    await after.reconcileEffect('r', 'w1', { resolution: 'not-applied', by: 'owner', evidence: 'Checked the folder; a.md was never written.' }, principal);
    await expect(
      after.reconcileEffect('r', 'w1', { resolution: 'applied', by: 'owner', evidence: 'again' }, principal),
    ).rejects.toMatchObject({ code: 'not_uncertain' });
    const events = (await after.events('r')).filter((event) => event.type === 'effect.reconciled');
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toMatchObject({ resolution: 'not-applied', by: 'owner' });
  });

  test('a read interrupted by a crash changed nothing: abandoned, and retried', async () => {
    const h = await setup();
    let arrive!: () => void;
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    let release!: () => void;
    const slow = new ToolRegistry();
    slow.register({
      name: 'peek',
      version: '1',
      description: 'Read slowly.',
      effect: 'read',
      effectClass: 'read',
      permission: null,
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: 0,
      schema: z.strictObject({}),
      outputSchema: z.strictObject({ ok: z.boolean() }),
      execute: async () => {
        arrive();
        await new Promise<void>((resolve) => (release = resolve));
        return { ok: true };
      },
    });
    const running = slow.dispatch(h.service, { runId: 'r', owner: 'host', principal, stepId: 'look', name: 'peek', input: {} });
    await reached;
    const after = new RunService(new FileRunStore(h.dir), { clock: () => 1000 });
    await after.recover('r', principal);
    release();
    await expect(running).rejects.toMatchObject({ code: 'stale_lease' });
    const run = await after.get('r');
    expect(run.state).toBe('queued');
    expect(run.steps[0].state).toBe('retry_wait');
    expect(run.steps[0].effects![0].status).toBe('abandoned');
    expect(uncertainEffectsOf(run)).toEqual([]);
  });

  test('a cancel while a write is running leaves it uncertain, not cancelled', async () => {
    const h = await setup();
    const hold = holdNote(h);
    const running = call(h, 'w1', 'note', { path: 'a.md', text: 'x' });
    await hold.reached;
    await h.service.cancel('r', 'the person pressed Stop', principal);
    hold.release();
    await expect(running).rejects.toBeDefined();
    const step = (await h.service.get('r')).steps[0];
    expect(step.state).toBe('reconcile_required');
    expect(step.effects![0].status).toBe('uncertain');
  });

  test('a timed-out write is uncertain: the handler may still be finishing it', async () => {
    const h = await setup();
    const tools = new ToolRegistry();
    let finish!: () => void;
    tools.register({
      name: 'note',
      version: '1',
      description: 'A write that hangs.',
      effect: 'idempotent',
      effectClass: 'idempotent-write',
      permission: 'write-project-file',
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: 0,
      limits: { timeoutMs: 30 },
      schema: z.strictObject({ path: z.string() }),
      outputSchema: z.strictObject({ ok: z.boolean() }),
      targets: (input) => [input.path],
      execute: () => new Promise<{ ok: boolean }>((resolve) => (finish = () => resolve({ ok: true }))),
    });
    await expect(
      tools.dispatch(h.service, { runId: 'r', owner: 'host', principal, stepId: 'slow', name: 'note', input: { path: 'a.md' } }),
    ).rejects.toMatchObject({ code: 'tool_timeout' });
    finish();
    const step = (await h.service.get('r')).steps[0];
    expect(step.state).toBe('reconcile_required');
    expect(step.effects![0]).toMatchObject({ status: 'uncertain', error: expect.stringMatching(/did not finish/) });
  });

  test('a write whose handler reports failure is failed, and the retry keeps the idempotency key', async () => {
    const h = await setup();
    const tools = new ToolRegistry();
    const keys: string[] = [];
    tools.register({
      name: 'note',
      version: '1',
      description: 'A write that fails once.',
      effect: 'idempotent',
      effectClass: 'idempotent-write',
      permission: 'write-project-file',
      approval: false,
      destination: 'local',
      trustedInputRequired: false,
      cost: 0,
      schema: z.strictObject({ path: z.string() }),
      outputSchema: z.strictObject({ ok: z.boolean() }),
      targets: (input) => [input.path],
      execute: ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        if (keys.length === 1) throw new Error('disk full');
        return { ok: true };
      },
    });
    const once = () => tools.dispatch(h.service, { runId: 'r', owner: 'host', principal, stepId: 'w', name: 'note', input: { path: 'a.md' } });
    await expect(once()).rejects.toThrow(/disk full/);
    await expect(once()).resolves.toEqual({ ok: true });
    expect(keys[0]).toBe(keys[1]);
    expect((await h.service.get('r')).steps[0].effects!.map((e) => e.status)).toEqual(['failed', 'applied']);
  });

  test('an external send is refused by policy before any intent, and one that errors is uncertain', async () => {
    const h = await setup();
    const register = (tools: ToolRegistry, label: boolean) =>
      tools.register({
        name: 'send',
        version: '1',
        description: 'A send whose acknowledgement is lost.',
        effect: 'non-idempotent',
        effectClass: 'external-send',
        permission: 'send-mail',
        approval: false,
        destination: 'external',
        trustedInputRequired: false,
        cost: 0,
        ...(label
          ? { label: { tenantId: 'a', projectId: 'p', integrity: 'trusted', confidentiality: 'public', provenance: [] } as const }
          : {}),
        schema: z.strictObject({ to: z.string() }),
        outputSchema: z.strictObject({ ok: z.boolean() }),
        targets: (input) => [`mailto:${input.to}`],
        execute: () => {
          throw new Error('connection reset after send');
        },
      });
    const restricted = new ToolRegistry();
    register(restricted, false);
    await expect(
      restricted.dispatch(h.service, { runId: 'r', owner: 'host', principal, stepId: 's0', name: 'send', input: { to: 'x@example.com' } }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect((await h.service.get('r')).steps).toHaveLength(0);
    const open = new ToolRegistry();
    register(open, true);
    await expect(
      open.dispatch(h.service, { runId: 'r', owner: 'host', principal, stepId: 's1', name: 'send', input: { to: 'x@example.com' } }),
    ).rejects.toThrow(/connection reset/);
    const step = (await h.service.get('r')).steps[0];
    expect(step.state).toBe('reconcile_required');
    expect(step.effects![0]).toMatchObject({ status: 'uncertain', targets: ['mailto:x@example.com'] });
  });
});
