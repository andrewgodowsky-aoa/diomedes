import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CapabilityManifest, HarnessPrincipal, HarnessRun, StepRecord } from '../shared/harness.js';
import {
  ADAPTER_CAPABILITIES,
  FileRunStore,
  NativeAgent,
  needFromWaitingStep,
  presentRun,
  RunService,
  Suspended,
  ToolRegistry,
  weakestGuarantee,
  type ModelAdapter,
  type StepDefinition,
} from '../server/harness/index.js';

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
  description: 'Synthetic capability for negative tests.',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32'],
};
const bud = (over: Record<string, number | null> = {}) => ({
  units: 20,
  modelCalls: 50,
  toolCalls: 50,
  wallMs: null as number | null,
  ...over,
});

async function fresh() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-neg-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
  return { service, dir };
}
async function boot(o: { budget?: ReturnType<typeof bud>; cap?: CapabilityManifest } = {}) {
  const { service, dir } = await fresh();
  await service.start({
    id: 'r',
    tenantId: 'a',
    projectId: 'p',
    capability: o.cap ?? capability,
    principal,
    budget: o.budget ?? bud(),
  });
  await service.claim('r', 'host', 100000);
  return { service, dir };
}
const def = (over: Partial<StepDefinition> = {}): StepDefinition => ({
  id: 'one',
  version: '1',
  kind: 'tool',
  effect: 'pure',
  input: { x: 2 },
  cost: 1,
  ...over,
});
async function waiting() {
  const { service, dir } = await boot();
  const d = def({ approval: true });
  await expect(service.step('r', 'host', d, () => 1, principal)).rejects.toThrow(Suspended);
  return { service, dir, d };
}
const scriptAdapter = (complete: () => Promise<unknown> | unknown): ModelAdapter => ({
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
  complete: (async () => complete()) as ModelAdapter['complete'],
});
const stepRec = (over: Partial<StepRecord> = {}): StepRecord => ({
  intent: {
    stepId: 'tool:0',
    stepVersion: '1',
    kind: 'tool',
    effect: 'pure',
    input: { files: ['a.md'] },
    cost: 1,
    maxAttempts: 3,
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    label: null,
    policyVersion: 'p1',
  },
  intentHash: 'abc123',
  attempt: 0,
  state: 'pending',
  output: null,
  outputHash: null,
  leaseFence: 1,
  startedAt: null,
  endedAt: null,
  error: null,
  ...over,
});
const runRec = (over: Partial<HarnessRun> = {}): HarnessRun => ({
  v: 1,
  id: 'R1',
  tenantId: 'local',
  projectId: 'P1',
  taskId: 'T1',
  sessionId: null,
  capabilityId: 'fixture',
  capabilityVersion: 'v1',
  capabilityTools: [],
  policyVersion: 'p1',
  principal: { id: 'w', tenantId: 'local', projectId: 'P1', capabilities: [], identityGeneration: 1 },
  state: 'waiting',
  budget: { units: 10, modelCalls: 5, toolCalls: 5, wallMs: null },
  used: { units: 2, modelCalls: 1, toolCalls: 1 },
  owner: 'host',
  fence: 1,
  leaseExpiresAt: null,
  parentRunId: null,
  forkPoint: null,
  contextRevision: 1,
  transcripts: {},
  result: null,
  failure: null,
  cancelReason: null,
  createdAt: '2026-09-08T11:00:00.000Z',
  updatedAt: '2026-09-08T11:00:01.000Z',
  steps: [stepRec({ state: 'waiting_approval' })],
  approvals: [],
  events: [{ v: 1, seq: 1, runId: 'R1', at: '2026-09-08T11:00:00.000Z', type: 'run.created', attributes: {} }],
  lastSeq: 1,
  ...over,
});

