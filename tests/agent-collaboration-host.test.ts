/** Offline native orchestration: real RunService, recorded tools and scoped spend ledger. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { RunService } from '../server/harness/run-service.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { ToolRegistry } from '../server/harness/tools.js';
import { NativeLoop } from '../server/harness/native-loop.js';
import type { ModelAdapter } from '../server/harness/native-agent.js';
import { ADAPTER_CAPABILITIES } from '../server/harness/adapters.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { EngineService } from '../server/engines/service.js';
import { SpendExposure } from '../server/spend-exposure.js';
import { micro } from '../shared/managed-usage.js';
import type { HarnessPrincipal, Json, ModelRequest, ModelResult } from '../shared/harness.js';

let dir: string, runs: RunService, registry: ToolRegistry, principal: HarnessPrincipal;
const ROOT_JOB_KEY = 'job-1111111111111111111111111111111111111111';
const script = (steps: { name: string; input: Json }[], inspect?: (request: ModelRequest) => void): ModelAdapter => ({
  id: 'native-fixture', version: '1', contract: routeContractFor('native-fixture'),
  capabilities: () => ADAPTER_CAPABILITIES['native-fixture'],
  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    signal.throwIfAborted(); inspect?.(request);
    if (!request.tools.length) return { response: { type: 'final', text: '1. Ask the Team member.\n2. Ask the distinct helper.\n3. Review and propose the report.' } };
    const count = request.messages.filter((item) => item.role === 'tool').length;
    return count < steps.length ? { response: { type: 'tool', ...steps[count] } } : { response: { type: 'final', text: 'Inventory reconciliation is ready for verification.' } };
  },
});
function binding(name: string, schema: z.ZodType = z.strictObject({})) { return { name, description: name, schema, bind: (value: unknown) => value as Json }; }
function tool(name: string, execute: () => Json) {
  registry.register({ name, version: '1', description: name, effect: 'read', effectClass: 'read', permission: null, approval: false,
    destination: 'local', trustedInputRequired: false, cost: 0, schema: z.strictObject({}), outputSchema: z.json(), execute });
}
async function root(tools: string[] = [], units = 70) {
  await runs.start({ id: 'agent-root', tenantId: 'local', projectId: 'inventory', taskId: 'inventory-task', principal,
    capability: { id: 'diomedes-loop', version: '1', label: 'Native root', description: 'Offline scripted native root', tools,
      requestedPermissions: ['write-project-file'], approvalPolicy: 'show-first', maxTurns: 12, supportedPlatforms: ['win32', 'darwin', 'linux'] },
    input: { rootJobId: ROOT_JOB_KEY }, budget: { units, modelCalls: 14, toolCalls: 12, wallMs: null } });
  await runs.claim('agent-root', 'native-host', 600_000);
}
async function drive(steps: { name: string; input: Json }[], collaboration: any, extra: Record<string, unknown> = {}, inspect?: (request: ModelRequest) => void) {
  return new NativeLoop(runs, script(steps, inspect), registry, { maxTurns: 12, route: 'native-fixture', model: null,
    instructions: 'Scripted fixture; no provider.', bindings: steps.filter((item) => registry.has(item.name)).map((item) => binding(item.name)),
    collaboration, ...extra } as any).run('agent-root', 'native-host', 'Reconcile inventory', principal);
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-agent-host-'));
  principal = { id: 'native-lead', tenantId: 'local', projectId: 'inventory', capabilities: ['write-project-file'], identityGeneration: 1 };
  runs = new RunService(new FileRunStore(path.join(dir, 'runs')), { authorizeEgress: async () => {} }); registry = new ToolRegistry();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe('native Team orchestration hook', () => {
  test('mail stages first, the recorded parent wait then returns its member answer before a new lead call', async () => {
    const order: string[] = [];
    tool('team_send_message', () => { order.push('mail-persisted'); return { responsePending: true, teamRunId: 'team-mail-run', harnessRunId: 'member-response' }; });
    await root(['team_send_message']);
    const afterTool = async (context: any) => {
      order.push('member-dispatched'); expect(context.name).toBe('team_send_message');
      expect((await runs.get('agent-root')).steps.find((item) => item.intent.stepId === context.stepId)?.state).toBe('succeeded');
      return { ...context.output, answer: 'B is the sole discrepant row.', memberRunId: 'member-response' };
    };
    await drive([{ name: 'team_send_message', input: {} }], { validate: async () => {}, afterTool }, {}, (request) => {
      const observed = request.messages.find((item) => item.role === 'tool');
      if (observed) { order.push('next-lead'); expect(observed.output).toMatchObject({ answer: 'B is the sole discrepant row.', memberRunId: 'member-response' }); }
    });
    expect(order).toEqual(['mail-persisted', 'member-dispatched', 'next-lead']);
  });
  test('the persistent Team response and the H14 worker keep distinct identities and sequential dispatch', async () => {
    const order: string[] = [];
    tool('team_send_message', () => ({ responsePending: true, harnessRunId: 'persistent-member' })); await root(['team_send_message']);
    const team = { workerRoute: 'openrouter', advisor: false, concurrentWorkers: 1, workersPerRun: 1, advicePerRun: 0, turnCeiling: 3,
      open: async () => ({ v: 1, turn: 1, assignments: [{ index: 0, task: 'Calculate shortage', scope: ['inventory.txt'], handoffId: 'h14-handoff', childRunId: 'h14-helper', budget: { turns: 3, tokens: 15_000, wallMs: 120_000 }, envelopeId: 'h14-envelope', refusal: null, reusedFrom: null, attempt: 1, retryOf: null }] }),
      run: async () => { order.push('h14'); return [{ handoffId: 'h14-handoff', runId: 'h14-helper', outcome: 'completed', text: 'Shortage 2 units, $7.50.', reason: null, models: [] }]; } };
    await drive([{ name: 'team_send_message', input: {} }, { name: 'assign_workers', input: { tasks: [{ task: 'Calculate shortage', files: ['inventory.txt'] }] } }], {
      validate: async () => {}, afterTool: async (context: any) => { order.push('persistent-team'); return { ...context.output, answer: 'B differs.' }; },
    }, { team });
    expect(order).toEqual(['persistent-team', 'h14']);
    expect((await runs.get('agent-root')).steps.find((item) => item.intent.stepId === 'workers:1')?.intent.input).toMatchObject({ handoffs: [{ childRunId: 'h14-helper' }] });
  });
  test.each(['dispatch', 'result'] as const)('root authority is rechecked at model %s, with no next tool after revocation', async (phase) => {
    let calls = 0; let effects = 0;
    tool('read_note', () => { effects++; return {}; }); await root(['read_note']);
    await expect(drive([{ name: 'read_note', input: {} }], {
      validate: async (at: string) => { if (at === phase) throw new Error('root authority revoked'); },
    }, {}, () => { calls++; })).rejects.toThrow('root authority revoked');
    expect(calls).toBe(phase === 'dispatch' ? 0 : 1); expect(effects).toBe(0);
  });
  test('Stop during an owned response cannot accept late mail or advance to the next lead model', async () => {
    let calls = 0; tool('team_send_message', () => ({ responsePending: true })); await root(['team_send_message']);
    const running = drive([{ name: 'team_send_message', input: {} }], { validate: async () => {}, afterTool: async () => {
      await runs.cancel('agent-root', 'Stopped by the fixture owner.', principal); return { answer: 'late reply' };
    } }, {}, () => { calls++; });
    await expect(running).rejects.toThrow();
    expect(calls).toBe(2); expect((await runs.get('agent-root')).state).toBe('cancelled');
    expect((await runs.get('agent-root')).steps.some((item) => item.intent.stepId === 'observe:0' && item.state === 'succeeded')).toBe(false);
  });
  test('proposal bytes and final claim pass the collaboration acceptance gates', async () => {
    const order: string[] = []; tool('propose_write', () => { order.push('write'); return {}; }); await root(['propose_write']);
    await drive([{ name: 'propose_write', input: {} }], { validate: async () => {},
      beforeTool: async () => { order.push('exact-reviewed-bytes'); }, assertFinish: async () => { order.push('collaboration-checked'); },
    });
    expect(order).toEqual(['exact-reviewed-bytes', 'write', 'collaboration-checked']);
  });
  test('review is a separate host action and a changed proposal cannot use its earlier answer', async () => {
    let written = false; let reviewed = '';
    registry.register({ name: 'propose_write', version: '1', description: 'Propose exact bytes', effect: 'read', effectClass: 'read', permission: null,
      approval: false, destination: 'local', trustedInputRequired: false, cost: 0, schema: z.strictObject({ text: z.string() }), outputSchema: z.json(), execute: () => { written = true; return {}; } });
    await root(['propose_write']);
    const bindings = [binding('propose_write', z.strictObject({ text: z.string() }))];
    await expect(drive([{ name: 'review_report', input: { text: 'B short 2 units, $7.50.' } }, { name: 'propose_write', input: { text: 'B short 3 units.' } }], {
      validate: async () => {}, review: async (context: any) => { reviewed = context.text; return { advice: 'The first report agrees.' }; },
      beforeTool: async (context: any) => { if (context.input.text !== reviewed) throw new Error('proposal differs from reviewed bytes'); },
    }, { bindings })).rejects.toThrow('proposal differs from reviewed bytes');
    expect(reviewed).toBe('B short 2 units, $7.50.'); expect(written).toBe(false);
  });
  test('selected review cannot be skipped by a final claim, even when an old report already exists', async () => {
    await fs.writeFile(path.join(dir, 'Harness report.md'), 'B short 2 units, $7.50. No inventory system updated.');
    await root();
    await expect(drive([], { validate: async () => {}, review: async () => ({}), assertFinish: async () => { throw new Error('required review and recorded output are missing'); } })).rejects.toThrow(/review.*output.*missing/);
    expect((await runs.get('agent-root')).state).toBe('failed');
    expect((await runs.get('agent-root')).steps.some((item) => item.intent.stepId.startsWith('finish:'))).toBe(false);
  });
});

describe('one root spend ledger across exact child attempts', () => {
  test('EngineService uses the supplied root ledger and pinned effort for lead and distinct child runs', async () => {
    const base = new SpendExposure(path.join(dir, 'spend')); await base.init();
    const shared = base.forJob({ id: ROOT_JOB_KEY, capMicroUsd: micro(1_000_000) });
    const service = new EngineService(dir); (service as any).modelApi = { exposure: base };
    const requests: any[] = [], scopes: any[] = [];
    service.jobCaps = { scope: async (...args: any[]) => { scopes.push(args); return { id: ROOT_JOB_KEY, tier: 'efficient', capMicroUsd: micro(1_000_000) }; } } as any;
    service.admitModelApi = async (_route: unknown, input: any, context: any) => { requests.push({ input, context }); return { model: input.model, accountRoute: input.accountRoute } as any; };
    const adapterOptions: any[] = [];
    (service as any).openModelApi = async () => ({ secret: 'fixture-key', handle: { exposure: (ledger: SpendExposure) => ledger, adapter: (options: any) => { adapterOptions.push(options); return script([]); } } });
    for (const runId of ['agent-root', 'member-response', 'h14-helper'])
      await service.loopAdapter('openrouter', { projectId: 'inventory', runId, rootRunId: 'agent-root', rootJobId: ROOT_JOB_KEY, scopedLedger: shared,
        model: 'openai/gpt-6.1-sol', accountRoute: 'or:fixture', effort: 'medium', instructions: 'Fixture' } as any, new AbortController().signal);
    expect(adapterOptions).toHaveLength(3); expect(adapterOptions.every((item) => item.exposure === shared && item.effort === 'medium')).toBe(true);
    expect(scopes, 'supplied root scope cannot be minted again for each role').toEqual([]);
    expect(requests.map((item) => item.context.rootJobId)).toEqual([ROOT_JOB_KEY, ROOT_JOB_KEY, ROOT_JOB_KEY]);
  });
});
