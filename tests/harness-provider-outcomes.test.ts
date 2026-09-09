import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService, type StepDefinition } from '../server/harness/run-service.js';
import type { HarnessPrincipal } from '../shared/harness.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const principal: HarnessPrincipal = {
  id: 'synthetic-host', tenantId: 'local', projectId: 'synthetic',
  capabilities: [], identityGeneration: 1,
};
const model: StepDefinition = {
  id: 'provider-turn', version: 'v1', kind: 'model', effect: 'read',
  name: 'codex', destination: 'external', maxAttempts: 3,
  input: { instruction: 'Synthetic outcome test' },
  // This test covers effect recovery, not permission to disclose real documents.
  label: { tenantId: 'local', projectId: 'synthetic', integrity: 'untrusted',
    confidentiality: 'public', provenance: ['synthetic-test'] },
};
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-provider-outcome-'));
  roots.push(root);
  const files = new FileRunStore(root);
  let time = 1000;
  const options = { clock: () => time };
  const runtime = new RunService(files, options);
  await runtime.start({ id: 'test-run', tenantId: 'local', projectId: 'synthetic', principal,
    capability: { id: 'test', version: 'v1', label: 'Test', description: 'Synthetic', tools: [],
      requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 1, supportedPlatforms: ['win32'] },
    budget: { units: 5, modelCalls: 5, toolCalls: 5, wallMs: null },
  });
  await runtime.claim('test-run', 'host', 100);
  return { runtime, files, options, expire: () => { time += 101; } };
}

test('an unknown external model read is not redispatched after an error or restart', async () => {
  const { runtime, files, options, expire } = await setup();
  let dispatches = 0;
  const dispatch = () => { dispatches++; throw new Error('Acknowledgement lost after send'); };
  await expect(runtime.step('test-run', 'host', model, dispatch, principal)).rejects.toThrow('Acknowledgement lost');
  expect((await runtime.get('test-run')).state).toBe('reconcile_required');
  const restarted = new RunService(files, options);
  await restarted.recover('test-run', principal);
  expire();
  await restarted.claim('test-run', 'restarted');
  await expect(restarted.step('test-run', 'restarted', model, dispatch, principal)).rejects.toThrow('reconciliation');
  expect(dispatches).toBe(1);
});

test.each(['restart', 'ownership-change', 'cancel'] as const)(
  'an external model in flight remains uncertain on %s and ignores late success', async (event) => {
    const { runtime, files, options, expire } = await setup();
    let finish!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let dispatches = 0;
    const pending = runtime.step('test-run', 'host', model, () => {
      dispatches++; entered();
      return new Promise<string>(resolve => { finish = resolve; });
    }, principal);
    const observed = pending.catch(error => error);
    await started;
    let current = runtime;
    if (event === 'restart') {
      current = new RunService(files, options);
      await current.recover('test-run', principal);
    } else if (event === 'ownership-change') {
      expire();
      await runtime.claim('test-run', 'new-host');
      await expect(runtime.step('test-run', 'new-host', model, () => { dispatches++; return 'duplicate'; }, principal))
        .rejects.toThrow('reconciliation');
    } else await runtime.cancel('test-run', 'Synthetic Stop', principal);
    finish('late proposal');
    expect(await observed).toBeInstanceOf(Error);
    const saved = await current.get('test-run');
    expect(saved.steps[0].state).toBe('reconcile_required');
    expect(saved.steps[0].output).toBeNull();
    expect(saved.events.some(e => e.type === 'step.succeeded')).toBe(false);
    expect(dispatches).toBe(1);
  },
);

test('a completed external model observation replays without another dispatch', async () => {
  const { runtime } = await setup();
  let dispatches = 0;
  const dispatch = () => { dispatches++; return { text: 'observed synthetic result' }; };
  await runtime.step('test-run', 'host', model, dispatch, principal);
  expect(await runtime.step('test-run', 'host', model, dispatch, principal)).toEqual({ text: 'observed synthetic result' });
  expect(dispatches).toBe(1);
});

test('local scripted model reads retain their existing retry behavior', async () => {
  const { runtime } = await setup();
  const local = { ...model, destination: 'local' as const };
  await expect(runtime.step('test-run', 'host', local, () => { throw new Error('local failure'); }, principal)).rejects.toThrow();
  expect((await runtime.get('test-run')).steps[0].state).toBe('retry_wait');
  expect(await runtime.step('test-run', 'host', local, () => 'local success', principal)).toBe('local success');
});