describe('start must not accept bad input', () => {
  test('start must not accept a run id with a space or a slash', async () => {
    const { service } = await fresh();
    const base = { tenantId: 'a', projectId: 'p', capability, principal, budget: bud() };
    await expect(service.start({ ...base, id: 'bad id' })).rejects.toThrow(/run id/);
    await expect(service.start({ ...base, id: 'a/b' })).rejects.toThrow(/run id/);
  });
  test('start must not accept a capability with zero maxTurns', async () => {
    const { service } = await fresh();
    await expect(service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability: { ...capability, maxTurns: 0 }, principal, budget: bud() })).rejects.toThrow(/turn limit/);
  });
  test('start must not accept a principal outside the run tenant and project', async () => {
    const { service } = await fresh();
    const base = { id: 'r', capability, budget: bud() };
    await expect(
      service.start({ ...base, tenantId: 'a', projectId: 'p', principal: { ...principal, tenantId: 'b' } }),
    ).rejects.toThrow(/tenant and project/);
    await expect(
      service.start({ ...base, id: 'r2', tenantId: 'a', projectId: 'p', principal: { ...principal, projectId: 'q' } }),
    ).rejects.toThrow(/tenant and project/);
  });
  test('start must not accept a fractional wallMs budget', async () => {
    const { service } = await fresh();
    await expect(service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget: bud({ wallMs: 1.5 }) })).rejects.toThrow(/integer/);
  });
  test('start must not accept a capability naming a tool the registry does not have', async () => {
    const { service } = await fresh();
    await expect(
      service.start({
        id: 'r', tenantId: 'a', projectId: 'p',
        capability: { ...capability, tools: ['missing'] }, principal, budget: bud(), tools: new ToolRegistry(),
      }),
    ).rejects.toThrow(/Unknown tool/);
  });
});

describe('leases and events must not misbehave', () => {
  test('claim must not accept TTL 0 or an empty owner', async () => {
    const { service } = await fresh();
    await service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget: bud() });
    await expect(service.claim('r', 'host', 0)).rejects.toThrow(/TTL|owner|positive/);
    await expect(service.claim('r', '', 100)).rejects.toThrow(/owner/);
  });
  test('claim must not leave the run queued after the first claim or thereafter', async () => {
    const { service } = await fresh();
    await service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget: bud() });
    expect((await service.get('r')).state).toBe('queued');
    await service.claim('r', 'host', 100000);
    expect((await service.get('r')).state).toBe('running');
    await service.claim('r', 'host', 100000);
    expect((await service.get('r')).state).toBe('running');
  });
  test('a renewal by the same live owner must not change the generation; only a new claim does', async () => {
    // Muse's brief said each renewal bumps the fence; the boundary was changed on
    // purpose while the packet ran: a live owner renewing keeps its fence so an
    // in-flight step can still commit, and a lapsed lease is a new generation.
    let time = 1000;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-neg-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new RunService(new FileRunStore(dir), { clock: () => time });
    await service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget: bud() });
    expect(await service.claim('r', 'host', 100)).toBe(1);
    expect(await service.claim('r', 'host', 100)).toBe(1);
    await expect(service.claim('r', 'other', 100)).rejects.toThrow(/lease busy/);
    time += 200;
    expect(await service.claim('r', 'other', 100)).toBe(2);
    expect((await service.get('r')).owner).toBe('other');
  });
  test('events must not accept a negative cursor', async () => {
    const { service } = await boot();
    await expect(service.events('r', -1)).rejects.toThrow(/integer/);
  });
  test('events must not return anything after the last sequence', async () => {
    const { service } = await boot();
    const run = await service.get('r');
    expect(await service.events('r', run.lastSeq)).toEqual([]);
  });
});

describe('steps must not run without a valid intent', () => {
  test('step must not accept an unknown kind, effect or fractional maxAttempts before hooks run', async () => {
    const { service } = await boot();
    let hooks = 0;
    service.use(async () => { hooks++; });
    await expect(service.step('r', 'host', def({ kind: 'weird' as never }), () => 1, principal)).rejects.toThrow(/Unknown step kind/);
    await expect(service.step('r', 'host', def({ effect: 'weird' as never }), () => 1, principal)).rejects.toThrow(/Unknown effect/);
    await expect(service.step('r', 'host', def({ maxAttempts: 1.5 }), () => 1, principal)).rejects.toThrow(/integer/);
    expect(hooks).toBe(0);
  });
  test('step must not run on an unknown run id', async () => {
    const { service } = await boot();
    await expect(service.step('nope', 'host', def(), () => 1, principal)).rejects.toThrow(/Unknown run/);
  });
});

