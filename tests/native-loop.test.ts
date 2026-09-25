/**
 * H13: the Diomedes-owned plan → act → observe → finish loop, below any host.
 *
 * The real `RunService` over a file store, a real `ToolRegistry`, and scripted
 * adapters. No network and no provider: every model step here is a fixed
 * script, so every model step is attributed as an application action.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CapabilityManifest, HarnessBudget, HarnessPrincipal, HarnessRun, ModelRequest, ModelResult } from '../shared/harness.js';
import { FileRunStore, RunService, Suspended, ToolRegistry, type ModelAdapter } from '../server/harness/index.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { NativeLoop, type LoopDelegationPort, type LoopToolBinding } from '../server/harness/native-loop.js';
import { streamChecks } from '../server/harness/conformance.js';
import { loopOutcome, loopView, parsePlan, type LoopDelegateResult } from '../shared/native-loop.js';
import { openHandoff } from '../shared/handoff.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: HarnessPrincipal = {
  id: 'local-client',
  tenantId: 'local',
  projectId: 'p',
  capabilities: ['write-project-file'],
  identityGeneration: 1,
};
const capability: CapabilityManifest = {
  id: 'diomedes-loop',
  version: 'v1',
  label: 'Loop under test',
  description: 'Synthetic.',
  tools: ['read_note', 'write_note'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 16,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};
const NOTES: Record<string, string> = { 'order.md': 'Order 1182: 100 napkins.', 'delivery.md': 'Delivered 94 napkins.' };

function registry(writes: string[]) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_note',
    version: 'v1',
    description: 'Read a note.',
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
    schema: z.strictObject({ path: z.string() }),
    outputSchema: z.strictObject({ path: z.string(), text: z.string().nullable() }),
    execute: ({ input }) => ({ path: input.path, text: NOTES[input.path] ?? null }),
  });
  tools.register({
    name: 'write_note',
    version: 'v1',
    description: 'Write the report.',
    effect: 'idempotent',
    effectClass: 'idempotent-write',
    permission: 'write-project-file',
    approval: true,
    destination: 'local',
    trustedInputRequired: false,
    cost: 1,
    schema: z.strictObject({ path: z.literal('report.md'), text: z.string() }),
    outputSchema: z.strictObject({ written: z.string() }),
    targets: (input) => [input.path],
    execute: ({ input }) => {
      writes.push(input.text);
      return { written: input.path };
    },
  });
  return tools;
}
const bindings: LoopToolBinding[] = [
  { name: 'read_note', description: 'Read a note by path.', schema: z.strictObject({ path: z.string() }), bind: (input) => input as { path: string } },
  {
    name: 'write_note',
    description: 'Propose the report text.',
    schema: z.strictObject({ text: z.string() }),
    // The host binds the path; the model never names where a write goes.
    bind: (input) => ({ path: 'report.md', text: (input as { text: string }).text }),
  },
];

type Step = (request: ModelRequest) => ModelResult['response'];
/** A scripted adapter: plan first (no tools offered), then one response per tool observation. */
function scripted(
  script: Step[],
  calls: { count: number } = { count: 0 },
  options: { hang?: (request: ModelRequest) => boolean; kill?: AbortSignal } = {},
): ModelAdapter {
  return {
    id: 'fixture',
    version: 'v1',
    contract: routeContractFor('native-fixture'),
    capabilities: () => ({
      engineId: 'fixture',
      engineVersion: 'v1',
      protocolVersion: 'test',
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
    async complete(request, signal) {
      calls.count += 1;
      if (options.hang?.(request))
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          options.kill?.addEventListener('abort', () => reject(new Error('process died')), { once: true });
        });
      if (!request.tools.length) return { response: { type: 'final', text: '1. Read the order.\n2. Read the delivery.\n3. Write the report.' } };
      const observed = request.messages.filter((message) => message.role === 'tool').length;
      const next = script[observed];
      if (!next) throw new Error(`No scripted response for observation ${observed}.`);
      return { response: next(request) };
    },
  };
}

