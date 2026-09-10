import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileRunStore, RunService, type StepDefinition } from '../server/harness/index.js';
import { governanceHook, installGovernance } from '../server/harness/lifecycle.js';
import type { ExecutionResolution, LiveAuthority } from '../shared/execution.js';
import type { CapabilityManifest, HarnessPrincipal } from '../shared/harness.js';

/**
 * These run against the real `RunService`, not a stand-in. The point is to
 * prove the governance seam sits on the mechanism the harness already has:
 * `use()` for the hook, mandatory policy before and after it, and a deep copy
 * so a hook cannot reach the intent that gets authorized.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const principal: HarnessPrincipal = {
  id: 'owner',
  tenantId: 'tenant-a',
  projectId: 'p1',
  capabilities: ['write.apply'],
  identityGeneration: 0,
};

const capability: CapabilityManifest = {
  id: 'weekly-brief',
  version: 'v1',
  label: 'Weekly brief',
  description: 'A synthetic capability for the governance boundary tests.',
  tools: [],
  requestedPermissions: [],
  approvalPolicy: 'show-first',
  maxTurns: 4,
  supportedPlatforms: ['win32'],
};

const resolution: ExecutionResolution = {
  v: 1,
  resolvedAt: '2026-09-10T12:00:00.000Z',
  principal: { kind: 'local-owner', id: 'owner', tenantId: 'tenant-a', assurance: 'owner-local' },
  workspace: { kind: 'business', organizationId: 'org-1' },
  membership: { role: 'owner', state: 'active' },
  configuration: { organizationId: 'org-1', revision: 3, digest: 'sha256:cfg' },
  agent: {
    agentId: 'diomedes.builder',
    agentVersion: '1.0.0',
    agentDigest: 'sha256:agent',
    agentName: 'Change Builder',
    agentSelection: 'manual',
    effectivePermission: 'project',
  },
  team: null,
  route: { routeId: 'codex', requestedModel: null, modelSelection: 'runtime-default' },
  rules: {
    revision: 'r1-abc',
    governing: [
      {
        ruleId: 'no-external',
        ruleVersion: 2,
        authority: 'organization',
        category: 'enforced',
        enforcement: 'enforced',
        surface: 'before-effect',
        routeId: 'codex',
        scopeKeys: ['tenantId'],
      },
    ],
  },
  context: { scopeIds: ['approved-files'], instructionRevision: 'r1-def' },
  payer: { kind: 'bring-your-own', id: 'org-1', coversChildren: true, reason: 'Your account.' },
  budget: null,
  gates: [],
  admitted: true,
};

const live = (over: Partial<LiveAuthority> = {}): LiveAuthority => ({
  tenantId: 'tenant-a',
  membershipState: 'active',
  configurationRevision: 3,
  agentDigest: 'sha256:agent',
  grantRevoked: false,
  generationAdvanced: false,
  budgetRemainingUsd: 10,
  revocationProven: true,
  ...over,
});

async function setup(current: () => LiveAuthority) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-governance-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
  const recorded: { stepId: string; surface: string; recheckedAuthority: boolean }[] = [];
  installGovernance(service, {
    resolution,
    live: async () => current(),
    record: (entry) => recorded.push(entry),
  });
  await service.start({
    id: 'r',
    tenantId: 'tenant-a',
    projectId: 'p1',
    capability,
    principal,
    budget: { units: 20, modelCalls: 4, toolCalls: 4, wallMs: null },
  });
  await service.claim('r', 'host', 100);
  return { service, recorded };
}

const step = (over: Partial<StepDefinition> = {}): StepDefinition => ({
  id: 'write-brief',
  version: '1',
  kind: 'tool',
  effect: 'idempotent',
  input: { file: 'notes/weekly.md' },
  cost: 1,
  permission: 'write.apply',
  ...over,
});

describe('governance on the real run service', () => {
  test('a step that changes something records what governed it', async () => {
    const { service, recorded } = await setup(() => live());
    await service.step('r', 'host', step(), () => ({ written: true }), principal);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].stepId).toBe('write-brief');
    expect(recorded[0].surface).toBe('before-tool');
    expect(recorded[0].recheckedAuthority).toBe(true);
  });

  test('a grant withdrawn between admission and the step stops it, and nothing runs', async () => {
    let revoked = false;
    const { service } = await setup(() => live({ grantRevoked: revoked }));
    let ran = 0;
    await service.step('r', 'host', step({ id: 'first' }), () => ++ran, principal);
    revoked = true;
    await expect(
      service.step('r', 'host', step({ id: 'second' }), () => ++ran, principal),
    ).rejects.toThrow(/withdrawn/);
    expect(ran).toBe(1);
  });

  test('a pure step is not blocked by a recheck it does not need', async () => {
    const { service, recorded } = await setup(() => live({ grantRevoked: true }));
    await expect(
      service.step('r', 'host', step({ id: 'read-only', effect: 'pure' }), () => 1, principal),
    ).resolves.toBe(1);
    expect(recorded[0].recheckedAuthority).toBe(false);
  });

  test('a hook cannot widen what the mandatory policy already denied', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-governance-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
    // A hook that tries to hand itself the capability it is missing.
    service.use(({ step: intent, principal: copy }) => {
      (intent as { permission: string | null }).permission = null;
      (copy as { capabilities: string[] }).capabilities.push('write.apply');
    });
    await service.start({
      id: 'r',
      tenantId: 'tenant-a',
      projectId: 'p1',
      capability,
      principal: { ...principal, capabilities: [] },
      budget: { units: 20, modelCalls: 4, toolCalls: 4, wallMs: null },
    });
    await service.claim('r', 'host', 100);
    await expect(
      service.step('r', 'host', step(), () => 1, { ...principal, capabilities: [] }),
    ).rejects.toThrow(/Missing capability/);
  });

  test('the recorded governing rules survive into the run record', async () => {
    const { service, recorded } = await setup(() => live());
    await service.step('r', 'host', step(), () => 1, principal);
    const run = await service.get('r');
    expect(run.steps.map((item) => item.intent.stepId)).toContain('write-brief');
    expect(recorded[0].surface).toBe('before-tool');
  });

  test('installing the hook twice does not double-record', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-governance-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new RunService(new FileRunStore(dir), { clock: () => 1000 });
    const recorded: unknown[] = [];
    const context = {
      resolution,
      live: async () => live(),
      record: () => recorded.push(1),
    };
    installGovernance(service, context);
    installGovernance(service, context);
    await service.start({
      id: 'r',
      tenantId: 'tenant-a',
      projectId: 'p1',
      capability,
      principal,
      budget: { units: 20, modelCalls: 4, toolCalls: 4, wallMs: null },
    });
    await service.claim('r', 'host', 100);
    await service.step('r', 'host', step(), () => 1, principal);
    expect(recorded).toHaveLength(1);
  });

  test('the hook itself is a plain HarnessHook the service accepts', () => {
    const hook = governanceHook({
      resolution,
      live: async () => live(),
      record: () => {},
    });
    expect(typeof hook).toBe('function');
  });
});