describe('approvals must not be granted loosely', () => {
  test('decide must not answer a step that is not waiting', async () => {
    const { service } = await boot();
    await service.step('r', 'host', def(), () => 1, principal);
    await expect(service.decide({ runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'm', ttlMs: 100 }, principal)).rejects.toThrow(/not waiting/);
  });
  test('decide must not accept TTL 0', async () => {
    const { service } = await waiting();
    await expect(service.decide({ runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'm', ttlMs: 0 }, principal)).rejects.toThrow(/TTL/);
  });
  test('decide must not accept an empty decidedBy', async () => {
    const { service } = await waiting();
    await expect(service.decide({ runId: 'r', stepId: 'one', decision: 'approved', decidedBy: '', ttlMs: 100 }, principal)).rejects.toThrow(/who decided/);
  });
  test('decide must not approve the same waiting step twice', async () => {
    const { service } = await waiting();
    await service.decide({ runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'm', ttlMs: 100 }, principal);
    expect((await service.get('r')).steps[0].state).toBe('pending');
    await expect(service.decide({ runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'm', ttlMs: 100 }, principal)).rejects.toThrow(/not waiting/);
  });
  test('an approved step must not execute without consuming its approval', async () => {
    const { service, d } = await waiting();
    await service.decide({ runId: 'r', stepId: 'one', decision: 'approved', decidedBy: 'm', ttlMs: 100 }, principal);
    await service.step('r', 'host', d, () => 7, principal);
    const run = await service.get('r');
    expect(run.approvals[0].consumedAt).not.toBeNull();
    expect(run.approvals[0].intentHash).toBe(run.steps[0].intentHash);
  });
});

describe('completion and failure must not break the record', () => {
  test('complete must not succeed for an owner without the lease', async () => {
    const { service } = await boot();
    await expect(service.complete('r', 'other', { text: 'x' })).rejects.toThrow(/stale lease/);
  });
  test('complete must not finish while a step is still running', async () => {
    const { service } = await boot();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = service.step('r', 'host', def(), async () => { await gate; return 1; }, principal);
    await new Promise((r) => setTimeout(r, 20));
    await expect(service.complete('r', 'host', { text: 'x' })).rejects.toThrow(/still running/);
    release();
    await pending;
  });
  test('complete must not write a second completed event', async () => {
    const { service } = await boot();
    await service.complete('r', 'host', { text: 'done' });
    await service.complete('r', 'host', { text: 'done' });
    expect((await service.get('r')).events.filter((e) => e.type === 'run.completed')).toHaveLength(1);
  });
  test('fail must not skip the failure record and its event', async () => {
    const { service } = await boot();
    await service.fail('r', 'host', new Error('boom'));
    const run = await service.get('r');
    expect(run.state).toBe('failed');
    expect(run.failure?.name).toBe('Error');
    expect(run.failure?.message).toBe('boom');
    expect(run.events.filter((e) => e.type === 'run.failed')).toHaveLength(1);
  });
  test('fail must not change a completed run', async () => {
    const { service } = await boot();
    await service.complete('r', 'host', { text: 'done' });
    await service.fail('r', 'host', new Error('late'));
    const run = await service.get('r');
    expect(run.state).toBe('completed');
    expect(run.failure).toBeNull();
    expect(run.events.some((e) => e.type === 'run.failed')).toBe(false);
  });
  test('cancel must not leave an aborted step running', async () => {
    const { service } = await boot();
    const d = def({ id: 'one' });
    const pending = service.step(
      'r', 'host', d,
      async ({ signal }) => {
        await new Promise<void>((res) => {
          if (signal.aborted) res();
          else signal.addEventListener('abort', () => res(), { once: true });
        });
        return 1;
      },
      principal,
    );
    await new Promise((r) => setTimeout(r, 20));
    await service.cancel('r', 'stop');
    await expect(pending).rejects.toThrow(/stale attempt/);
    const run = await service.get('r');
    expect(run.state).toBe('cancelled');
    expect(run.steps[0].state).toBe('cancelled');
  });
});

describe('forks and tools must not invent history', () => {
  test('fork must not accept an unknown fork point', async () => {
    const { service } = await boot();
    await service.step('r', 'host', def(), () => 1, principal);
    await expect(service.fork('r', 'branch', 'nope', principal)).rejects.toThrow(/fork point/);
  });
  test('fork must not reuse a child id', async () => {
    const { service } = await boot();
    await service.step('r', 'host', def(), () => 1, principal);
    await service.step('r', 'host', def({ id: 'two' }), () => 2, principal);
    await service.fork('r', 'branch', 'two', principal);
    await expect(service.fork('r', 'branch', 'two', principal)).rejects.toThrow(/exists/);
  });
  test('fork must not misprice the child or misnumber its first event', async () => {
    const { service } = await boot();
    await service.step('r', 'host', def({ id: 'one', cost: 2 }), () => 1, principal);
    await service.step('r', 'host', def({ id: 'two', cost: 3 }), () => 2, principal);
    const child = await service.fork('r', 'branch', 'two', principal);
    expect(child.used.units).toBe(2);
    expect(child.events[0].type).toBe('run.forked');
    expect(child.events[0].seq).toBe(1);
  });
  test('register must not accept an uppercase name, a negative cost or a missing execute', () => {
    const tools = new ToolRegistry();
    const base = {
      version: '1', description: 'd', effect: 'pure' as const, permission: null,
      approval: false, destination: 'local' as const, trustedInputRequired: false,
      cost: 1, schema: z.object({}).strict(), execute: () => ({}),
    };
    expect(() => tools.register({ ...base, name: 'Sum' })).toThrow(/lowercase/);
    expect(() => tools.register({ ...base, name: 'ok', cost: -1 })).toThrow(/integer/);
    const { execute: _drop, ...noExec } = base;
    expect(() => tools.register({ ...noExec, name: 'ok2' } as never)).toThrow(/handler/);
  });
  test('validate must not accept an extra key on a strict schema', () => {
    const tools = new ToolRegistry();
    tools.register({
      version: '1', description: 'd', effect: 'pure' as const, permission: null,
      approval: false, destination: 'local' as const, trustedInputRequired: false,
      cost: 1, name: 'sum', schema: z.object({ a: z.number() }).strict(), execute: () => ({}),
    });
    expect(() => tools.validate('sum', { a: 1, extra: 2 })).toThrow(/schema rejected/);
  });
  test('get must not return an unknown tool', () => {
    expect(() => new ToolRegistry().get('nope')).toThrow(/Unknown tool/);
  });
});

