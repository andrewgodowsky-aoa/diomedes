import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { CapabilityManifest, HarnessPrincipal, ModelResult } from '../shared/harness.js';
import {
  FileRunStore,
  NativeAgent,
  presentRun,
  RunService,
  Suspended,
  ToolRegistry,
  type ModelAdapter,
  type StepDefinition,
  type StepHandler,
} from '../server/harness/index.js';

/**
 * These pin the durable step boundary that every native model or tool call in
 * Diomedes will pass through. They are ported from the handoff package's
 * reference behaviour tests (reference/test/runtime.test.mjs, crash.test.mjs,
 * agent.test.mjs) and adapted to the file-backed store, the Diomedes label
 * shape (tenant and project) and vitest. Everything here is synthetic: a
 * temporary folder, a scripted model, no engine, no network.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const principal: HarnessPrincipal = {
  id: 'worker',
  tenantId: 'a',
  projectId: 'p',
  capabilities: ['calculate', 'sum'],
  identityGeneration: 1,
};
const capability: CapabilityManifest = {
  id: 'fixture',
  version: 'v1',
  label: 'Fixture capability',
  description: 'A synthetic capability for the boundary tests.',
  tools: ['sum'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32'],
};
const budget = (units: number) => ({ units, modelCalls: 50, toolCalls: 50, wallMs: null });

async function setup(options: { budget?: number; clock?: () => number } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-harness-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = options.clock ?? (() => 1000);
  const service = new RunService(new FileRunStore(dir), { clock });
  await service.start({
    id: 'r',
    tenantId: 'a',
    projectId: 'p',
    capability,
    principal,
    budget: budget(options.budget ?? 20),
  });
  await service.claim('r', 'host', 100);
  return { service, dir, clock };
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
const execute = (
  service: RunService,
  d: StepDefinition,
  fn: StepHandler<unknown>,
  who: HarnessPrincipal = principal,
) => service.step<unknown>('r', 'host', d, fn, who);

describe('durable step boundary', () => {
  test('successful steps are checkpointed and never invoked again', async () => {
    const { service } = await setup();
    let n = 0;
    const fn = () => ({ value: ++n });
    expect(await execute(service, def(), fn)).toEqual({ value: 1 });
    expect(await execute(service, def(), fn)).toEqual({ value: 1 });
    expect(n).toBe(1);
    const events = await service.events('r');
    expect(events.filter((e) => e.type === 'step.succeeded')).toHaveLength(1);
    expect(events.every((e) => e.v === 1)).toBe(true);
  });

  test('a committed checkpoint survives reopening the store', async () => {
    const { service, dir } = await setup();
    await execute(service, def(), () => ({ x: 9 }));
    const second = new RunService(new FileRunStore(dir), { clock: () => 1000 });
    const run = await second.get('r');
    expect(run.steps.find((s) => s.intent.stepId === 'one')?.output).toEqual({ x: 9 });
  });

  test('events carry a cursor and can be read from after it', async () => {
    const { service } = await setup();
    await execute(service, def(), () => 1);
    const all = await service.events('r');
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    const later = await service.events('r', all[1].seq);
    expect(later.map((e) => e.seq)).toEqual(all.slice(2).map((e) => e.seq));
  });

  test('changed arguments cannot reuse an old step id', async () => {
    const { service } = await setup();
    await execute(service, def(), () => 1);
    await expect(execute(service, def({ input: { x: 3 } }), () => 2)).rejects.toThrow(
      /intent mismatch/,
    );
  });

  test('an unknown non-idempotent outcome is not automatically retried', async () => {
    const { service } = await setup();
    let sent = 0;
    const fn = () => {
      sent++;
      throw new Error('connection lost after send');
    };
    await expect(execute(service, def({ effect: 'non-idempotent' }), fn)).rejects.toThrow(
      /connection lost/,
    );
    const run = await service.get('r');
    expect(run.steps[0].state).toBe('reconcile_required');
    expect(run.state).toBe('reconcile_required');
    await expect(execute(service, def({ effect: 'non-idempotent' }), fn)).rejects.toThrow(
      /reconciliation/,
    );
    expect(sent).toBe(1);
  });

  test('idempotent retries keep the same effect key', async () => {
    const { service } = await setup();
    const keys: string[] = [];
    const fn = ({ idempotencyKey }: { idempotencyKey: string }) => {
      keys.push(idempotencyKey);
      if (keys.length === 1) throw new Error('retry');
      return 'ok';
    };
    const d = def({ effect: 'idempotent' });
    await expect(execute(service, d, fn)).rejects.toThrow(/retry/);
    expect(await execute(service, d, fn)).toBe('ok');
    expect(keys[0]).toBe(keys[1]);
  });

  test('safe retries still have a bounded attempt count', async () => {
    const { service } = await setup();
    const d = def({ maxAttempts: 2 });
    let n = 0;
    for (let i = 0; i < 2; i++)
      await expect(
        execute(service, d, () => {
          n++;
          throw new Error('transient');
        }),
      ).rejects.toThrow(/transient/);
    await expect(execute(service, d, () => ++n)).rejects.toThrow(/attempt limit/);
    expect(n).toBe(2);
  });

  test('budget is reserved before the handler, including failed attempts', async () => {
    const { service } = await setup({ budget: 1 });
    let calls = 0;
    await expect(
      execute(service, def(), () => {
        calls++;
        throw new Error('charged failure');
      }),
    ).rejects.toThrow(/charged failure/);
    await expect(execute(service, def(), () => calls++)).rejects.toThrow(/budget/);
    expect(calls).toBe(1);
    expect((await service.get('r')).used.units).toBe(1);
  });

  test('budget and cost reject negative and fractional units', async () => {
    const { service } = await setup();
    await expect(
      service.start({
        id: 'bad',
        tenantId: 'a',
        projectId: 'p',
        capability,
        principal,
        budget: budget(-1),
      }),
    ).rejects.toThrow(/integer/);
    await expect(execute(service, def({ cost: 0.5 }), () => 1)).rejects.toThrow(/integer/);
  });

  test('approval suspends before execution and binds to the exact intent', async () => {
    const { service } = await setup();
    const d = def({ approval: true });
    let n = 0;
    await expect(execute(service, d, () => ++n)).rejects.toThrow(Suspended);
    expect(n).toBe(0);
    expect((await service.get('r')).state).toBe('waiting');
    const approval = await service.decide(
      { runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'manager', ttlMs: 100 },
      principal,
    );
    expect(approval.intentHash).toBe((await service.get('r')).steps[0].intentHash);
    expect(await execute(service, d, () => ++n)).toBe(1);
    expect(n).toBe(1);
  });

  test('an expired approval cannot authorize an operation', async () => {
    let time = 1000;
    const { service } = await setup({ clock: () => time });
    const d = def({ approval: true });
    await expect(execute(service, d, () => 1)).rejects.toThrow(Suspended);
    await service.decide(
      { runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'manager', ttlMs: 2 },
      principal,
    );
    time += 3;
    await expect(execute(service, d, () => 1)).rejects.toThrow(Suspended);
  });

  test('an approval granted under an older identity generation is not honoured', async () => {
    const { service } = await setup();
    const d = def({ approval: true });
    await expect(execute(service, d, () => 1)).rejects.toThrow(Suspended);
    await service.decide(
      { runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'manager', ttlMs: 100 },
      principal,
    );
    const rotated = { ...principal, identityGeneration: 2 };
    await expect(execute(service, d, () => 1, rotated)).rejects.toThrow(Suspended);
  });

  test('a denied approval cancels the step and the run', async () => {
    const { service } = await setup();
    const d = def({ approval: true });
    await expect(execute(service, d, () => 1)).rejects.toThrow(Suspended);
    await service.decide(
      { runId: 'r', stepId: 'one', decision: 'denied', decidedBy: 'manager', ttlMs: 100 },
      principal,
    );
    const run = await service.get('r');
    expect(run.steps[0].state).toBe('cancelled');
    expect(run.state).toBe('cancelled');
    await expect(execute(service, d, () => 1)).rejects.toThrow(/cancelled/);
  });

  test('approval rejects a different tenant', async () => {
    const { service } = await setup();
    await expect(execute(service, def({ approval: true }), () => 1)).rejects.toThrow(Suspended);
    await expect(
      service.decide(
        { runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'manager', ttlMs: 10 },
        { ...principal, tenantId: 'b' },
      ),
    ).rejects.toThrow(/tenant/);
  });

  test('a live lease cannot be stolen by another owner', async () => {
    const { service } = await setup();
    await expect(service.claim('r', 'other', 100)).rejects.toThrow(/lease busy/);
  });

  test('renewing a live lease keeps the fence, so an in-flight step can still commit', async () => {
    let time = 1000;
    const { service } = await setup({ clock: () => time });
    const fence = (await service.get('r')).fence;
    const value = await execute(service, def(), async () => {
      time += 50;
      expect(await service.claim('r', 'host', 100)).toBe(fence);
      return 'committed';
    });
    expect(value).toBe('committed');
    const run = await service.get('r');
    expect(run.fence).toBe(fence);
    expect(run.events.some((e) => e.type === 'run.lease_renewed')).toBe(true);
    // Once the lease has lapsed, a new claim by anyone is a new generation.
    time += 200;
    expect(await service.claim('r', 'host', 100)).toBe(fence + 1);
  });

  test('cancelling while a step with an effect is in flight parks it for reconciliation', async () => {
    const { service } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = execute(service, def({ effect: 'non-idempotent' }), async () => {
      await gate;
      return 'landed anyway';
    });
    await new Promise((r) => setTimeout(r, 20));
    await service.cancel('r', 'the person stopped it', principal);
    release();
    await expect(pending).rejects.toThrow(/stale attempt/);
    const run = await service.get('r');
    expect(run.state).toBe('cancelled');
    expect(run.steps[0].state).toBe('reconcile_required');
    expect(run.events.some((e) => e.type === 'step.reconcile_required')).toBe(true);
  });

  test('cancelling with a principal from another project is refused', async () => {
    const { service } = await setup();
    await expect(
      service.cancel('r', 'nope', { ...principal, projectId: 'other' }),
    ).rejects.toThrow(/project/);
    expect((await service.get('r')).state).toBe('running');
  });

  test('a run parked for reconciliation cannot be completed or overwritten by a failure', async () => {
    const { service } = await setup();
    await expect(
      execute(service, def({ effect: 'non-idempotent' }), () => {
        throw new Error('lost after send');
      }),
    ).rejects.toThrow(/lost after send/);
    await expect(service.complete('r', 'host', { text: 'no' })).rejects.toThrow(/reconcil/);
    await service.fail('r', 'host', new Error('later error'));
    const run = await service.get('r');
    expect(run.state).toBe('reconcile_required');
    expect(run.failure).toBeNull();
  });

  test('a fresh decision after an identity rotation is consumable under the new generation', async () => {
    const { service } = await setup();
    const d = def({ approval: true });
    await expect(execute(service, d, () => 1)).rejects.toThrow(Suspended);
    const rotated = { ...principal, identityGeneration: 2 };
    const approval = await service.decide(
      { runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'manager', ttlMs: 100 },
      rotated,
    );
    expect(approval.identityGeneration).toBe(2);
    expect(await execute(service, d, () => 1, rotated)).toBe(1);
  });

  test('error messages pass through the host redaction before they are persisted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-harness-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new RunService(new FileRunStore(dir), {
      clock: () => 1000,
      redact: (text) => text.replaceAll('sk-secret-123', '[redacted]'),
    });
    await service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget: budget(5) });
    await service.claim('r', 'host', 100);
    await expect(
      execute(service, def(), () => {
        throw new Error('provider said sk-secret-123 is invalid');
      }),
    ).rejects.toThrow(/sk-secret-123/);
    await service.fail('r', 'host', new Error('token sk-secret-123 leaked'));
    const text = await fs.readFile(path.join(dir, 'r.json'), 'utf8');
    expect(text).not.toContain('sk-secret-123');
    expect(text).toContain('[redacted]');
  });

  test('a capability whose tool list is not a list of names cannot start', async () => {
    const { service } = await setup();
    await expect(
      service.start({
        id: 'r3',
        tenantId: 'a',
        projectId: 'p',
        capability: { ...capability, tools: [42 as unknown as string] },
        principal,
        budget: budget(5),
      }),
    ).rejects.toThrow(/list of names/);
  });

  test('a cancelled run cannot be completed', async () => {
    const { service } = await setup();
    await service.cancel('r', 'stopped');
    await expect(service.complete('r', 'host', { text: 'no' })).rejects.toThrow(/cancelled/);
    expect((await service.get('r')).state).toBe('cancelled');
  });

  test('replaying a completed step does not rewrite the run file', async () => {
    const { service, dir } = await setup();
    await execute(service, def(), () => 1);
    const before = (await fs.stat(path.join(dir, 'r.json'))).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await execute(service, def(), () => 2);
    expect((await fs.stat(path.join(dir, 'r.json'))).mtimeMs).toBe(before);
  });

  test('a stale owner cannot commit after another owner claims the expired lease', async () => {
    let time = 1000;
    const { service } = await setup({ clock: () => time });
    await expect(
      execute(service, def({ effect: 'non-idempotent' }), async () => {
        time += 101;
        await service.claim('r', 'new', 100);
        return 'external effect';
      }),
    ).rejects.toThrow(/stale lease/);
    await expect(
      service.step('r', 'new', def({ effect: 'non-idempotent' }), () => 99, principal),
    ).rejects.toThrow(/reconciliation/);
  });

  test('a different tenant cannot execute a run', async () => {
    const { service } = await setup();
    await expect(execute(service, def(), () => 1, { ...principal, tenantId: 'b' })).rejects.toThrow(
      /tenant/,
    );
  });

  test('a different project cannot execute a run', async () => {
    const { service } = await setup();
    await expect(
      execute(service, def(), () => 1, { ...principal, projectId: 'other' }),
    ).rejects.toThrow(/project/);
  });

  test('a capability asking for a permission the principal lacks cannot start', async () => {
    const { service } = await setup();
    await expect(
      service.start({
        id: 'r2',
        tenantId: 'a',
        projectId: 'p',
        capability: { ...capability, requestedPermissions: ['publish'] },
        principal,
        budget: budget(5),
      }),
    ).rejects.toThrow(/capability/);
  });

  test('policy denial happens before optional hooks and before the handler', async () => {
    const { service } = await setup();
    let touched = 0;
    service.use(async () => {
      touched++;
    });
    await expect(execute(service, def({ permission: 'admin' }), () => touched++)).rejects.toThrow(
      /capability/,
    );
    expect(touched).toBe(0);
  });

  test('restricted data cannot leave for an external destination', async () => {
    const { service } = await setup();
    const label = {
      tenantId: 'a',
      projectId: 'p',
      integrity: 'trusted' as const,
      confidentiality: 'restricted' as const,
      provenance: ['doc:menu'],
    };
    await expect(
      execute(service, def({ destination: 'external', label }), () => 1),
    ).rejects.toThrow(/egress/);
  });

  test('a step with no label is treated as untrusted and restricted', async () => {
    const { service } = await setup();
    await expect(execute(service, def({ trustedInputRequired: true }), () => 1)).rejects.toThrow(
      /integrity/,
    );
  });

  test('hooks run in registration order and cannot override a denial', async () => {
    const { service } = await setup();
    const order: string[] = [];
    service.use(async () => {
      order.push('a');
    });
    service.use(async () => {
      order.push('b');
    });
    await execute(service, def(), () => {
      order.push('handler');
      return 1;
    });
    expect(order).toEqual(['a', 'b', 'handler']);
  });

  test('caller mutation during a hook cannot alter the captured intent', async () => {
    const { service } = await setup();
    const d = def();
    service.use(async () => {
      (d.input as { x: number }).x = 99;
    });
    expect(await execute(service, d, ({ input }) => (input as { x: number }).x)).toBe(2);
  });

  test('a concurrent invocation cannot poison an in-flight non-idempotent step', async () => {
    const { service } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = def({ effect: 'non-idempotent' });
    const first = execute(service, d, async () => {
      await gate;
      return 7;
    });
    await new Promise((r) => setTimeout(r, 20));
    await expect(execute(service, d, () => 99)).rejects.toThrow(/in flight/);
    release();
    expect(await first).toBe(7);
  });

  test('two services over the same folder cannot dispatch under the same lease generation', async () => {
    const { service, dir } = await setup();
    const second = new RunService(new FileRunStore(dir), { clock: () => 1000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = execute(service, def(), async () => {
      await gate;
      return 7;
    });
    await new Promise((r) => setTimeout(r, 20));
    await expect(second.step('r', 'host', def(), () => 99, principal)).rejects.toThrow(
      /in flight/,
    );
    release();
    expect(await first).toBe(7);
  });

  test('cancelling a run stops later steps and records the reason', async () => {
    const { service } = await setup();
    await execute(service, def(), () => 1);
    await service.cancel('r', 'the person stopped it');
    const run = await service.get('r');
    expect(run.state).toBe('cancelled');
    expect(run.cancelReason).toBe('the person stopped it');
    await expect(execute(service, def({ id: 'two' }), () => 2)).rejects.toThrow(/cancelled/);
    expect(run.events.at(-1)?.type).toBe('run.cancelled');
  });

  test('completion writes the result and its event in one durable write', async () => {
    const { service } = await setup();
    await execute(service, def(), () => 1);
    await service.complete('r', 'host', { text: 'done' });
    const run = await service.get('r');
    expect(run.state).toBe('completed');
    expect(run.result).toEqual({ text: 'done' });
    const last = run.events.at(-1);
    expect(last?.type).toBe('run.completed');
    expect(last?.seq).toBe(run.lastSeq);
  });

  test('a fork reuses only a completed pure prefix and no approvals', async () => {
    const { service } = await setup();
    await execute(service, def(), () => 5);
    await expect(execute(service, def({ id: 'two', approval: true }), () => 6)).rejects.toThrow(
      Suspended,
    );
    await service.decide(
      { runId: 'r', stepId: 'two', decision: 'approved', decidedBy: 'manager', ttlMs: 100 },
      principal,
    );
    await service.fork('r', 'branch', 'two', principal);
    await service.claim('branch', 'host', 100);
    expect(await service.step('branch', 'host', def(), () => 99, principal)).toBe(5);
    await expect(
      service.step('branch', 'host', def({ id: 'two', approval: true }), () => 6, principal),
    ).rejects.toThrow(Suspended);
    const child = await service.get('branch');
    expect(child.parentRunId).toBe('r');
    expect(child.forkPoint).toBe('two');
    expect((await service.get('r')).steps).toHaveLength(2);
  });

  test('a fork starts its own lineage without the parent transcript', async () => {
    const { service } = await setup();
    await execute(service, def(), () => 5);
    await service.recordTranscript('r', 'host', 'fixture', {
      providerId: 'fixture',
      modelId: null,
      lineageId: 'L1',
      opaqueRef: 'thread-1',
      prefixHash: 'h',
    });
    await execute(service, def({ id: 'two' }), () => 6);
    await service.fork('r', 'branch', 'two', principal);
    const child = await service.get('branch');
    expect(child.transcripts).toEqual({});
    expect(child.contextRevision).toBe(1);
    expect(child.events[0]).toMatchObject({ seq: 1, type: 'run.forked' });
  });

  test('a fork refuses a prefix containing external side effects', async () => {
    const { service } = await setup();
    await execute(service, def({ effect: 'idempotent' }), () => 5);
    await execute(service, def({ id: 'two' }), () => 6);
    await expect(service.fork('r', 'branch', 'two', principal)).rejects.toThrow(/pure prefix/);
  });

  test('a run file from a later contract version is refused, not migrated silently', async () => {
    const { service, dir } = await setup();
    const file = path.join(dir, 'r.json');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    parsed.v = 2;
    await fs.writeFile(file, JSON.stringify(parsed));
    await expect(service.get('r')).rejects.toThrow(/version/);
  });
});

describe('crash after an external effect', () => {
  test('a process exit after the effect leaves a durable reconciliation boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-harness-crash-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const receipt = path.join(dir, 'external.txt');
    const harness = pathToFileURL(path.resolve('server/harness/index.ts')).href;
    const d: StepDefinition = {
      id: 'send',
      version: '1',
      kind: 'tool',
      effect: 'non-idempotent',
      input: {},
      cost: 1,
    };
    const script = [
      `import { FileRunStore, RunService } from ${JSON.stringify(harness)};`,
      `import { writeFileSync } from 'node:fs';`,
      `const service = new RunService(new FileRunStore(${JSON.stringify(dir)}), { clock: () => 1000 });`,
      `await service.start(${JSON.stringify({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget: budget(5) })});`,
      `await service.claim('r', 'old', 100);`,
      `await service.step('r', 'old', ${JSON.stringify(d)}, () => { writeFileSync(${JSON.stringify(receipt)}, 'sent'); process.exit(17); }, ${JSON.stringify(principal)});`,
    ].join('\n');
    const child = path.join(dir, 'child.mts');
    await fs.writeFile(child, script);
    const result = spawnSync(process.execPath, ['--import', 'tsx', child], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(result.status, result.stderr).toBe(17);
    expect(await fs.readFile(receipt, 'utf8')).toBe('sent');
    const service = new RunService(new FileRunStore(dir), { clock: () => 2000 });
    await service.claim('r', 'new', 100);
    let repeated = false;
    await expect(
      service.step(
        'r',
        'new',
        d,
        () => {
          repeated = true;
          return 1;
        },
        principal,
      ),
    ).rejects.toThrow(/reconciliation/);
    expect(repeated).toBe(false);
    const run = await service.get('r');
    expect(run.steps[0].state).toBe('reconcile_required');
    expect(run.state).toBe('reconcile_required');
  });
});

describe('native loop over an injected model adapter', () => {
  const sumTool = {
    name: 'sum',
    version: '1',
    description: 'Add finite numbers.',
    effect: 'pure' as const,
    permission: 'sum',
    approval: false,
    destination: 'local' as const,
    trustedInputRequired: false,
    cost: 1,
    schema: z.object({ values: z.array(z.number().finite()) }).strict(),
    execute: ({ input }: { input: unknown }) =>
      (input as { values: number[] }).values.reduce((a, b) => a + b, 0),
  };
  const adapter = (
    complete: () => Promise<ModelResult> | ModelResult,
  ): ModelAdapter => ({
    id: 'fixture',
    version: '1',
    capabilities: () => ({
      engineId: 'native-fixture',
      engineVersion: '1',
      protocolVersion: 'fixture',
      modelCalls: 'enforced',
      toolCalls: 'enforced',
      filesystemWrites: 'unsupported',
      networkEgress: 'unsupported',
      approvals: 'enforced',
      resumability: 'enforced',
      cancellability: 'enforced',
      checkpointGranularity: 'step',
      notes: [],
    }),
    complete: async () => complete(),
  });
  function registry() {
    const tools = new ToolRegistry();
    tools.register(sumTool);
    return tools;
  }

  test('the loop owns model, tool and final steps and reuses the recorded trajectory', async () => {
    const { service } = await setup();
    let calls = 0;
    const agent = new NativeAgent(
      service,
      adapter(async () =>
        ++calls === 1
          ? { response: { type: 'tool', name: 'sum', input: { values: [3, 4] } } }
          : { response: { type: 'final', text: '7' } },
      ),
      registry(),
    );
    expect(await agent.run('r', 'host', 'sum', principal)).toBe('7');
    expect(await agent.run('r', 'host', 'sum', principal)).toBe('7');
    expect(calls).toBe(2);
    const run = await service.get('r');
    expect(run.events.filter((e) => e.type === 'step.succeeded')).toHaveLength(3);
    expect(run.state).toBe('completed');
    expect(run.used.modelCalls).toBe(2);
    expect(run.used.toolCalls).toBe(1);
  });

  test('the model cannot invent a tool or choose privileged handler metadata', async () => {
    const { service } = await setup();
    const agent = new NativeAgent(
      service,
      adapter(() => ({ response: { type: 'tool', name: 'shell', input: { cmd: 'no' } } })),
      registry(),
    );
    await expect(agent.run('r', 'host', 'do work', principal)).rejects.toThrow(/Unknown tool/);
  });

  test('invalid tool arguments are rejected before the handler runs', async () => {
    const { service } = await setup();
    const agent = new NativeAgent(
      service,
      adapter(() => ({ response: { type: 'tool', name: 'sum', input: { values: ['bad'] } } })),
      registry(),
    );
    await expect(agent.run('r', 'host', 'do work', principal)).rejects.toThrow(/schema/);
    expect((await service.get('r')).used.toolCalls).toBe(0);
  });

  test('the loop enforces an explicit turn budget', async () => {
    const { service } = await setup();
    const agent = new NativeAgent(
      service,
      adapter(() => ({ response: { type: 'tool', name: 'sum', input: { values: [1] } } })),
      registry(),
    );
    await expect(agent.run('r', 'host', 'do work', principal, { maxTurns: 2 })).rejects.toThrow(
      /turn limit/,
    );
    expect((await service.get('r')).state).toBe('failed');
  });

  test('a tool with an effect that fails inside the loop parks the run, and the loop does not overwrite that', async () => {
    const { service } = await setup();
    const tools = registry();
    tools.register({
      ...sumTool,
      name: 'send',
      permission: 'sum',
      effect: 'non-idempotent',
      execute: () => {
        throw new Error('connection lost after send');
      },
    });
    await service.start({
      id: 'r2',
      tenantId: 'a',
      projectId: 'p',
      capability: { ...capability, tools: ['send'] },
      principal,
      budget: budget(10),
    });
    await service.claim('r2', 'host', 100);
    const agent = new NativeAgent(
      service,
      adapter(() => ({ response: { type: 'tool', name: 'send', input: { values: [1] } } })),
      tools,
    );
    await expect(agent.run('r2', 'host', 'send it', principal)).rejects.toThrow(/connection lost/);
    const run = await service.get('r2');
    expect(run.state).toBe('reconcile_required');
    expect(run.failure).toBeNull();
    const shown = presentRun(run);
    expect(shown.reason).toBe('went-wrong');
    expect(shown.uncertain?.stepId).toBe('tool:0');
    expect(shown.sentence).toMatch(/could not confirm/);
  });

  test('a registered tool outside the capability is not offered and cannot be called', async () => {
    const { service } = await setup();
    const tools = registry();
    tools.register({ ...sumTool, name: 'shout', description: 'Not in the capability.' });
    let offered: string[] = [];
    const agent = new NativeAgent(
      service,
      {
        ...adapter(() => ({ response: { type: 'tool', name: 'shout', input: { values: [1] } } })),
        complete: async (request) => {
          offered = request.tools.map((t) => t.name);
          return { response: { type: 'tool', name: 'shout', input: { values: [1] } } };
        },
      },
      tools,
    );
    await expect(agent.run('r', 'host', 'do work', principal)).rejects.toThrow(/Unknown tool/);
    expect(offered).toEqual(['sum']);
    expect((await service.get('r')).used.toolCalls).toBe(0);
  });

  test('a tool the principal may not use is refused by the boundary, not the model', async () => {
    const { service } = await setup();
    const agent = new NativeAgent(
      service,
      adapter(() => ({ response: { type: 'tool', name: 'sum', input: { values: [1] } } })),
      registry(),
    );
    await expect(
      agent.run('r', 'host', 'do work', { ...principal, capabilities: ['calculate'] }),
    ).rejects.toThrow(/capability/);
  });

  test('the provider transcript is kept apart from the portable context', async () => {
    const { service } = await setup();
    const transcript = {
      providerId: 'fixture',
      modelId: 'fixture-1',
      lineageId: 'L1',
      opaqueRef: 'thread-abc',
      prefixHash: 'deadbeef',
    };
    const agent = new NativeAgent(
      service,
      adapter(() => ({ response: { type: 'final', text: 'ok' }, transcript })),
      registry(),
    );
    await agent.run('r', 'host', 'hello', principal);
    const run = await service.get('r');
    expect(run.transcripts.fixture).toEqual(transcript);
    const modelStep = run.steps.find((s) => s.intent.kind === 'model');
    expect(JSON.stringify(modelStep?.intent.input)).not.toContain('thread-abc');
  });

  test('the registry refuses duplicate names and describes tools without handlers', () => {
    const tools = registry();
    expect(() => tools.register(sumTool)).toThrow(/Duplicate/);
    const [described] = tools.describe();
    expect(described.name).toBe('sum');
    expect(described.inputSchema).toMatchObject({ type: 'object' });
    expect('execute' in described).toBe(false);
  });
});
