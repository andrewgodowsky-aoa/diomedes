import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';
import { PackLifecycle } from '../server/pack-lifecycle';
import { bundledCatalogue, sealManifest } from '../server/pack-catalogue';
import { FileRunStore, RunService } from '../server/harness';
import type { CapabilityManifest, HarnessPrincipal } from '../shared/harness';
import { pluginInventory } from '../shared/plugin-inventory';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-review-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  const one = await store.createProject('One');
  const other = await store.createProject('Other');
  const packs = new PackLifecycle({
    store,
    root: path.join(store.dataDir, 'packs'),
    catalogue: () => bundledCatalogue(),
  });
  return { store, packs, one: one.id, other: other.id };
}

async function source(version: string) {
  const folder = path.join(root, 'sources', version);
  await fs.mkdir(folder, { recursive: true });
  const manifest = sealManifest({
    schemaVersion: 1,
    id: 'acme.audit',
    version,
    name: 'Audit',
    publisher: { id: 'acme', name: 'Acme' },
    description: 'Declared ledger reader.',
    compatibility: { contract: '^1.0.0' },
    contributions: {
      tools: [
        {
          id: 'ledger',
          name: 'Ledger',
          description: version,
          effect: 'read',
          uses: ['read-ledger'],
        },
      ],
      agents: [],
      rules: [],
      context: [],
      workflows: [],
      ui: [],
    },
    permissions: {
      requested: [{ capability: 'read-ledger', reason: 'Read the ledger.' }],
      grantsAuthority: false,
    },
    dependencies: [],
    files: [],
  });
  await fs.writeFile(path.join(folder, 'diomedes-pack.json'), JSON.stringify(manifest));
  return { folder, manifest, source: { kind: 'directory', path: folder } };
}

test('install, activation, metadata loads, update, rollback and removal never authorize a sink', async () => {
  const { store, packs, one, other } = await setup();
  const v1 = await source('1.0.0');
  const v2 = await source('1.1.0');
  const authority = () =>
    [one, other].map((id) => {
      const state = store.state(id);
      return {
        grants: state.scopeGrants ?? [],
        view: store.scopeGrants.view(id),
        needs: state.needs,
        conversations: state.conversations,
        tasks: state.tasks,
      };
    });
  const before = structuredClone(authority());
  const runtime = new RunService(new FileRunStore(path.join(root, 'runs')), { clock: () => 1000 });
  const principal: HarnessPrincipal = {
    id: 'person',
    tenantId: 'local',
    projectId: one,
    capabilities: [],
    identityGeneration: 1,
  };
  const capability: CapabilityManifest = {
    id: 'review',
    version: '1',
    label: 'Review',
    description: 'Owned counter probe.',
    tools: ['ledger'],
    requestedPermissions: [],
    approvalPolicy: 'show-first',
    maxTurns: 8,
    supportedPlatforms: ['win32'],
  };
  let hooks = 0;
  let sinks = 0;
  runtime.use(async () => {
    hooks++;
  });
  const check = async (stage: string) => {
    expect(authority()).toEqual(before);
    await runtime.start({
      id: stage,
      tenantId: 'local',
      projectId: one,
      capability,
      principal,
      budget: { units: 10, modelCalls: 0, toolCalls: 10, wallMs: null },
    });
    await runtime.claim(stage, 'host', 1000);
    await expect(
      runtime.step(
        stage,
        'host',
        {
          id: 'ledger',
          version: '1',
          kind: 'tool',
          effect: 'read',
          permission: 'read-ledger',
        },
        () => {
          sinks++;
          return null;
        },
        principal,
      ),
    ).rejects.toThrow(/capability/);
    expect({ hooks, sinks }).toEqual({ hooks: 0, sinks: 0 });
  };
  await packs.install(v1.source);
  expect(store.state(one).project.packs ?? []).toEqual([]);
  await check('installed');
  await packs.activate(one, v1.manifest.id);
  expect(store.state(other).project.packs ?? []).toEqual([]);
  expect((await packs.installed()).find((pack) => pack.id === v1.manifest.id)?.runtime).toBe(
    'declared',
  );
  await check('activated');
  const state = store.state(one);
  const pin = await packs.contributions.admit(state, 'metadata-open');
  await packs.contributions.load(
    pin,
    { packId: v1.manifest.id, kind: 'tool', id: 'ledger' },
    {
      reason: 'opened',
      state,
    },
  );
  await check('loaded');
  await packs.update(v1.manifest.id, v2.source);
  await check('updated');
  await packs.rollback(v1.manifest.id);
  await check('rolled-back');
  await expect(packs.uninstall(v1.manifest.id)).rejects.toMatchObject({ status: 409 });
  await packs.deactivate(one, v1.manifest.id);
  await check('deactivated');
  await packs.uninstall(v1.manifest.id);
  await check('removed');
});

test('real load receipts preserve the admitted version, digest and request after rollback and removal', async () => {
  const { store, packs, one } = await setup();
  const v1 = await source('1.0.0');
  const v2 = await source('1.1.0');
  await packs.install(v1.source);
  await packs.activate(one, v1.manifest.id);
  await packs.update(v1.manifest.id, v2.source);
  const state = store.state(one);
  const old = await packs.contributions.admit(state, 'admitted-on-v2');
  await packs.rollback(v1.manifest.id);
  const fresh = await packs.contributions.admit(state, 'admitted-after-rollback');
  const ref = { packId: v1.manifest.id, kind: 'tool' as const, id: 'ledger' };
  const oldLoad = await packs.contributions.load(old, ref, { reason: 'selected', state });
  const newLoad = await packs.contributions.load(fresh, ref, { reason: 'opened', state });
  const records = pluginInventory(v1.manifest, state.contributionRecords ?? []).recentLoads;
  expect(records.map((record) => [record.packVersion, record.runKey, record.digest])).toEqual([
    ['1.0.0', 'admitted-after-rollback', newLoad.digest],
    ['1.1.0', 'admitted-on-v2', oldLoad.digest],
  ]);
  expect(oldLoad.digest).not.toBe(newLoad.digest);
  await packs.deactivate(one, v1.manifest.id);
  const history = structuredClone(state.history);
  const receipts = structuredClone(state.contributionRecords);
  await packs.uninstall(v1.manifest.id);
  const reopened = new Store(store.dataDir, path.join(root, 'projects'));
  await reopened.init();
  expect(reopened.state(one).history).toEqual(history);
  expect(reopened.state(one).contributionRecords).toEqual(receipts);
});