async function setup(budget: HarnessBudget = { units: 40, modelCalls: 20, toolCalls: 20, wallMs: null }, dir?: string) {
  const root = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-native-loop-')));
  if (!dir) cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runs = new RunService(new FileRunStore(root));
  return { root, runs };
}
async function start(runs: RunService, id: string, budget: HarnessBudget, tools: ToolRegistry) {
  await runs.start({ id, tenantId: 'local', projectId: 'p', capability, principal, budget, tools });
  await runs.claim(id, 'host', 60_000);
}
const ids = (run: HarnessRun) => run.steps.map((step) => `${step.intent.stepId}:${step.state}`);
const BUDGET: HarnessBudget = { units: 40, modelCalls: 20, toolCalls: 20, wallMs: null };

describe('plan, act, observe, finish', () => {
  test('every phase is its own recorded step, and a finish is a claim the checks decide', async () => {
    const { runs } = await setup();
    const writes: string[] = [];
    const tools = registry(writes);
    await start(runs, 'loop-1', BUDGET, tools);
    const adapter = scripted([
      () => ({ type: 'tool', name: 'read_note', input: { path: 'order.md' } }),
      () => ({ type: 'tool', name: 'read_note', input: { path: 'delivery.md' } }),
      () => ({ type: 'final', text: 'Both notes read. Six napkins short.' }),
    ]);
    const result = await new NativeLoop(runs, adapter, tools, {
      maxTurns: 6,
      instructions: 'Loop instructions.',
      bindings,
      route: 'native-fixture',
      model: null,
    }).run('loop-1', 'host', 'Compare the order with the delivery.', principal);
    expect(result).toEqual({ kind: 'finished', claim: 'Both notes read. Six napkins short.' });

    const run = await runs.get('loop-1');
    expect(run.state).toBe('completed');
    expect(ids(run)).toEqual([
      'loop:context:succeeded',
      'model:plan:succeeded',
      'plan:succeeded',
      'model:0:succeeded',
      'tool:0:succeeded',
      'observe:0:succeeded',
      'model:1:succeeded',
      'tool:1:succeeded',
      'observe:1:succeeded',
      'model:2:succeeded',
      'finish:2:succeeded',
    ]);
    // Diomedes owns the plan record and the finish; a scripted model is an application action.
    const origin = (id: string) => run.steps.find((step) => step.intent.stepId === id)!.origin!;
    expect(origin('plan').mode).toBe('supervisor');
    expect(origin('finish:2').mode).toBe('supervisor');
    expect(origin('model:0').mode).toBe('application');
    expect(origin('observe:0').mode).toBe('application');
    // The result says what decides it; it is not a success flag.
    expect(run.result).toEqual({ loop: { finish: 'finish:2', claim: 'Both notes read. Six napkins short.', verification: 'decided-by-declared-checks' } });
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);

    const view = loopView(run);
    expect(view.plan?.items).toEqual(['Read the order.', 'Read the delivery.', 'Write the report.']);
    expect(view.turns.map((turn) => [turn.turn, turn.decision, turn.tool])).toEqual([
      [0, 'tool', 'read_note'],
      [1, 'tool', 'read_note'],
      [2, 'finish', null],
    ]);
    expect(view.turns[0].observation?.excerpt).toContain('Order 1182');
    expect(view.turns[0].observation?.sha).toMatch(/^[a-f0-9]{64}$/);
    expect(view.context?.account.sections.find((section) => section.id === 'instructions')?.bytes).toBe('Loop instructions.'.length);
    expect(view.account?.sections.find((section) => section.id === 'tool-results')?.bytes).toBeGreaterThan(0);
    expect(view.models).toEqual([]);

    // Finished is never done by itself: the projection of the declared checks decides.
    expect(loopOutcome(view, null)).toMatchObject({ state: 'not-verified', label: 'Not verified' });
    expect(loopOutcome(view, { state: 'failed', sentence: '1 check failed.' })).toMatchObject({ state: 'failed-verification', label: 'Failed verification' });
    expect(loopOutcome(view, { state: 'uncertain', sentence: 'Changed.' })).toMatchObject({ state: 'uncertain', label: 'Verification uncertain' });
    expect(loopOutcome(view, { state: 'verified', sentence: '1 declared check passed.' })).toMatchObject({ state: 'verified', label: 'Verified' });
  });

  test('a tool the model was not offered, or a bad input, is observed as refused and the loop goes on', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    await start(runs, 'loop-2', BUDGET, tools);
    const adapter = scripted([
      () => ({ type: 'tool', name: 'delete_everything', input: {} }),
      () => ({ type: 'tool', name: 'read_note', input: { path: 7 } }),
      () => ({ type: 'final', text: 'Could not do it.' }),
    ]);
    await new NativeLoop(runs, adapter, tools, { maxTurns: 5, instructions: '', bindings, route: 'native-fixture', model: null }).run(
      'loop-2',
      'host',
      'Try.',
      principal,
    );
    const view = loopView(await runs.get('loop-2'));
    expect(view.turns.map((turn) => turn.decision)).toEqual(['refused', 'refused', 'finish']);
    expect(view.turns[0].observation?.detail).toMatch(/not a tool this run was offered/);
    expect(view.turns[1].observation?.detail).toMatch(/did not match its schema/);
    // Nothing ran: no tool step exists.
    expect((await runs.get('loop-2')).steps.some((step) => step.intent.kind === 'tool')).toBe(false);
  });

  test('an input the registry refuses (too large for the tool) is observed as refused, and the run goes on', async () => {
    const { runs } = await setup();
    const writes: string[] = [];
    const tools = registry(writes);
    await start(runs, 'loop-2b', BUDGET, tools);
    const adapter = scripted([
      () => ({ type: 'tool', name: 'write_note', input: { text: 'x'.repeat(70_000) } }),
      () => ({ type: 'final', text: 'The report was too long.' }),
    ]);
    await new NativeLoop(runs, adapter, tools, { maxTurns: 5, instructions: '', bindings, route: 'native-fixture', model: null }).run(
      'loop-2b',
      'host',
      'Try.',
      principal,
    );
    const run = await runs.get('loop-2b');
    expect(run.state).toBe('completed');
    const view = loopView(run);
    expect(view.turns.map((turn) => turn.decision)).toEqual(['refused', 'finish']);
    expect(view.turns[0].observation?.detail).toMatch(/limit is 65536/);
    expect(run.steps.some((step) => step.intent.kind === 'tool')).toBe(false);
    expect(writes).toEqual([]);
  });

  test('the plan is bounded: at most eight short items', () => {
    const plan = parsePlan(Array.from({ length: 12 }, (_, i) => `${i + 1}. Step ${i + 1} ${'x'.repeat(i === 0 ? 300 : 3)}`).join('\n'));
    expect(plan.items).toHaveLength(8);
    expect(plan.truncated).toBe(true);
    expect(plan.items[0].length).toBeLessThanOrEqual(240);
    expect(parsePlan('- a\n* b\nStep 3: c').items).toEqual(['a', 'b', 'c']);
  });
});