describe('the agent and budgets must not overspend', () => {
  test('NativeAgent must not accept an adapter without capabilities', () => {
    expect(() => new NativeAgent({} as RunService, { id: 'x', version: '1', complete: async () => ({}) } as never, new ToolRegistry())).toThrow(/adapter/);
  });
  test('the agent must not accept a weird model response without failing the run', async () => {
    const { service } = await boot();
    const agent = new NativeAgent(service, scriptAdapter(() => ({ response: { type: 'weird' } })), new ToolRegistry());
    await expect(agent.run('r', 'host', 'hi', principal)).rejects.toThrow(/Invalid model response/);
    expect((await service.get('r')).state).toBe('failed');
  });
  test('the agent must not lose a throwing model call', async () => {
    const { service } = await boot();
    const agent = new NativeAgent(service, scriptAdapter(() => { throw new Error('provider down'); }), new ToolRegistry());
    await expect(agent.run('r', 'host', 'hi', principal)).rejects.toThrow(/provider down/);
    const run = await service.get('r');
    expect(run.steps[0].state).toBe('retry_wait');
    expect(run.state).toBe('failed');
  });
  test('a second model step must not exceed one model call', async () => {
    const { service } = await boot({ budget: bud({ modelCalls: 1 }) });
    await service.step('r', 'host', def({ id: 'm0', kind: 'model', cost: 0 }), () => 1, principal);
    await expect(service.step('r', 'host', def({ id: 'm1', kind: 'model', cost: 0 }), () => 2, principal)).rejects.toThrow(/budget exceeded/);
  });
  test('a tool step must not run with zero tool calls', async () => {
    const { service } = await boot({ budget: bud({ toolCalls: 0 }) });
    await expect(service.step('r', 'host', def(), () => 1, principal)).rejects.toThrow(/budget exceeded/);
  });
});

describe('the store and presentation must not lie', () => {
  test('read must not parse a file containing not json', async () => {
    const { dir } = await fresh();
    const store = new FileRunStore(dir);
    await fs.writeFile(path.join(dir, 'r.json'), 'not json');
    await expect(store.read('r')).rejects.toThrow();
  });
  test('list must not throw on a folder that does not exist', async () => {
    expect(await new FileRunStore(path.join(os.tmpdir(), `no-such-dir-${Date.now()}`)).list()).toEqual([]);
  });
  test('create must not accept a duplicate run id', async () => {
    const { service, dir } = await boot();
    const run = await service.get('r');
    await expect(new FileRunStore(dir).create(run)).rejects.toThrow(/exists/);
  });
  test('presentRun must not invent a reason when nothing waits inside', () => {
    const shown = presentRun(runRec({ state: 'waiting', steps: [stepRec({ state: 'succeeded' })] }));
    expect(shown.reason).toBeNull();
    expect(shown.sentence).toMatch(/outside/);
  });
  test('needFromWaitingStep must not drop the requested files', () => {
    expect(needFromWaitingStep(runRec(), stepRec()).files).toEqual(['a.md']);
  });
  test('weakestGuarantee must not promise more than unsupported for fixture and codex routes', () => {
    expect(weakestGuarantee(ADAPTER_CAPABILITIES['native-fixture'])).toBe('unsupported');
    expect(weakestGuarantee(ADAPTER_CAPABILITIES.codex)).toBe('unsupported');
  });
});
