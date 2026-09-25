/**
 * H16 — the hold-before-admission invariant. A stream-time rule that holds a
 * proposed tool intent does so through H12 admission itself: RunService's
 * hook returns a hold, and the step waits at the same approval gate every
 * harness step already has. The effect never runs, and no effect intent is
 * written, before a person answers; a go-ahead binds to the exact intent, and
 * a decline cancels the run with the effect never having run.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CapabilityManifest, HarnessPrincipal } from '../shared/harness.js';
import { FileRunStore, RunService, Suspended, ToolRegistry } from '../server/harness/index.js';
import type { HarnessHook } from '../server/harness/run-service.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: HarnessPrincipal = {
  id: 'worker',
  tenantId: 'a',
  projectId: 'p',
  capabilities: ['write-project-file'],
  identityGeneration: 1,
};
const capability: CapabilityManifest = {
  id: 'h16-fixture',
  version: 'v1',
  label: 'H16 fixture',
  description: 'A write with no approval policy of its own.',
  tools: ['note'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 4,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
};

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h16-hold-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
  const tools = new ToolRegistry();
  const ran: string[] = [];
  const seen: Parameters<HarnessHook>[0][] = [];
  tools.register({
    name: 'note',
    version: '1',
    description: 'Write one note.',
    effect: 'idempotent',
    effectClass: 'idempotent-write',
    permission: 'write-project-file',
    // No approval policy: without the hold this would run at once.
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 0,
    schema: z.strictObject({ path: z.string(), text: z.string() }),
    outputSchema: z.strictObject({ written: z.string() }),
    targets: (input) => [input.path],
    execute: async ({ input }) => {
      ran.push(input.path);
      return { written: input.path };
    },
  });
  service.use((context) => {
    seen.push(context);
    return context.step.name === 'note' && context.effect?.targets.some((target) => target.startsWith('ledger/'))
      ? { hold: { reason: 'Writes to the ledger wait for a person.', refs: ['project:ledger-writes@1'] } }
      : undefined;
  });
  await service.start({
    id: 'r',
    tenantId: 'a',
    projectId: 'p',
    capability,
    principal,
    budget: { units: 10, modelCalls: 2, toolCalls: 10, wallMs: null },
    tools,
  });
  await service.claim('r', 'host', 60_000);
  const call = (stepId: string, target: string) =>
    tools.dispatch(service, {
      runId: 'r',
      owner: 'host',
      principal,
      stepId,
      name: 'note',
      input: { path: target, text: 'x' },
    });
  return { dir, service, tools, ran, seen, call };
}

describe('H16 hold before admission', () => {
  test('a held intent waits for a person: the effect never runs and no effect intent is written first', async () => {
    const h = await setup();
    await expect(h.call('w1', 'ledger/june.md')).rejects.toBeInstanceOf(Suspended);
    expect(h.ran).toEqual([]);
    const run = await h.service.get('r');
    const step = run.steps.find((item) => item.intent.stepId === 'w1')!;
    expect(step.state).toBe('waiting_approval');
    expect(step.effects ?? []).toEqual([]);
    expect(run.state).toBe('waiting');
    const held = run.events.find((event) => event.type === 'step.held');
    expect(held?.stepId).toBe('w1');
    expect(held?.attributes).toMatchObject({ refs: ['project:ledger-writes@1'], reason: 'Writes to the ledger wait for a person.' });
    // The hook saw the H12 effect declaration it judges: the tool, its class and its targets.
    expect(h.seen[0].effect).toEqual({ tool: 'note', effectClass: 'idempotent-write', targets: ['ledger/june.md'] });

    // Asking again without an answer still holds and still runs nothing.
    await expect(h.call('w1', 'ledger/june.md')).rejects.toBeInstanceOf(Suspended);
    expect(h.ran).toEqual([]);

    // The person says go ahead: the approval binds to that exact intent and the effect runs once.
    await h.service.decide({ runId: 'r', stepId: 'w1', decision: 'approved', decidedBy: 'person', ttlMs: 60_000 }, principal);
    expect(h.ran).toEqual([]);
    await expect(h.call('w1', 'ledger/june.md')).resolves.toEqual({ written: 'ledger/june.md' });
    expect(h.ran).toEqual(['ledger/june.md']);
    const after = await h.service.get('r');
    const effect = after.steps.find((item) => item.intent.stepId === 'w1')!.effects!.at(-1)!;
    expect(effect.authorization).toBe(`approval:${step.intentHash}`);
    expect(effect.status).toBe('applied');
  });

  test('a declined hold cancels the run and the effect never runs', async () => {
    const h = await setup();
    await expect(h.call('w1', 'ledger/june.md')).rejects.toBeInstanceOf(Suspended);
    await h.service.decide({ runId: 'r', stepId: 'w1', decision: 'denied', decidedBy: 'person', ttlMs: 60_000 }, principal);
    await expect(h.call('w1', 'ledger/june.md')).rejects.toThrow(/cancelled/);
    expect(h.ran).toEqual([]);
    expect((await h.service.get('r')).state).toBe('cancelled');
  });

  test('an intent no rule holds is admitted as before, with nothing held', async () => {
    const h = await setup();
    await expect(h.call('w2', 'notes/june.md')).resolves.toEqual({ written: 'notes/june.md' });
    expect(h.ran).toEqual(['notes/june.md']);
    expect((await h.service.get('r')).events.some((event) => event.type === 'step.held')).toBe(false);
  });

  test('a hold survives a restart: a fresh service over the same files still holds until the person answers', async () => {
    const h = await setup();
    await expect(h.call('w1', 'ledger/june.md')).rejects.toBeInstanceOf(Suspended);
    const restarted = new RunService(new FileRunStore(h.dir), { clock: () => 2000 });
    restarted.use((context) =>
      context.step.name === 'note' ? { hold: { reason: 'Writes to the ledger wait for a person.', refs: ['project:ledger-writes@1'] } } : undefined,
    );
    await restarted.recover('r', principal);
    await restarted.claim('r', 'host-2', 60_000);
    const again = () =>
      h.tools.dispatch(restarted, { runId: 'r', owner: 'host-2', principal, stepId: 'w1', name: 'note', input: { path: 'ledger/june.md', text: 'x' } });
    await expect(again()).rejects.toBeInstanceOf(Suspended);
    expect(h.ran).toEqual([]);
    await restarted.decide({ runId: 'r', stepId: 'w1', decision: 'approved', decidedBy: 'person', ttlMs: 60_000 }, principal);
    await expect(again()).resolves.toEqual({ written: 'ledger/june.md' });
    expect(h.ran).toEqual(['ledger/june.md']);
  });
});
