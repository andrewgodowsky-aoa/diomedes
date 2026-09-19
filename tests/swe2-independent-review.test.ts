// Adapted by SWE from the earlier independent review: fixtureTextDispatch and
// required preview identity fields were added. Assertions are retained; this
// producer-side regression copy is neither byte-identical nor a fresh verdict.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  ADMISSION_FIXTURES,
  decideAdmission,
  leaseUsable,
  type CredentialLease,
} from '../services/control-plane/contract/index.js';
import { OUTPUT_DELTA, transientPreviewSchema } from '../shared/adapter-contract.js';
import { contractChecks, streamChecks } from '../server/harness/conformance.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { FileRunStore, RunService } from '../server/harness/index.js';
import type { HarnessRun } from '../shared/harness.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { fixtureTextDispatch } from './h01-fixture.js';
import { EXTERNAL_ENGINES } from '../shared/engines.js';
import type { IntegrationStatus } from '../shared/types.js';

const now = '2026-09-17T03:00:00.000Z';
const generation = { identity: 1, principal: 1 };
const lease: CredentialLease = {
  handle: 'review-handle', principalId: 'person-a', tenantId: 'tenant-a',
  resources: ['repo-a'], scopes: ['read'], generation,
  expiresAt: '2026-09-18T03:00:00.000Z',
};

describe('B00: expiry predicates must fail closed', () => {
  it('control: valid future lease works and valid expired lease is refused', () => {
    expect(leaseUsable(lease, generation, now).usable).toBe(true);
    expect(leaseUsable({ ...lease, expiresAt: '2026-09-01T00:00:00.000Z' }, generation, now).usable).toBe(false);
  });
  it.each(['', 'not-a-date'])('refuses a lease with unknown expiry: %j', (expiresAt) => {
    expect(leaseUsable({ ...lease, expiresAt }, generation, now).usable).toBe(false);
  });
  it('refuses a lease when the observation time is invalid', () => {
    expect(leaseUsable(lease, generation, 'invalid-clock').usable).toBe(false);
  });
  it.each([null, '', 'not-a-date'])('refuses active managed entitlement with unprovable expiry: %j', (expiresAt) => {
    const input = structuredClone(ADMISSION_FIXTURES.active.view);
    expect(decideAdmission({ ...input, entitlement: { ...input.entitlement, expiresAt } }).decided).toBe('refused');
  });
  it('refuses an already expired entitlement if the clock is invalid', () => {
    const input = structuredClone(ADMISSION_FIXTURES.expired.view);
    expect(decideAdmission({ ...input, at: 'invalid-clock' }).decided).toBe('refused');
  });
  it('control: the existing suspension fixture is refused', () => {
    expect(decideAdmission(ADMISSION_FIXTURES['security-suspended'].view)).toMatchObject({ decided: 'refused', code: 'security_suspended' });
  });
});

describe('H01: conformance must reject false completion and stale proof', () => {
  let root: string;
  let run: HarnessRun;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-review-'));
    const service = new RunService(new FileRunStore(root));
    await service.start({
      id: 'review-run', tenantId: 'tenant-a', projectId: 'project-a',
      principal: { id: 'worker', tenantId: 'tenant-a', projectId: 'project-a', capabilities: [], identityGeneration: 1 },
      capability: { id: 'review-fixture', version: '1', label: 'Review fixture', description: 'Offline conformance input', tools: [], requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 1, supportedPlatforms: ['win32'] },
      budget: { units: 1, modelCalls: 1, toolCalls: 1, wallMs: null },
    });
    run = await service.get('review-run');
  });
  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it('control: a newly created live run can have no terminal event', () => {
    expect(streamChecks(run).filter((c) => c.outcome === 'failed')).toEqual([]);
  });
  it.each(['completed', 'failed', 'cancelled'] as const)('rejects state %s without its terminal event', (state) => {
    const corrupted = structuredClone(run);
    corrupted.state = state;
    expect(streamChecks(corrupted).some((c) => c.outcome === 'failed')).toBe(true);
  });
  it('rejects a terminal event that disagrees with the persisted run state', () => {
    const corrupted = structuredClone(run);
    corrupted.state = 'failed';
    corrupted.events.push({ v: 1, seq: corrupted.lastSeq + 1, runId: corrupted.id, at: now, type: 'run.completed', attributes: {} });
    corrupted.lastSeq += 1;
    expect(streamChecks(corrupted).some((c) => c.outcome === 'failed')).toBe(true);
  });
  it('rejects old conformance proof when the engine version changes', () => {
    const descriptor = structuredClone(routeContractFor('cursor'));
    descriptor.engine.version = 'unreviewed-version';
    expect(contractChecks(descriptor).some((c) => c.outcome === 'failed')).toBe(true);
  });
});

describe('H01: preview bound is in UTF-8 bytes', () => {
  const preview = {
    kind: 'text-delta' as const,
    projectId: 'p', threadId: 't', requestId: 'q',
    runId: 'p-q', stepId: 'text:dispatch', attempt: 1, fence: 1, seq: 0,
  };
  it('control: an ASCII frame inside the byte limit is allowed', () => {
    expect(transientPreviewSchema.safeParse({ ...preview, text: 'x'.repeat(OUTPUT_DELTA.maxChunkBytes) }).success).toBe(true);
  });
  it('rejects a multibyte frame over the advertised byte limit', () => {
    const text = '\u20ac'.repeat(30_000);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(OUTPUT_DELTA.maxChunkBytes);
    expect(transientPreviewSchema.safeParse({ ...preview, text }).success).toBe(false);
  });
});

describe('H01: dispatch consumes the declared command contract', () => {
  it.each(EXTERNAL_ENGINES)('%s cannot start when its bound descriptor says unsupported', async (engine) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-dispatch-review-'));
    const descriptor = structuredClone(routeContractFor(engine));
    descriptor.commands.start = { support: 'unsupported', note: 'Disabled in this offline acceptance fixture.' };
    let dispatches = 0;
    const installed: IntegrationStatus = {
      id: engine, name: engine, kind: 'online', found: true, available: false,
      enabled: false, status: 'Installed', detail: 'Synthetic review fixture',
      capabilities: [], signIn: 'unknown', adapter: 'planned',
      installedVersion: TESTED_VERSIONS[engine], location: 'fixture.exe', disclosure: [],
    };
    const service = new EngineService(root, {
      discover: async () => [installed],
      version: async () => TESTED_VERSIONS[engine],
      adapter: () => ({
        id: engine, contract: descriptor,
        inspect: async () => ({ authentication: 'signed-in', accountRoute: 'fixture:account', models: [{ slug: 'fixture-model', name: 'Fixture', description: '', efforts: [], defaultEffort: null }], detail: 'Offline fixture' }),
        generate: async (input) => {
          dispatches += 1;
          return { projectId: input.projectId, threadId: input.threadId, requestId: input.requestId, model: input.model, text: 'Fixture completed', version: TESTED_VERSIONS[engine] };
        },
      }),
    });
    service.dispatch = fixtureTextDispatch(path.join(root, 'runs')).dispatch;
    try {
      const outcome = await service.generate(engine, {
        projectId: 'p', threadId: 't', requestId: 'q', model: 'fixture-model',
        accountRoute: 'fixture:account', prompt: 'Offline fixture', instructions: '', documents: [],
      }).then(() => 'sent', () => 'refused');
      expect({ outcome, dispatches }).toEqual({ outcome: 'refused', dispatches: 0 });
    } finally {
      service.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
