/**
 * Out of credits, below the app: how the run service and the work loop record a managed call the
 * gateway refused because the business has no credits left to hold.
 *
 * A refusal whose hold was released is a known outcome (nothing was charged for that step), so it
 * is recorded as a failed step, never parked for reconciliation. Only the two out-of-credits
 * codes are read that way: the job cap, a busy service and an unreleased hold keep the existing
 * handling.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CapabilityManifest, HarnessBudget, HarnessPrincipal, ModelRequest, ModelResult } from '../shared/harness.js';
import { FileRunStore, RunService, ToolRegistry, type ModelAdapter, type StepDefinition } from '../server/harness/index.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { NativeLoop, type LoopToolBinding } from '../server/harness/native-loop.js';
import { ModelApiError } from '../server/engines/model-api-core.js';
import { loopOutcome, loopView } from '../shared/native-loop.js';
import { presentRun } from '../server/harness/present.js';
import { micro } from '../shared/managed-usage.js';

const WORDS = 'Your business is out of credits, so this stopped here. Buy more credits in Settings, Usage.';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const principal: HarnessPrincipal = { id: 'local-client', tenantId: 'local', projectId: 'p', capabilities: [], identityGeneration: 1 };
const capability: CapabilityManifest = {
  id: 'diomedes-loop', version: 'v1', label: 'Loop under test', description: 'Synthetic.', tools: ['read_note'],
  requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 16, supportedPlatforms: ['win32', 'linux', 'darwin'],
};
const BUDGET: HarnessBudget = { units: 40, modelCalls: 20, toolCalls: 20, wallMs: null };

/** What the Nectovia route throws for a gateway refusal: released hold, code as mapped. */
const refusal = (code: string, hold: 'released' | 'uncertain' = 'released') =>
  new ModelApiError(code, WORDS, true, { reservation: { id: 'exp-1', state: hold, maxMicroUsd: micro(5), settledMicroUsd: null }, status: 402 });

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-out-of-credits-harness-'));
  roots.push(root);
  // The host's own egress check allows the send; these tests are about what happens once it fails.
  const runs = new RunService(new FileRunStore(root), { authorizeEgress: async () => undefined });
  return { runs };
}
async function begin(runs: RunService, id: string, tools = new ToolRegistry(), manifest: CapabilityManifest = { ...capability, tools: [] }) {
  await runs.start({ id, tenantId: 'local', projectId: 'p', principal, capability: manifest, budget: BUDGET, tools });
  await runs.claim(id, 'host', 60_000);
}
const model: StepDefinition = {
  id: 'model:0', version: 'v1', kind: 'model', effect: 'read', name: 'nectovia', destination: 'external', maxAttempts: 3,
  input: { instruction: 'Synthetic' },
  label: { tenantId: 'local', projectId: 'p', integrity: 'untrusted', confidentiality: 'public', provenance: ['synthetic-test'] },
};

describe('the run service and a refusal that sent and charged nothing', () => {
  test.each(['nectovia_insufficient_allowance', 'nectovia_no_period'])('%s with its hold released is a failed step, not a parked one', async (code) => {
    const { runs } = await setup();
    await begin(runs, 'r1');
    await expect(runs.step('r1', 'host', model, () => { throw refusal(code); }, principal)).rejects.toMatchObject({ code });
    const run = await runs.get('r1');
    expect(run.steps[0].state).toBe('failed');
    expect(run.state).not.toBe('reconcile_required');
    expect(run.events.map((event) => event.type)).toContain('step.failed');
    expect(run.events.map((event) => event.type)).not.toContain('step.reconcile_required');
    // The run can then end: it is not held by an unknown outcome.
    await runs.fail('r1', 'host', refusal(code));
    expect((await runs.get('r1')).state).toBe('failed');
  });

  test.each([
    ['the job cap, which keeps its own path', 'nectovia_cap_request_required', 'released' as const],
    ['a busy service, which keeps its own path', 'nectovia_provider_busy', 'released' as const],
    ['an out-of-credits code whose hold is not known released', 'nectovia_insufficient_allowance', 'uncertain' as const],
  ])('%s stays parked for reconciliation', async (_label, code, hold) => {
    const { runs } = await setup();
    await begin(runs, 'r2');
    await expect(runs.step('r2', 'host', model, () => { throw refusal(code, hold); }, principal)).rejects.toThrow();
    const run = await runs.get('r2');
    expect(run.steps[0].state).toBe('reconcile_required');
    expect(run.state).toBe('reconcile_required');
  });
});

