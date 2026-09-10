import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CapabilityManifest, HarnessPrincipal, ModelResult } from '../shared/harness.js';
import { applicationOrigin, directOrigin, formatOrigin } from '../shared/attribution.js';
import {
  FileRunStore,
  NativeAgent,
  RunService,
  ToolRegistry,
  type ModelAdapter,
} from '../server/harness/index.js';
import { needFromWaitingStep, sessionOriginFromRun } from '../server/harness/present.js';
import { Store } from '../server/store.js';
import { createHarnessHost, type HarnessHost } from '../server/harness/host.js';
import { codexContextHash } from '../server/integrations.js';
import type { Capability } from '../server/harness/trust-port.js';

/**
 * Bounded per-step provenance: immutable snapshots from trustworthy
 * adapter/runtime metadata, never from generated prose or a later picker.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

const principal: HarnessPrincipal = {
  id: 'worker',
  tenantId: 'a',
  projectId: 'p',
  capabilities: ['calculate', 'sum', 'write-project-file', 'send-to-codex'],
  identityGeneration: 1,
};
const capability: CapabilityManifest = {
  id: 'fixture',
  version: 'v1',
  label: 'Fixture capability',
  description: 'Synthetic capability for origin tests.',
  tools: ['sum'],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 8,
  supportedPlatforms: ['win32'],
};
const budget = { units: 20, modelCalls: 50, toolCalls: 50, wallMs: null };

async function setupService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-step-origin-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
  await service.start({ id: 'r', tenantId: 'a', projectId: 'p', capability, principal, budget });
  await service.claim('r', 'host', 100);
  return { service, dir };
}

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
function registry() {
  const tools = new ToolRegistry();
  tools.register(sumTool);
  return tools;
}
const directAdapter = (
  complete: () => Promise<ModelResult> | ModelResult,
  id = 'synthetic-engine',
): ModelAdapter => ({
  id,
  version: '9.9.9',
  capabilities: () => ({
    engineId: id,
    engineVersion: '9.9.9',
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
  complete: async () => complete(),
});

describe('per-step origin snapshots', () => {
  test('uses runtime-reported model, never generated prose identity', async () => {
    const { service } = await setupService();
    const transcript = {
      providerId: 'synthetic-engine',
      modelId: 'real-runtime-model',
      lineageId: 'L1',
      opaqueRef: 'thread-real',
      prefixHash: 'deadbeef',
    };
    const agent = new NativeAgent(
      service,
      directAdapter(() => ({
        response: { type: 'final', text: 'I am impostor-model from prose; my model is evil-json' },
        transcript,
      })),
      registry(),
    );
    expect(await agent.run('r', 'host', 'hello', principal)).toContain('impostor');
    const run = await service.get('r');
    const modelStep = run.steps.find((s) => s.intent.kind === 'model')!;
    expect(modelStep.origin?.mode).toBe('direct');
    expect(modelStep.origin?.engine?.id).toBe('synthetic-engine');
    expect(modelStep.origin?.model.reported).toBe('real-runtime-model');
    expect(modelStep.origin?.model.source).toBe('runtime');
    expect(JSON.stringify(modelStep.origin)).not.toContain('impostor');
    expect(JSON.stringify(modelStep.origin)).not.toContain('evil-json');
    expect(formatOrigin(modelStep.origin).primary).toBe('real-runtime-model');
    // The portable output keeps the prose; provenance stays in the snapshot.
    expect(JSON.stringify(modelStep.output)).toContain('impostor');
    expect(JSON.stringify(modelStep.intent.input)).not.toContain('thread-real');
  });

  test('scripted fixture work stays an honest application action', async () => {
    const { service } = await setupService();
    const agent = new NativeAgent(
      service,
      directAdapter(() => ({ response: { type: 'final', text: 'done' } }), 'fixture'),
      registry(),
    );
    await agent.run('r', 'host', 'hello', principal);
    const run = await service.get('r');
    for (const step of run.steps.filter((s) => s.state === 'succeeded'))
      expect(step.origin?.mode).toBe('application');
    expect(formatOrigin(run.steps[0].origin).secondary).toBe('application action');
  });

  test('later metadata never relabels a succeeded step and creates no new effect', async () => {
    const { service } = await setupService();
    let calls = 0;
    const first = directOrigin({
      engine: 'synthetic-engine',
      reportedModel: 'first-model',
      version: '1',
    });
    const def = {
      id: 'one',
      version: '1',
      kind: 'tool' as const,
      effect: 'pure' as const,
      input: { x: 1 },
      cost: 1,
      origin: first,
    };
    expect(
      await service.step(
        'r',
        'host',
        def,
        () => {
          calls++;
          return { v: 1 };
        },
        principal,
      ),
    ).toEqual({ v: 1 });
    const second = directOrigin({
      engine: 'other-engine',
      reportedModel: 'second-model',
      version: '2',
    });
    expect(
      await service.step(
        'r',
        'host',
        { ...def, origin: second },
        () => {
          calls++;
          return { v: 2 };
        },
        principal,
      ),
    ).toEqual({ v: 1 });
    expect(calls).toBe(1);
    const run = await service.get('r');
    expect(run.steps[0].origin).toEqual(first);
    expect(run.steps[0].output).toEqual({ v: 1 });
  });

  test('origin never enters the intent hash, so v1 approvals still bind', async () => {
    const { service } = await setupService();
    const base = {
      id: 'gated',
      version: '1',
      kind: 'tool' as const,
      effect: 'pure' as const,
      input: { x: 1 },
      cost: 1,
      approval: true,
    };
    await expect(
      service.step('r', 'host', { ...base, origin: applicationOrigin() }, () => 1, principal),
    ).rejects.toThrow('approval');
    const waiting = (await service.get('r')).steps[0];
    expect(waiting.origin?.mode).toBe('application');
    const approval = await service.decide(
      { runId: 'r', stepId: 'gated', decision: 'approved', decidedBy: 'manager', ttlMs: 100 },
      principal,
    );
    expect(approval.intentHash).toBe(waiting.intentHash);
    // Same intent with a different snapshot is the same step, not a mismatch.
    expect(
      await service.step(
        'r',
        'host',
        { ...base, origin: directOrigin({ engine: 'x', reportedModel: 'y' }) },
        () => 7,
        principal,
      ),
    ).toBe(7);
    expect((await service.get('r')).steps[0].origin?.mode).toBe('application');
  });

  test('legacy records without origin stay readable and unknown, never invented', async () => {
    const { service } = await setupService();
    await service.step(
      'r',
      'host',
      { id: 'legacy', version: '1', kind: 'tool', effect: 'pure', input: null, cost: 0 },
      () => ({ ok: true }),
      principal,
    );
    const run = await service.get('r');
    expect(run.steps[0].origin).toBeUndefined();
    expect(formatOrigin(run.steps[0].origin).primary).toBe('Assistant');
    expect(formatOrigin(run.steps[0].origin).secondary).toBe('model not recorded');
    expect(sessionOriginFromRun(run)).toBeUndefined();
  });

  test('snapshots survive file persistence, reopen and replay', async () => {
    const { service, dir } = await setupService();
    const snapshot = directOrigin({
      engine: 'synthetic-engine',
      requestedModel: 'asked',
      reportedModel: 'told',
      version: '9.9.9',
    });
    await service.step(
      'r',
      'host',
      {
        id: 'kept',
        version: '1',
        kind: 'tool',
        effect: 'pure',
        input: { x: 1 },
        cost: 1,
        origin: snapshot,
      },
      () => ({ v: 5 }),
      principal,
    );
    let replayed = 0;
    expect(
      await service.step(
        'r',
        'host',
        {
          id: 'kept',
          version: '1',
          kind: 'tool',
          effect: 'pure',
          input: { x: 1 },
          cost: 1,
          origin: snapshot,
        },
        () => {
          replayed++;
          return { v: 99 };
        },
        principal,
      ),
    ).toEqual({ v: 5 });
    expect(replayed).toBe(0);
    const second = new RunService(new FileRunStore(dir), { clock: () => 1000 });
    const reopened = await second.get('r');
    expect(reopened.steps[0].origin).toEqual(snapshot);
    expect(
      await second.step(
        'r',
        'host',
        { id: 'kept', version: '1', kind: 'tool', effect: 'pure', input: { x: 1 }, cost: 1 },
        () => {
          replayed++;
          return 0;
        },
        principal,
      ),
    ).toEqual({ v: 5 });
    expect(replayed).toBe(0);
  });

  test('step origin propagates to presented Need and session, legacy stays unknown', async () => {
    const { service } = await setupService();
    const snapshot = directOrigin({
      engine: 'synthetic-engine',
      reportedModel: 'need-model',
      version: '9',
    });
    await expect(
      service.step(
        'r',
        'host',
        {
          id: 'ask',
          version: '1',
          kind: 'tool',
          effect: 'pure',
          input: { files: ['a.md'] },
          cost: 0,
          approval: true,
          origin: snapshot,
        },
        () => 1,
        principal,
      ),
    ).rejects.toThrow('approval');
    const run = await service.get('r');
    const waiting = run.steps[0];
    const fields = needFromWaitingStep(run, waiting);
    expect(fields.origin).toEqual(snapshot);
    expect(fields.intentHash).toBe(waiting.intentHash);
    const legacy = { ...run, steps: [{ ...waiting, origin: undefined }] };
    expect(needFromWaitingStep(legacy as typeof run, legacy.steps[0]).origin).toBeUndefined();
    expect(sessionOriginFromRun(legacy as typeof run)).toBeUndefined();
    // Session prefers model authorship when present.
    const withModel = {
      ...run,
      steps: [
        { ...waiting, state: 'succeeded' as const, origin: applicationOrigin() },
        {
          ...waiting,
          intent: { ...waiting.intent, stepId: 'model:0', kind: 'model' as const },
          state: 'succeeded' as const,
          origin: snapshot,
        },
      ],
    };
    expect(sessionOriginFromRun(withModel as typeof run)).toEqual(snapshot);
  });

  test('a fork carries its pure origin prefix without a new effect', async () => {
    const { service } = await setupService();
    const snapshot = applicationOrigin();
    await service.step(
      'r',
      'host',
      {
        id: 'pure',
        version: '1',
        kind: 'tool',
        effect: 'pure',
        input: null,
        cost: 0,
        origin: snapshot,
      },
      () => 3,
      principal,
    );
    await service.fork('r', 'branch', 'missing', principal).catch(() => null);
    await service.step(
      'r',
      'host',
      {
        id: 'second',
        version: '1',
        kind: 'tool',
        effect: 'pure',
        input: null,
        cost: 0,
        origin: snapshot,
      },
      () => 4,
      principal,
    );
    await service.fork('r', 'child', 'second', principal);
    const child = await service.get('child');
    expect(child.steps.map((s) => s.intent.stepId)).toEqual(['pure']);
    expect(child.steps[0].origin).toEqual(snapshot);
  });
});

describe('codex host origin', () => {
  let root: string;
  let store: Store;
  let host: HarnessHost;
  let projectId: string;
  let calls: number;
  const accountRoute = 'openai:chatgpt:synthetic-account';
  const selection = { model: 'synthetic-model', effort: 'low' };
  const output = {
    text: JSON.stringify({
      summary: 'A synthetic report',
      changes: [{ path: 'Harness report.md', text: '# Synthetic report\n', summary: 'A report' }],
    }),
    model: 'synthetic-reported',
    version: '0.153.4',
    threadId: 'synthetic-transcript',
  };
  test('codex turn keeps requested/reported/accountRoute, write stays application', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-step-origin-codex-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    calls = 0;
    // Freeze authority expiry for this run: prepare and dispatch digests must match.
    const authorityExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    host = createHarnessHost({
      store,
      dataDir: store.dataDir,
      currentAuthority: async () => ({
        principal: {
          kind: 'prototype',
          id: 'synthetic-host',
          tenantId: null,
          projectId: null,
          deviceId: null,
          sessionId: null,
          slotId: null,
        },
        generation: { identity: 1, principal: 1 },
        capabilities: new Set<Capability>([
          'work.submit',
          'work.cancel',
          'egress.send',
          'egress.reconcile',
          'write.apply',
          'approval.decide',
          'project.read',
        ]),
        assurance: 'prototype',
        synthetic: true,
        expiresAt: authorityExpiry,
        resolvedAt: new Date().toISOString(),
      }),
      codexAccountRoute: async () => accountRoute,
      codexGenerator: async (input) => {
        await input.beforeDispatch!({
          accountRoute,
          contextHash: codexContextHash({
            ...input,
            instructions: input.instructions!,
            model: input.model!,
            effort: input.effort!,
          }),
        });
        calls++;
        return output;
      },
    });
    await host.init();
    const project = await store.locked(() => store.createProject('Synthetic Codex'));
    projectId = project.id;
    await fs.writeFile(path.join(project.folder, 'Synthetic.txt'), 'Three synthetic locations.\n');
    store.settings.services = { codex: true };
    store.settings.permissions.sending = true;
    await store.saveSettings(store.settings);
    const task = await store.locked(async () => {
      const t = store.createTask(store.state(projectId), {
        name: 'Report',
        description: 'Synthetic',
        owner: 'diomedes-with-ok',
      });
      await store.persist(store.state(projectId));
      return t;
    });
    const command = {
      protocolVersion: 1,
      commandId: 'synthetic-command',
      taskId: task.id,
      route: 'codex',
      capabilityId: 'codex-report',
      instruction: 'Summarize.',
      sources: ['Synthetic.txt'],
      consent: true,
    };
    await host.startCodexReport(projectId, command, selection);
    await vi.waitFor(
      () => expect(store.state(projectId).needs.find((n) => n.state === 'open')).toBeTruthy(),
      { timeout: 5000 },
    );
    const need = structuredClone(store.state(projectId).needs.find((n) => n.state === 'open')!);
    const run = await host.get(projectId, need.harness!.runId);
    const turn = run.steps.find((s) => s.intent.stepId === 'codex:turn')!;
    expect(turn.state).toBe('succeeded');
    expect(turn.origin?.mode).toBe('direct');
    expect(turn.origin?.engine?.id).toBe('codex');
    expect(turn.origin?.model.requested).toBe('synthetic-model');
    expect(turn.origin?.model.reported).toBe('synthetic-reported');
    expect(need.origin?.model.reported).toBe('synthetic-reported');
    expect(store.state(projectId).sessions.find((s) => s.id === need.sessionId)?.origin).toEqual(
      turn.origin,
    );
    expect(turn.origin?.model.source).toBe('runtime');
    expect(turn.origin?.accountRoute).toBe(accountRoute);
    expect(JSON.stringify(turn.origin)).not.toContain('Synthetic report');
    const write = run.steps.find((s) => s.intent.stepId === 'codex:write')!;
    expect(write.origin?.mode).toBe('application');
    expect(sessionOriginFromRun(run)).toEqual(turn.origin);
    await host.close();
  }, 15000);
});