describe('bounded: turns and budget stop the run truthfully', () => {
  test('a loop takes at most 16 turns, and at least one', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    for (const maxTurns of [0, 17, 1.5])
      expect(() => new NativeLoop(runs, scripted([]), tools, { maxTurns, instructions: '', bindings, route: 'native-fixture', model: null })).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/invalid_turns|invalid_units|invalid/) }),
      );
    expect(() => new NativeLoop(runs, scripted([]), tools, { maxTurns: 16, instructions: '', bindings, route: 'native-fixture', model: null })).not.toThrow();
  });

  test('the turn limit stops the run with a record saying so; it is cancelled, never completed', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    await start(runs, 'loop-3', BUDGET, tools);
    const adapter = scripted(Array.from({ length: 10 }, () => () => ({ type: 'tool' as const, name: 'read_note', input: { path: 'order.md' } })));
    const result = await new NativeLoop(runs, adapter, tools, { maxTurns: 3, instructions: '', bindings, route: 'native-fixture', model: null }).run(
      'loop-3',
      'host',
      'Loop forever.',
      principal,
    );
    expect(result).toEqual({ kind: 'stopped', reason: 'turn-limit' });
    const run = await runs.get('loop-3');
    expect(run.state).toBe('cancelled');
    expect(run.cancelReason).toBe('turn limit reached (3 of 3 turns)');
    const view = loopView(run);
    expect(view.stop).toMatchObject({ reason: 'turn-limit', turns: { used: 3, limit: 3 } });
    expect(view.finish).toBeNull();
    expect(loopOutcome(view, null)).toEqual({
      state: 'stopped-limit',
      label: 'Stopped: turn limit reached',
      sentence: 'Stopped: turn limit reached (3 of 3 turns). The goal was not finished, so nothing was checked.',
    });
    expect(streamChecks(run).filter((check) => check.outcome === 'failed')).toEqual([]);
  });

  test('the run budget stops the loop before the next call, with the limit it hit', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    const budget = { units: 40, modelCalls: 2, toolCalls: 20, wallMs: null };
    await start(runs, 'loop-4', budget, tools);
    const calls = { count: 0 };
    const adapter = scripted(Array.from({ length: 10 }, () => () => ({ type: 'tool' as const, name: 'read_note', input: { path: 'order.md' } })), calls);
    const result = await new NativeLoop(runs, adapter, tools, { maxTurns: 8, instructions: '', bindings, route: 'native-fixture', model: null }).run(
      'loop-4',
      'host',
      'Loop.',
      principal,
    );
    expect(result).toEqual({ kind: 'stopped', reason: 'budget' });
    // Plan and one turn; the third call was refused before it was made.
    expect(calls.count).toBe(2);
    const run = await runs.get('loop-4');
    expect(run.state).toBe('cancelled');
    expect(run.cancelReason).toBe('budget reached (model calls 2 of 2)');
    expect(loopOutcome(loopView(run), null).label).toBe('Stopped: budget reached');
    expect(run.steps.find((step) => step.intent.stepId === 'model:1')?.state).toBe('cancelled');
  });
});