describe('the work loop and a refusal that sent and charged nothing', () => {
  const NOTES: Record<string, string> = { 'order.md': 'Order 1182: 100 napkins.' };
  const tools = () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_note', version: 'v1', description: 'Read a note.', effect: 'read', effectClass: 'read', permission: null,
      approval: false, destination: 'local', trustedInputRequired: false, cost: 0,
      schema: z.strictObject({ path: z.string() }),
      outputSchema: z.strictObject({ path: z.string(), text: z.string().nullable() }),
      execute: ({ input }) => ({ path: input.path, text: NOTES[input.path] ?? null }),
    });
    return registry;
  };
  const bindings: LoopToolBinding[] = [
    { name: 'read_note', description: 'Read a note by path.', schema: z.strictObject({ path: z.string() }), bind: (input) => input as { path: string } },
  ];
  /** An external adapter: the plan, one tool call, then the credits run out on the next call. */
  function adapter(calls: { count: number }): ModelAdapter {
    return {
      id: 'nectovia', version: 'v1', destination: 'external', contract: routeContractFor('native-fixture'),
      capabilities: () => ({
        engineId: 'nectovia', engineVersion: 'v1', protocolVersion: 'test', modelCalls: 'enforced', toolCalls: 'enforced',
        filesystemWrites: 'unsupported', networkEgress: 'enforced', approvals: 'unsupported', resumability: 'observed',
        cancellability: 'observed', checkpointGranularity: 'step', notes: [],
      }),
      async complete(request: ModelRequest): Promise<ModelResult> {
        calls.count += 1;
        if (!request.tools.length) return { response: { type: 'final', text: '1. Read the order.\n2. Report the count.' } };
        const observed = request.messages.filter((message) => message.role === 'tool').length;
        if (observed === 0) return { response: { type: 'tool', name: 'read_note', input: { path: 'order.md' } } };
        throw refusal('nectovia_insufficient_allowance');
      },
    };
  }

  test('ends at the refused step, keeps the steps before it, and records why', async () => {
    const { runs } = await setup();
    const registry = tools();
    await begin(runs, 'loop-credits', registry, capability);
    const calls = { count: 0 };
    const result = await new NativeLoop(runs, adapter(calls), registry, {
      maxTurns: 6, instructions: '', bindings, route: 'nectovia', model: null,
    }).run('loop-credits', 'host', 'Report the order count.', principal);
    expect(result).toEqual({ kind: 'stopped', reason: 'credits' });

    const run = await runs.get('loop-credits');
    expect(run.state).toBe('cancelled');
    expect(run.steps.map((step) => `${step.intent.stepId}:${step.state}`)).toEqual([
      'loop:context:succeeded',
      'model:plan:succeeded',
      'plan:succeeded',
      'model:0:succeeded',
      'tool:0:succeeded',
      'observe:0:succeeded',
      'model:1:failed',
      'stop:credits:succeeded',
    ]);
    // The observation the tool step made before the credits ran out is still on the record.
    expect(loopView(run).turns[0].observation?.excerpt).toContain('Order 1182');
    // The plan call, the tool call and the refused call: nothing was asked a fourth time.
    expect(calls.count).toBe(3);
    const view = loopView(run);
    expect(view.stop).toMatchObject({ reason: 'credits', detail: WORDS });
    expect(loopOutcome(view, null)).toEqual({ state: 'stopped-limit', label: 'Stopped: out of credits', sentence: WORDS });
    expect(presentRun(run)).toMatchObject({ sessionState: 'stopped', sentence: WORDS });
  });

  test('a run already ended there cannot be driven on: a later step is refused, not sent', async () => {
    const { runs } = await setup();
    const registry = tools();
    await begin(runs, 'loop-credits-2', registry, capability);
    const calls = { count: 0 };
    await new NativeLoop(runs, adapter(calls), registry, { maxTurns: 6, instructions: '', bindings, route: 'nectovia', model: null }).run(
      'loop-credits-2', 'host', 'Report the order count.', principal,
    );
    await expect(
      runs.step('loop-credits-2', 'host', { ...model, id: 'model:9' }, () => { calls.count += 1; return {}; }, principal),
    ).rejects.toMatchObject({ code: 'run_cancelled' });
    expect(calls.count).toBe(3);
  });
});
