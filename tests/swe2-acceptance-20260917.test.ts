import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { contractChecks, streamChecks } from '../server/harness/conformance.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import type { TransientPreview } from '../shared/adapter-contract.js';
import type { IntegrationStatus } from '../shared/types.js';
import { fixtureTextDispatch } from './h01-fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-acceptance-'));
  roots.push(root);
  return root;
}

describe('H01 independent acceptance: conformance observes actual identity', () => {
  it('rejects a stream consistently attributed to a different run than its container', async () => {
    const service = new RunService(new FileRunStore(await temporary()));
    await service.start({
      id: 'run-review', tenantId: 'tenant', projectId: 'project',
      principal: { id: 'worker', tenantId: 'tenant', projectId: 'project', capabilities: [], identityGeneration: 1 },
      capability: { id: 'fixture', version: '1', label: 'Fixture', description: 'Offline test', tools: [], requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 1, supportedPlatforms: ['win32'] },
      budget: { units: 1, modelCalls: 1, toolCalls: 1, wallMs: null },
    });
    const run = await service.get('run-review');
    expect(streamChecks(run).some((c) => c.outcome === 'failed')).toBe(false);
    for (const event of run.events) event.runId = 'different-run';
    expect(streamChecks(run).some((c) => c.outcome === 'failed')).toBe(true);
  });
  it('reports a malformed descriptor as failed conformance without throwing', () => {
    const contract = structuredClone(routeContractFor('cursor'));
    delete (contract as Partial<typeof contract>).streaming;
    expect(() => contractChecks(contract)).not.toThrow();
    expect(contractChecks(contract).some((c) => c.outcome === 'failed')).toBe(true);
  });
});

describe('H01 independent acceptance: previews stop when dispatch settles', () => {
  it.each(['success', 'failure'] as const)('refuses late preview after %s', async (outcome) => {
    const engine = 'cursor';
    const frames: TransientPreview[] = [];
    let delta: ((text: string) => void) | undefined;
    const installed: IntegrationStatus = {
      id: engine, name: engine, kind: 'online', found: true, available: false,
      enabled: false, status: 'Installed', detail: 'Offline fixture', capabilities: [],
      signIn: 'unknown', adapter: 'planned', installedVersion: TESTED_VERSIONS[engine],
      location: 'fixture.exe', disclosure: [],
    };
    const root = await temporary();
    const service = new EngineService(root, {
      discover: async () => [installed], version: async () => TESTED_VERSIONS[engine],
      adapter: () => ({
        id: engine, contract: structuredClone(routeContractFor(engine)),
        inspect: async () => ({ authentication: 'signed-in', accountRoute: 'fixture-account',
          models: [{ slug: 'fixture-model', name: 'Fixture', description: '', efforts: [], defaultEffort: null }], detail: 'Fixture' }),
        generate: async (input) => {
          delta = input.onDelta;
          delta?.('current');
          if (outcome === 'failure') throw new Error('fixture failure');
          return { projectId: input.projectId, threadId: input.threadId, requestId: input.requestId,
            model: input.model, version: TESTED_VERSIONS[engine], text: 'done' };
        },
      }),
    });
    service.dispatch = fixtureTextDispatch(path.join(root, 'runs'), {
      cursorAccountRoute: 'fixture-account',
    }).dispatch;
    try {
      const work = service.generate(engine, {
        projectId: 'p', threadId: 't', requestId: 'q', model: 'fixture-model',
        accountRoute: 'fixture-account', prompt: 'Fixture', instructions: '', documents: [],
        onPreview: (frame) => frames.push(frame),
      });
      if (outcome === 'failure') await expect(work).rejects.toThrow('fixture failure');
      else await work;
      delta?.('stale');
      expect(frames.map((frame) => frame.text)).toEqual(['current']);
    } finally { service.close(); }
  });
});