describe('approval, replay and restart', () => {
  const writing = () =>
    scripted([
      () => ({ type: 'tool', name: 'read_note', input: { path: 'order.md' } }),
      () => ({ type: 'tool', name: 'write_note', input: { text: '# Report\n\nOrder 1182.' } }),
      () => ({ type: 'final', text: 'Wrote report.md.' }),
    ]);

  test('an action that needs approval suspends the loop; after go-ahead it replays without calling anything twice', async () => {
    const { runs } = await setup();
    const writes: string[] = [];
    const tools = registry(writes);
    await start(runs, 'loop-5', BUDGET, tools);
    const calls = { count: 0 };
    const adapter = { ...writing(), complete: (() => { const base = writing(); return async (request: ModelRequest, signal: AbortSignal) => { calls.count += 1; return base.complete(request, signal); }; })() };
    const loop = () => new NativeLoop(runs, adapter, tools, { maxTurns: 5, instructions: '', bindings, route: 'native-fixture', model: null });
    await expect(loop().run('loop-5', 'host', 'Write the report.', principal)).rejects.toBeInstanceOf(Suspended);
    let run = await runs.get('loop-5');
    expect(run.state).toBe('waiting');
    expect(loopOutcome(loopView(run), null)).toMatchObject({ state: 'waiting', label: 'Waiting for your OK' });
    expect(writes).toEqual([]);
    // The write's scope was bound by the host, not chosen by the model.
    expect(run.steps.find((step) => step.intent.stepId === 'tool:1')?.intent.input).toEqual({ path: 'report.md', text: '# Report\n\nOrder 1182.' });
    expect(calls.count).toBe(3);

    await runs.decide({ runId: 'loop-5', stepId: 'tool:1', decision: 'approved', decidedBy: 'local-client', ttlMs: 60_000 }, principal);
    await runs.claim('loop-5', 'host', 60_000);
    await loop().run('loop-5', 'host', 'Write the report.', principal);
    run = await runs.get('loop-5');
    expect(run.state).toBe('completed');
    expect(writes).toEqual(['# Report\n\nOrder 1182.']);
    // Plan, turn 0 and turn 1 replayed from the record: only the final call is new.
    expect(calls.count).toBe(4);
  });

  test('an action goes through the registry’s mediated dispatch: its effect intent, targets and authority are recorded (H12)', async () => {
    const { runs } = await setup();
    const writes: string[] = [];
    const tools = registry(writes);
    await start(runs, 'loop-5e', BUDGET, tools);
    const loop = () => new NativeLoop(runs, writing(), tools, { maxTurns: 5, instructions: '', bindings, route: 'native-fixture', model: null });
    await expect(loop().run('loop-5e', 'host', 'Write the report.', principal)).rejects.toBeInstanceOf(Suspended);
    const waiting = await runs.get('loop-5e');
    const intentHash = waiting.steps.find((step) => step.intent.stepId === 'tool:1')!.intentHash;
    await runs.decide({ runId: 'loop-5e', stepId: 'tool:1', decision: 'approved', decidedBy: 'local-client', ttlMs: 60_000 }, principal);
    await runs.claim('loop-5e', 'host', 60_000);
    await loop().run('loop-5e', 'host', 'Write the report.', principal);
    const run = await runs.get('loop-5e');
    expect(run.steps.find((step) => step.intent.stepId === 'tool:0')?.effects).toMatchObject([
      { tool: 'read_note', effectClass: 'read', targets: [], status: 'applied' },
    ]);
    expect(run.steps.find((step) => step.intent.stepId === 'tool:1')?.effects).toMatchObject([
      { tool: 'write_note', effectClass: 'idempotent-write', targets: ['report.md'], authorization: `approval:${intentHash}`, status: 'applied' },
    ]);
    expect(run.events.filter((event) => event.type === 'effect.intended').map((event) => event.stepId)).toEqual(['tool:0', 'tool:1']);
  });

  test('a loop write interrupted between its intent and its outcome is uncertain and never runs again on a guess (H12)', async () => {
    const { root, runs } = await setup();
    const writes: string[] = [];
    const tools = registry(writes);
    const kill = new AbortController();
    let hang = true;
    const hanging = new ToolRegistry();
    for (const name of ['read_note', 'write_note']) {
      const tool = tools.get(name);
      hanging.register({
        ...tool,
        execute: async (context) => {
          if (name === 'write_note' && hang) await new Promise((_resolve, reject) => kill.signal.addEventListener('abort', () => reject(new Error('process died'))));
          return tool.execute(context);
        },
      });
    }
    await start(runs, 'loop-5u', BUDGET, hanging);
    const loop = (service: RunService) =>
      new NativeLoop(service, writing(), hanging, { maxTurns: 5, instructions: '', bindings, route: 'native-fixture', model: null });
    await expect(loop(runs).run('loop-5u', 'host', 'Write the report.', principal)).rejects.toBeInstanceOf(Suspended);
    await runs.decide({ runId: 'loop-5u', stepId: 'tool:1', decision: 'approved', decidedBy: 'local-client', ttlMs: 60_000 }, principal);
    await runs.claim('loop-5u', 'host', 60_000);
    const first = loop(runs).run('loop-5u', 'host', 'Write the report.', principal).catch((error: unknown) => error);
    await expect.poll(async () => (await runs.get('loop-5u')).steps.find((step) => step.intent.stepId === 'tool:1')?.state).toBe('running');

    // The process dies inside the write. A new one must not guess that it did not happen.
    const { runs: next } = await setup(BUDGET, root);
    await next.recover('loop-5u', principal);
    const run = await next.get('loop-5u');
    const step = run.steps.find((item) => item.intent.stepId === 'tool:1')!;
    expect(step.state).toBe('reconcile_required');
    expect(step.effects?.at(-1)).toMatchObject({ tool: 'write_note', targets: ['report.md'], status: 'uncertain' });
    hang = false;
    await next.claim('loop-5u', 'host-2', 60_000).catch(() => undefined);
    await expect(loop(next).run('loop-5u', 'host-2', 'Write the report.', principal)).rejects.toMatchObject({ code: 'effect_uncertain' });
    expect(writes).toEqual([]);
    kill.abort();
    await first;
  });

  test('restart recovery: a new service over the same records resumes a mid-loop run and never repeats a recorded step', async () => {
    const { root, runs } = await setup();
    const writes: string[] = [];
    const tools = registry(writes);
    await start(runs, 'loop-6', BUDGET, tools);
    const calls = { count: 0 };
    const kill = new AbortController();
    // The first process dies while turn 1's model call is in flight.
    const hanging = scripted(
      [
        () => ({ type: 'tool', name: 'read_note', input: { path: 'order.md' } }),
        () => ({ type: 'final', text: 'Read the order.' }),
      ],
      calls,
      { hang: (request) => request.messages.filter((message) => message.role === 'tool').length === 1, kill: kill.signal },
    );
    const first = new NativeLoop(runs, hanging, tools, { maxTurns: 5, instructions: '', bindings, route: 'native-fixture', model: null })
      .run('loop-6', 'host', 'Read the order.', principal)
      .catch((error: unknown) => error);
    await expect.poll(async () => (await runs.get('loop-6')).steps.find((step) => step.intent.stepId === 'model:1')?.state).toBe('running');
    expect(calls.count).toBe(3);

    // A new process: recovery invalidates the dead lease; a local model step is safe to run again.
    const { runs: next } = await setup(BUDGET, root);
    await next.recover('loop-6', principal);
    let run = await next.get('loop-6');
    expect(run.state).toBe('queued');
    expect(run.steps.find((step) => step.intent.stepId === 'model:1')?.state).toBe('retry_wait');
    await next.claim('loop-6', 'host-2', 60_000);
    const after = { count: 0 };
    const resumed = scripted(
      [
        () => ({ type: 'tool', name: 'read_note', input: { path: 'order.md' } }),
        () => ({ type: 'final', text: 'Read the order.' }),
      ],
      after,
    );
    await new NativeLoop(next, resumed, tools, { maxTurns: 5, instructions: '', bindings, route: 'native-fixture', model: null }).run(
      'loop-6',
      'host-2',
      'Read the order.',
      principal,
    );
    run = await next.get('loop-6');
    expect(run.state).toBe('completed');
    // Only the interrupted call was made again; the plan and turn 0 came from the record.
    expect(after.count).toBe(1);
    expect(run.steps.filter((step) => step.intent.stepId === 'tool:0')[0].attempt).toBe(1);
    // The dead process's late failure cannot touch the record the new owner completed.
    kill.abort();
    expect(await first).toBeInstanceOf(Error);
    expect((await next.get('loop-6')).state).toBe('completed');
  });
});

describe('delegation: carved budgets, four per run, several at once', () => {
  function port(runs: RunService, log: string[], behaviour: 'answer' | 'hang'): LoopDelegationPort {
    return {
      route: 'native-fixture',
      open: ({ parent, childRunId, task, siblings }) => {
        const opened = openHandoff({
          id: `${parent.id}-h${childRunId.slice(`${parent.id}-d`.length)}`,
          tenantId: null,
          from: { agentId: 'loop', agentVersion: '1', agentDigest: 'sha256:a', produces: ['plan.markdown'] },
          to: { agentId: 'child', agentVersion: '1', agentDigest: 'sha256:b', accepts: ['plan.markdown'] },
          artifact: 'plan.markdown',
          parentWork: { runId: parent.id, taskId: '', summary: task },
          evidence: [],
          unresolved: [],
          depth: 0,
          siblings,
          payer: { kind: 'local-machine', id: null, coversChildren: true, reason: 'Test.' },
          requiredAuthority: [],
          createdAt: '2026-09-24T00:00:00.000Z',
        });
        return opened.ok ? { envelope: opened.envelope, refusal: null } : { envelope: null, refusal: opened.reason };
      },
      run: async (request): Promise<LoopDelegateResult> => {
        log.push(`start ${request.childRunId}`);
        await runs.start({
          id: request.childRunId,
          tenantId: 'local',
          projectId: 'p',
          capability: { ...capability, id: 'diomedes-loop-delegate', tools: [] },
          principal,
          budget: request.budget,
        });
        await runs.claim(request.childRunId, 'child', 60_000);
        if (behaviour === 'hang') {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener(
              'abort',
              () => {
                log.push('parent stopped');
                void runs.cancel(request.childRunId, 'the loop that handed it this sub-task was stopped').then(resolve);
              },
              { once: true },
            ),
          );
        } else await runs.complete(request.childRunId, 'child', { text: 'delivery.md lists 94 napkins.' });
        const child = await runs.get(request.childRunId);
        return {
          v: 1,
          childRunId: child.id,
          state: child.state,
          text: (child.result as { text?: string } | null)?.text ?? null,
          reason: child.cancelReason,
          models: [],
        };
      },
    };
  }

  test('a handoff record, a child with a budget carved from the parent’s, and the answer observed by the parent', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    await start(runs, 'loop-7', BUDGET, tools);
    const log: string[] = [];
    const again = () => ({ type: 'tool' as const, name: 'delegate', input: { task: 'Again.' } });
    const adapter = scripted([
      (request) => {
        expect(request.tools.map((tool) => tool.name)).toContain('delegate');
        return { type: 'tool', name: 'delegate', input: { task: 'Read delivery.md.' } };
      },
      again,
      again,
      again,
      () => ({ type: 'tool', name: 'delegate', input: { task: 'A fifth time.' } }),
      (request) => ({ type: 'final', text: `Helper said: ${JSON.stringify(request.messages.at(-1)?.output)}` }),
    ]);
    await new NativeLoop(runs, adapter, tools, {
      maxTurns: 7,
      instructions: '',
      bindings,
      delegation: port(runs, log, 'answer'),
      route: 'native-fixture',
      model: null,
    }).run('loop-7', 'host', 'Delegate the reading.', principal);
    const run = await runs.get('loop-7');
    const ids = ['loop-7-d0', 'loop-7-d1', 'loop-7-d2', 'loop-7-d3'];
    const children = await Promise.all(ids.map((id) => runs.get(id)));
    const view = loopView(run, children);
    expect(view.delegations.map((item) => [item.turn, item.handoffId, item.childRunId, item.child?.state])).toEqual(
      ids.map((id, turn) => [turn, `loop-7-h${turn}`, id, 'completed']),
    );
    // Andrew, 2026-09-24: each child's budget is carved from what the parent has left, never
    // added on top, and the parent spends it: seven model calls and four carves of eight units.
    expect(view.delegations[0].budget).toEqual({ units: 8, modelCalls: 4, toolCalls: 4, wallMs: null });
    expect(children[0].budget).toEqual(view.delegations[0].budget);
    expect(run.used.units).toBe(7 + 4 * 8);
    expect(run.used.units).toBeLessThanOrEqual(run.budget.units);
    // A fifth handoff is refused: at most four per run.
    expect(view.turns[4]).toMatchObject({ decision: 'refused' });
    expect(view.turns[4].observation?.detail).toMatch(/as many as one loop may/);
    expect(view.turns[0].observation).toMatchObject({ action: 'delegate', ok: true });
    expect(view.turns[0].observation?.excerpt).toContain('94 napkins');
    const handoff = run.steps.find((step) => step.intent.stepId === 'handoff:0')!;
    expect(handoff.origin?.mode).toBe('supervisor');
    expect((handoff.output as { envelope: { from: { agentId: string }; depth: number } }).envelope).toMatchObject({ from: { agentId: 'loop' }, depth: 0 });
    expect(log).toEqual(ids.map((id) => `start ${id}`));
  });

  test('sub-tasks asked for together run at the same time, each carved an equal share', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    await start(runs, 'loop-9', BUDGET, tools);
    const log: string[] = [];
    const adapter = scripted([
      () => ({ type: 'tool', name: 'delegate', input: { tasks: [{ task: 'Read a.md.' }, { task: 'Read b.md.' }, { task: 'Read c.md.' }] } }),
      () => ({ type: 'tool', name: 'delegate', input: { tasks: [{ task: 'One more.' }, { task: 'And another.' }] } }),
      () => ({ type: 'final', text: 'Done.' }),
    ]);
    await new NativeLoop(runs, adapter, tools, {
      maxTurns: 4,
      instructions: '',
      bindings,
      delegation: port(runs, log, 'answer'),
      route: 'native-fixture',
      model: null,
    }).run('loop-9', 'host', 'Delegate three readings.', principal);
    const run = await runs.get('loop-9');
    const ids = ['loop-9-d0', 'loop-9-d0-1', 'loop-9-d0-2'];
    const view = loopView(run, await Promise.all(ids.map((id) => runs.get(id))));
    expect(view.delegations.map((item) => [item.childRunId, item.handoffId, item.child?.state, item.result?.state])).toEqual([
      ['loop-9-d0', 'loop-9-h0', 'completed', 'completed'],
      ['loop-9-d0-1', 'loop-9-h0-1', 'completed', 'completed'],
      ['loop-9-d0-2', 'loop-9-h0-2', 'completed', 'completed'],
    ]);
    // One delegate step started all three; together they cost three shares of what was left.
    expect(run.steps.filter((step) => step.intent.stepId.startsWith('delegate:'))).toHaveLength(1);
    expect(run.steps.find((step) => step.intent.stepId === 'delegate:0')!.intent.cost).toBe(3 * 8);
    expect(view.turns[0].observation?.detail).toBe('3 of 3 sub-tasks finished.');
    // Two more would make five: refused before anything starts.
    expect(view.turns[1]).toMatchObject({ decision: 'refused' });
    expect(view.turns[1].observation?.detail).toMatch(/handed off 3 of its 4 sub-tasks, so 2 more would pass its limit/);
    expect(log).toHaveLength(3);
  });

  test('a carve the parent cannot afford is refused, and nothing starts', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    await start(runs, 'loop-10', { units: 6, modelCalls: 5, toolCalls: 5, wallMs: null }, tools);
    const log: string[] = [];
    const adapter = scripted([
      () => ({ type: 'tool', name: 'delegate', input: { tasks: [{ task: 'Read a.md.' }, { task: 'Read b.md.' }] } }),
      () => ({ type: 'final', text: 'Done alone.' }),
    ]);
    await new NativeLoop(runs, adapter, tools, {
      maxTurns: 2,
      instructions: '',
      bindings,
      delegation: port(runs, log, 'answer'),
      route: 'native-fixture',
      model: null,
    }).run('loop-10', 'host', 'Delegate two readings.', principal);
    const view = loopView(await runs.get('loop-10'));
    expect(view.turns[0]).toMatchObject({ decision: 'delegate', observation: { action: 'refused' } });
    expect(view.turns[0].observation?.detail).toMatch(/4 of its 6 units left, which is not enough to carve 2 sub-tasks/);
    expect(log).toEqual([]);
    expect(view.finish?.claim).toBe('Done alone.');
  });

  test('stopping the parent stops the child it is waiting for', async () => {
    const { runs } = await setup();
    const tools = registry([]);
    await start(runs, 'loop-8', BUDGET, tools);
    const log: string[] = [];
    const adapter = scripted([() => ({ type: 'tool', name: 'delegate', input: { task: 'Read delivery.md slowly.' } })]);
    const running = new NativeLoop(runs, adapter, tools, {
      maxTurns: 4,
      instructions: '',
      bindings,
      delegation: port(runs, log, 'hang'),
      route: 'native-fixture',
      model: null,
    })
      .run('loop-8', 'host', 'Delegate.', principal)
      .catch((error: unknown) => error);
    await expect.poll(async () => (await runs.get('loop-8-d0').catch(() => null))?.state).toBe('running');
    await runs.cancel('loop-8', 'Stopped by the person.', principal);
    await expect.poll(async () => (await runs.get('loop-8-d0')).state).toBe('cancelled');
    expect((await runs.get('loop-8-d0')).cancelReason).toBe('the loop that handed it this sub-task was stopped');
    expect(log).toContain('parent stopped');
    await running;
    const parent = await runs.get('loop-8');
    expect(parent.state).toBe('cancelled');
    expect(parent.steps.find((step) => step.intent.stepId === 'delegate:0')?.state).toBe('cancelled');
    expect(loopOutcome(loopView(parent), null)).toMatchObject({ state: 'stopped', sentence: 'Stopped: Stopped by the person.' });
  });
});
