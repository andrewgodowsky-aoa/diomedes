import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { HarnessPrincipal, Json, ModelRequest } from '../shared/harness.js';
import { connectorManifestSchema } from '../shared/connections.js';
import type { Rule } from '../shared/connection-rules.js';
import { digest } from '../server/harness/policy.js';
import { ConnectionsService } from '../server/connections/service.js';
import {
  createConnectionFixture,
  toastConnector,
  catalogConnector,
  catalogManifest,
  fixtureStockEvent,
  connectionFixtureModel,
} from '../server/connections/fixture.js';
import {
  normalizeStock,
  TOAST_ITEMS,
  TOAST_RESOURCES,
  toastManifest,
} from '../server/connections/toast.js';
import {
  evaluateRules,
  enforceRules,
  interceptionGuarantees,
  proposeRule,
  replayRules,
  selectRules,
} from '../server/rules.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const startTime = Date.parse('2026-09-09T08:00:00.000Z');
const all = { resources: TOAST_RESOURCES.map((resource) => resource.id), itemIds: TOAST_ITEMS };
type Fixture = Awaited<ReturnType<typeof createConnectionFixture>>;
async function fixture(options: Parameters<typeof createConnectionFixture>[1] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-connections-'));
  const f = await createConnectionFixture(root, { clock: () => startTime, ...options });
  cleanup.push(async () => {
    await f.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...f, root };
}
async function lowRule(f: Fixture, threshold = 5) {
  const { proposal, digest: expected } = await f.service.propose(
    f.project.id,
    'toast-group',
    `Alert a manager when reported quantity is at most ${threshold}`,
  );
  await f.service.activate(f.project.id, 'toast-group', proposal.id, expected);
  return proposal;
}
async function event(
  f: Fixture,
  at = new Date(startTime).toISOString(),
  quantity = 4,
  id?: string,
) {
  const raw = fixtureStockEvent(at, quantity, id);
  return f.service.accept(f.project.id, 'toast-group', raw, f.sign(raw, at));
}
async function read(f: Fixture, input: Json = all) {
  const id = await f.service.admit(f.project.id, 'toast-group', all.resources, [
    'get_item_availability',
  ]);
  const result = await f.service.invoke(id, 'get_item_availability', input);
  return { id, result };
}
const guidance = (
  id: string,
  scope: Rule['scope'] = {},
  text = 'Use the business terminology.',
): Rule => ({
  id,
  version: 1,
  enabled: true,
  scope,
  type: 'standing',
  action: 'context',
  text,
  predicate: null,
  provenance: {
    source: 'reviewed fixture business rule',
    connectorVersion: null,
    trust: 'host-reviewed',
  },
});

describe('Connections end-to-end and durability', () => {
  test('three scoped locations -> typed Runtime read -> signed event -> one durable Task -> restart -> revoke', async () => {
    let time = startTime;
    const f = await fixture({ clock: () => time });
    const { id, result } = await read(f);
    expect(JSON.stringify(result)).toContain('not-tracked');
    const run = await f.host.runs.get(id);
    expect(run.steps[0].intent.effect).toBe('read');
    expect(run.steps[0].state).toBe('succeeded');
    expect(run.events.findIndex((e) => e.type === 'step.started')).toBeLessThan(
      run.events.findIndex((e) => e.type === 'step.succeeded'),
    );
    await lowRule(f);
    time += 1000;
    expect(await event(f, new Date(time).toISOString())).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect(f.store.state(f.project.id).tasks).toHaveLength(0); // Acknowledge before triage.
    await Promise.all([f.service.drain(f.project.id), f.service.drain(f.project.id)]);
    expect(await event(f, new Date(time).toISOString())).toMatchObject({ duplicate: true });
    expect(f.store.state(f.project.id).tasks).toHaveLength(1);
    const task = f.store.state(f.project.id).tasks[0];
    expect(task.description).toContain('Reported quantity: 4');
    expect(task.description).toContain('low-stock');
    expect(task.description).toContain('Source time:');
    expect(
      f.service.snapshot(f.project.id).connections.inbox[0].rules[0].provenance.source,
    ).toBeTruthy();
    await f.close();
    const second = await createConnectionFixture(f.root, { clock: () => time });
    cleanup.push(() => second.close());
    await second.service.recover(second.project.id);
    expect(second.store.state(second.project.id).tasks.map((item) => item.id)).toEqual([task.id]);
    expect(await event(second, new Date(time).toISOString())).toMatchObject({ duplicate: true });
    await second.service.control(second.project.id, 'toast-group', 'disconnected');
    await expect(read(second)).rejects.toThrow(/not active/);
    await expect(event(second, new Date(time).toISOString())).rejects.toThrow(/not active/);
  });

  test('admitted but unprocessed event survives host recreation', async () => {
    const f = await fixture();
    await lowRule(f);
    await event(f);
    await f.close();
    const reopened = await createConnectionFixture(f.root, { clock: () => startTime });
    cleanup.push(() => reopened.close());
    await reopened.service.recover(reopened.project.id);
    expect(reopened.store.state(reopened.project.id).tasks).toHaveLength(1);
    const receipt = reopened.service.snapshot(reopened.project.id).connections.inbox[0];
    expect((await reopened.host.runs.get(receipt.runId)).state).toBe('completed');
  });

  test('failed Store commit leaves no task in memory; retry does not lose or duplicate work', async () => {
    const f = await fixture();
    await lowRule(f);
    await event(f);
    const persist = f.store.persist.bind(f.store);
    let failed = false;
    f.store.persist = async (state) => {
      if (!failed && state.tasks.length) {
        failed = true;
        throw new Error('fixture disk failure');
      }
      return persist(state);
    };
    await expect(f.service.drain(f.project.id)).rejects.toThrow('fixture disk failure');
    expect(f.store.state(f.project.id).tasks).toHaveLength(0);
    expect(f.service.snapshot(f.project.id).connections.inbox[0].state).toBe('pending');
    await f.service.drain(f.project.id);
    expect(f.store.state(f.project.id).tasks).toHaveLength(1);
  });

  test('crash after issue commit but before Runtime checkpoint recovers through the same receipt', async () => {
    const f = await fixture();
    await lowRule(f);
    await event(f);
    const persist = f.store.persist.bind(f.store);
    let failed = false;
    f.store.persist = async (state) => {
      await persist(state);
      if (!failed && state.tasks.length) {
        failed = true;
        throw new Error('fixture crash after persist');
      }
    };
    await expect(f.service.drain(f.project.id)).rejects.toThrow('fixture crash');
    await f.close();
    const reopened = await createConnectionFixture(f.root, { clock: () => startTime });
    cleanup.push(() => reopened.close());
    await reopened.service.recover(reopened.project.id);
    expect(reopened.store.state(reopened.project.id).tasks).toHaveLength(1);
  });

  test.each(['before', 'after'])(
    'interruption %s Runtime start retains an exact recoverable binding',
    async (boundary) => {
      const f = await fixture();
      await lowRule(f);
      await event(f);
      const start = f.host.runs.start.bind(f.host.runs);
      f.host.runs.start = async (input) => {
        if (boundary === 'after') await start(input);
        throw new Error('fixture admission interruption');
      };
      await expect(f.service.drain(f.project.id)).rejects.toThrow('fixture admission interruption');
      expect(Object.keys(f.service.snapshot(f.project.id).connections.bindings)).toHaveLength(1);
      await f.close();
      const reopened = await createConnectionFixture(f.root, { clock: () => startTime });
      cleanup.push(() => reopened.close());
      await reopened.service.recover(reopened.project.id);
      const receipt = reopened.service.snapshot(reopened.project.id).connections.inbox[0];
      expect((await reopened.host.runs.get(receipt.runId)).state).toBe('completed');
      expect(reopened.store.state(reopened.project.id).tasks).toHaveLength(1);
    },
  );

  test('pending admission cannot silently rebind to a replacement identity', async () => {
    let generation = 1;
    const f = await fixture({
      principal: async (projectId) => ({
        id: 'fixture-worker',
        tenantId: 'local',
        projectId,
        identityGeneration: generation,
        capabilities: ['connections.read', 'connections.manage', 'issues.create'],
      }),
    });
    await lowRule(f);
    await event(f);
    const start = f.host.runs.start.bind(f.host.runs);
    f.host.runs.start = async () => {
      throw new Error('before start');
    };
    await expect(f.service.drain(f.project.id)).rejects.toThrow('before start');
    f.host.runs.start = start;
    generation++;
    await expect(f.service.drain(f.project.id)).rejects.toThrow(/different scope or authority/);
    expect(f.store.state(f.project.id).tasks).toHaveLength(0);
  });

  test('a stale queued event records reconciliation instead of creating a current alert', async () => {
    let time = startTime;
    const f = await fixture({ clock: () => time });
    await lowRule(f);
    await event(f);
    time += 300001;
    await f.service.drain(f.project.id);
    expect(f.store.state(f.project.id).tasks).toHaveLength(0);
    expect((await f.service.status(f.project.id, 'toast-group')).health).toBe(
      'reconciliation-required',
    );
  });

  test('old and conflicting same-time events do not overwrite newer observations', async () => {
    const f = await fixture();
    await lowRule(f);
    await event(f, new Date(startTime).toISOString(), 9);
    await f.service.drain(f.project.id);
    await event(
      f,
      new Date(startTime - 1000).toISOString(),
      4,
      '30000000-0000-4000-8000-000000000002',
    );
    await f.service.drain(f.project.id);
    expect(f.store.state(f.project.id).tasks).toHaveLength(0);
    await event(f, new Date(startTime).toISOString(), 3, '30000000-0000-4000-8000-000000000003');
    await f.service.drain(f.project.id);
    expect((await f.service.status(f.project.id, 'toast-group')).health).toBe(
      'reconciliation-required',
    );
    expect(
      Object.values(f.service.snapshot(f.project.id).connections.observations)[0].facts.quantity,
    ).toBe(9);
  });

  test('an ignored-event receipt also completes its Runtime checkpoint after interruption', async () => {
    const f = await fixture();
    await lowRule(f);
    await event(f, new Date(startTime).toISOString(), 9);
    await f.service.drain(f.project.id);
    await event(
      f,
      new Date(startTime - 1000).toISOString(),
      4,
      '30000000-0000-4000-8000-000000000088',
    );
    const persist = f.store.persist.bind(f.store);
    f.store.persist = async (state) => {
      await persist(state);
      if (state.connections?.inbox.some((receipt) => receipt.state === 'ignored'))
        throw new Error('fixture stop after ignored receipt');
    };
    await expect(f.service.drain(f.project.id)).rejects.toThrow(
      'fixture stop after ignored receipt',
    );
    await f.close();
    const reopened = await createConnectionFixture(f.root, { clock: () => startTime });
    cleanup.push(() => reopened.close());
    await reopened.service.recover(reopened.project.id);
    const receipt = reopened.service.snapshot(reopened.project.id).connections.inbox.at(-1)!;
    expect(receipt.state).toBe('ignored');
    expect((await reopened.host.runs.get(receipt.runId)).state).toBe('completed');
    expect(reopened.store.state(reopened.project.id).tasks).toHaveLength(0);
  });

  test('changed signed content under one event identity is refused', async () => {
    const f = await fixture();
    await event(f);
    await expect(event(f, new Date(startTime).toISOString(), 3)).rejects.toThrow(
      /different signed content/,
    );
  });
  test('invalid signature, mismatched header, future timestamp and unauthorized location are refused', async () => {
    const f = await fixture(),
      at = new Date(startTime).toISOString(),
      raw = fixtureStockEvent(at);
    await expect(f.service.accept(f.project.id, 'toast-group', raw, 'invalid')).rejects.toThrow(
      /signature/,
    );
    await expect(
      f.service.accept(f.project.id, 'toast-group', raw, f.sign(raw, at), TOAST_RESOURCES[1].id),
    ).rejects.toThrow(/disagree/);
    await expect(event(f, new Date(startTime + 600000).toISOString())).rejects.toThrow(/window/);
    const other = raw.replace(TOAST_RESOURCES[0].id, '99999999-0000-4000-8000-000000000001');
    await expect(
      f.service.accept(f.project.id, 'toast-group', other, f.sign(other, at)),
    ).rejects.toThrow(/approved locations/);
    expect(f.service.snapshot(f.project.id).connections.inbox).toHaveLength(0);
  });
});

describe('typed contracts and pre-effect boundaries', () => {
  test('second connector uses the same contract with a different result schema', async () => {
    const f = await fixture();
    const base = f.service.snapshot(f.project.id).connections.instances[0];
    await f.service.install(f.project.id, {
      ...base,
      id: 'catalog-instance',
      connectorId: 'catalog',
      version: catalogManifest.version,
      manifestDigest: digest(catalogManifest),
      resources: [{ id: 'catalog', name: 'Catalogue' }],
      operations: ['list_items'],
      vendorScopes: [],
    });
    const runId = await f.service.admit(
      f.project.id,
      'catalog-instance',
      ['catalog'],
      ['list_items'],
    );
    expect(await f.service.invoke(runId, 'list_items', { resources: ['catalog'] })).toMatchObject({
      result: { items: [{ id: 1, name: 'Example item' }] },
    });
  });
  test('a model cannot gain registration by copying the fixture adapter identifier', async () => {
    const f = await fixture(),
      runId = await f.service.admit(f.project.id, 'toast-group', all.resources, [
        'get_item_availability',
      ]);
    let called = false;
    const forged = {
      ...connectionFixtureModel(all),
      complete: async () => {
        called = true;
        throw new Error('must not run');
      },
    };
    await expect(f.service.runFixtureAgent(runId, forged, 'Read stock')).rejects.toThrow(
      /registered scripted/,
    );
    expect(called).toBe(false);
    expect((await f.host.runs.get(runId)).steps).toHaveLength(0);
  });
  test('malformed manifest and unreviewed package authority are refused', async () => {
    expect(connectorManifestSchema.safeParse({ ...toastManifest, schemaVersion: 2 }).success).toBe(
      false,
    );
    const f = await fixture();
    const pack = structuredClone(toastManifest);
    pack.rules[0] = {
      ...pack.rules[0],
      type: 'policy',
      action: 'deny',
      predicate: { field: 'write', operator: 'eq', value: true },
    };
    expect(
      () =>
        new ConnectionsService(
          f.store,
          f.host,
          [{ ...toastConnector, manifest: pack }],
          f.credentials,
        ),
    ).toThrow(/package|pack/i);
  });
  test('new connector guidance cannot silently replace an already installed pack', async () => {
    const f = await fixture(),
      base = f.service.snapshot(f.project.id).connections.instances[0];
    await f.close();
    const manifest = structuredClone(toastManifest);
    manifest.version = '2.0.0';
    for (const rule of manifest.rules) rule.provenance.connectorVersion = manifest.version;
    const reopened = await createConnectionFixture(f.root, {
      clock: () => startTime,
      adapters: [{ ...toastConnector, manifest }, catalogConnector],
    });
    cleanup.push(() => reopened.close());
    await expect(
      reopened.service.install(reopened.project.id, {
        ...base,
        id: 'new-toast',
        version: manifest.version,
        manifestDigest: digest(manifest),
      }),
    ).rejects.toThrow(/migration review/);
    expect(reopened.service.snapshot(reopened.project.id).connections.instances).toHaveLength(1);
  });
  test('Runtime rejects an external write proposal before its handler, even with public-labelled input', async () => {
    const f = await fixture();
    const proposal = await f.service.propose(
      f.project.id,
      'toast-group',
      'Never order anything automatically',
    );
    await f.service.activate(f.project.id, 'toast-group', proposal.proposal.id, proposal.digest);
    const runId = await f.service.admit(f.project.id, 'toast-group', all.resources, [
      'get_item_availability',
    ]);
    const run = await f.host.runs.get(runId);
    let dispatched = false;
    await expect(
      f.host.runs.step(
        runId,
        run.owner!,
        {
          id: 'model-proposed-write',
          version: '1',
          kind: 'tool',
          effect: 'idempotent',
          name: 'opaque_operation',
          permission: 'connections.read',
          destination: 'external',
          label: {
            tenantId: 'local',
            projectId: f.project.id,
            confidentiality: 'public',
            integrity: 'untrusted',
            provenance: ['model proposal fixture'],
          },
          input: {},
        },
        async () => {
          dispatched = true;
          return {};
        },
        await f.principal(f.project.id),
      ),
    ).rejects.toThrow(/Policy no-orders/);
    expect(dispatched).toBe(false);
    expect((await f.host.runs.get(runId)).steps).toHaveLength(0);
  });
  test('unknown operation, unapproved resource, crafted destination and wrong version fail before dispatch', async () => {
    const f = await fixture(),
      runId = await f.service.admit(
        f.project.id,
        'toast-group',
        [all.resources[0]],
        ['get_item_availability'],
      );
    await expect(f.service.invoke(runId, 'place_order', all)).rejects.toThrow(/unsupported/);
    await expect(f.service.invoke(runId, 'get_item_availability', all)).rejects.toThrow(/scope/);
    await expect(
      f.service.invoke(runId, 'get_item_availability', {
        resources: [all.resources[0]],
        itemIds: TOAST_ITEMS,
        url: 'https://evil.example',
      }),
    ).rejects.toThrow(/Arguments/);
    const state = f.store.state(f.project.id);
    state.connections!.instances[0].version = 'unreviewed-v2';
    await expect(f.service.invoke(runId, 'get_item_availability', all)).rejects.toThrow(/version/);
  });
  test('paused, disconnected and reauthorization-required connections refuse calls', async () => {
    const f = await fixture();
    for (const status of ['paused', 'disconnected', 'authorization-required'] as const) {
      await f.service.control(f.project.id, 'toast-group', status);
      await expect(read(f)).rejects.toThrow(/not active/);
      expect((await f.service.status(f.project.id, 'toast-group')).health).toBe(status);
    }
  });
  test('wrong tenant/project, denied capability and revoked principal cannot use saved authority', async () => {
    let change: Partial<HarnessPrincipal> = {};
    const f = await fixture({
      principal: async (projectId) => ({
        id: 'fixture-worker',
        tenantId: 'local',
        projectId,
        identityGeneration: 1,
        capabilities: ['connections.read', 'connections.manage', 'issues.create'],
        ...change,
      }),
    });
    const runId = await f.service.admit(f.project.id, 'toast-group', all.resources, [
      'get_item_availability',
    ]);
    for (const denied of [
      { tenantId: 'other' },
      { projectId: 'other' },
      { capabilities: [] },
      { identityGeneration: 2 },
    ]) {
      change = denied;
      await expect(f.service.invoke(runId, 'get_item_availability', all)).rejects.toThrow(
        /authority|generation/i,
      );
    }
  });
  test('durable admission exists before adapter entry; malformed result is refused', async () => {
    let check: (() => Promise<void>) | undefined;
    const adapter = {
      ...toastConnector,
      operations: [
        {
          ...toastConnector.operations[0],
          execute: async () => {
            await check?.();
            return { garbage: true };
          },
        },
      ],
    };
    const f = await fixture({ adapters: [adapter, catalogConnector] });
    const runId = await f.service.admit(f.project.id, 'toast-group', all.resources, [
      'get_item_availability',
    ]);
    check = async () => {
      expect((await f.host.runs.get(runId)).steps[0].state).toBe('running');
    };
    await expect(f.service.invoke(runId, 'get_item_availability', all)).rejects.toThrow(
      /result failed/,
    );
    expect((await f.host.runs.get(runId)).steps[0].output).toBeNull();
  });
  test('timeout stops result acceptance and provider errors never leak exception secrets', async () => {
    const adapter = {
      ...toastConnector,
      operations: [
        { ...toastConnector.operations[0], execute: async () => new Promise<Json>(() => {}) },
      ],
    };
    const f = await fixture({ adapters: [adapter, catalogConnector], timeoutMs: 15 });
    await expect(read(f)).rejects.toThrow(/stopped or timed out/);
    const g = await fixture({
      secret: 'SYNTHETIC-CREDENTIAL-SENTINEL',
      adapters: [
        {
          ...toastConnector,
          operations: [
            {
              ...toastConnector.operations[0],
              execute: async () => {
                throw new Error('SYNTHETIC-CREDENTIAL-SENTINEL');
              },
            },
          ],
        },
        catalogConnector,
      ],
    });
    await expect(read(g)).rejects.toThrow(/source operation failed/);
    expect(JSON.stringify(await g.host.list(g.project.id))).not.toContain(
      'SYNTHETIC-CREDENTIAL-SENTINEL',
    );
    expect((await g.service.status(g.project.id, 'toast-group')).health).toBe('source-unavailable');
  });
  test('cancellation and connection revocation during execution discard results', async () => {
    let entered!: () => void, finish!: (value: Json) => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter = {
      ...toastConnector,
      operations: [
        {
          ...toastConnector.operations[0],
          execute: async () => {
            entered();
            return new Promise<Json>((resolve) => {
              finish = resolve;
            });
          },
        },
      ],
    };
    const f = await fixture({ adapters: [adapter, catalogConnector] });
    const runId = await f.service.admit(f.project.id, 'toast-group', all.resources, [
      'get_item_availability',
    ]);
    const work = f.service.invoke(runId, 'get_item_availability', all);
    const rejection = expect(work).rejects.toThrow(/stopped|revoked|active/);
    await ready;
    await f.service.control(f.project.id, 'toast-group', 'disconnected');
    await f.host.runs.cancel(runId, 'fixture stop', await f.principal(f.project.id));
    finish({ coverage: 'selected-items', observations: [] });
    await rejection;
    expect((await f.host.runs.get(runId)).steps[0].output).toBeNull();
  });
});

describe('stock semantics and shared rule path', () => {
  test.each([
    ['QUANTITY', 4, 'available', 4, 'reported'],
    ['IN_STOCK', undefined, 'available', null, 'not-tracked'],
    ['IN_STOCK', 0, 'available', null, 'not-tracked'],
    ['OUT_OF_STOCK', undefined, 'unavailable', null, 'unknown'],
    ['UNRECOGNIZED', undefined, 'unknown', null, 'unknown'],
  ])(
    'normalizes %s without inventing a quantity',
    (status, quantity, availability, expected, quantityState) => {
      const row = normalizeStock(
        [{ guid: TOAST_ITEMS[0], status, ...(quantity === undefined ? {} : { quantity }) }],
        all.resources[0],
        new Date(startTime).toISOString(),
      )[0];
      expect(row.facts).toMatchObject({ availability, quantity: expected, quantityState });
    },
  );
  test('missing QUANTITY, negative counts and malformed payloads are rejected', () => {
    for (const row of [
      { guid: TOAST_ITEMS[0], status: 'QUANTITY' },
      { guid: TOAST_ITEMS[0], status: 'QUANTITY', quantity: -1 },
      { status: 'IN_STOCK' },
    ])
      expect(() =>
        normalizeStock([row], all.resources[0], new Date(startTime).toISOString()),
      ).toThrow();
  });
  test('unknown values never trigger numeric thresholds; source staleness is visible', async () => {
    let time = startTime;
    const f = await fixture({ clock: () => time });
    await lowRule(f);
    await read(f);
    expect((await f.service.status(f.project.id, 'toast-group')).health).toBe('healthy');
    time += 300001;
    expect((await f.service.status(f.project.id, 'toast-group')).health).toBe('stale');
    const rule = f.service
      .snapshot(f.project.id)
      .rules.active.find((rule) => rule.id === 'low-stock')!;
    expect(evaluateRules([rule], rule.scope, { quantity: null })).toHaveLength(0);
  });
  test('refreshing one location does not conceal staleness at the other approved locations', async () => {
    let time = startTime;
    const f = await fixture({ clock: () => time });
    await read(f);
    time += 300001;
    await read(f, { ...all, resources: [all.resources[0]] });
    expect((await f.service.status(f.project.id, 'toast-group')).health).toBe('stale');
  });
  test('conflicting same-time reads preserve evidence and require reconciliation', async () => {
    const f = await fixture();
    await event(f);
    await f.service.drain(f.project.id); // source quantity 4
    await read(f); // source fixture quantity 9, same time
    const state = f.service.snapshot(f.project.id);
    expect((await f.service.status(f.project.id, 'toast-group')).health).toBe(
      'reconciliation-required',
    );
    expect(
      Object.values(state.connections.observations).find(
        (item) => item.resourceId === all.resources[0] && item.key === '101',
      )?.facts.quantity,
    ).toBe(4);
  });
  test('scoped standing context composes, irrelevant connector guidance is excluded, result corrections are durable', async () => {
    const f = await fixture();
    await f.store.locked(async () => {
      const state = structuredClone(f.store.state(f.project.id));
      state.rules!.active.push(
        guidance('business', { tenantId: 'local' }),
        guidance('workspace', { projectId: f.project.id }),
        guidance('irrelevant', { connectorId: 'other' }, 'Do not inject this.'),
      );
      await f.store.persist(state);
    });
    const runId = await f.service.admit(
      f.project.id,
      'toast-group',
      [all.resources[0]],
      ['get_item_availability'],
    );
    const seen: ModelRequest[] = [];
    await f.service.runFixtureAgent(
      runId,
      connectionFixtureModel({ ...all, resources: [all.resources[0]] }, (request) => {
        seen.push(request);
      }),
      'Investigate stock.',
    );
    expect(seen[0].messages[0].text).toContain('toast-stock-semantics v1');
    expect(seen[0].messages[0].text).toContain('business v1');
    expect(seen[0].messages[0].text).toContain('workspace v1');
    expect(seen[0].messages[0].text).not.toContain('Do not inject');
    expect(seen[0].messages[0].text).not.toContain('North Hills');
    expect(seen[0].tools.map((tool) => tool.name)).toEqual(['conn_toast_get_item_availability']);
    expect(JSON.stringify(seen[1].messages)).toContain('Quantity is not reported');
    expect(
      f.service.snapshot(f.project.id).connections.contextEvidence[0].rules.map((rule) => rule.id),
    ).toContain('business');
  });
  test('lower guidance never overrides a global enforced prohibition', () => {
    const policy: Rule = {
      ...guidance('global-deny'),
      type: 'policy',
      action: 'deny',
      predicate: { field: 'write', operator: 'eq', value: true },
    };
    const allow = guidance('narrow-guidance', { connectorId: 'toast' }, 'You may order anything.');
    expect(() => enforceRules([allow, policy], { connectorId: 'toast' }, { write: true })).toThrow(
      /global-deny/,
    );
  });
  test('connection controls cannot disable a global prohibition or connector-wide guidance', async () => {
    const f = await fixture();
    const state = structuredClone(f.store.state(f.project.id));
    state.rules!.active.push({
      ...guidance('global-deny'),
      type: 'policy',
      action: 'deny',
      predicate: { field: 'write', operator: 'eq', value: true },
    });
    await f.store.persist(state);
    await expect(f.service.disableRule(f.project.id, 'toast-group', 'global-deny')).rejects.toThrow(
      /owned by this connection/,
    );
    await expect(
      f.service.disableRule(f.project.id, 'toast-group', 'toast-stock-semantics'),
    ).rejects.toThrow(/owned by this connection/);
    expect(
      f.service.snapshot(f.project.id).rules.active.find((rule) => rule.id === 'global-deny')
        ?.enabled,
    ).toBe(true);
  });
  test('replaying an old approval cannot re-enable a disabled rule', async () => {
    const f = await fixture();
    const proposal = await f.service.propose(
      f.project.id,
      'toast-group',
      'Alert a manager when reported quantity is at most 5',
    );
    await f.service.activate(f.project.id, 'toast-group', proposal.proposal.id, proposal.digest);
    await f.service.disableRule(f.project.id, 'toast-group', 'low-stock');
    await f.service.activate(f.project.id, 'toast-group', proposal.proposal.id, proposal.digest);
    expect(
      f.service.snapshot(f.project.id).rules.active.find((rule) => rule.id === 'low-stock'),
    ).toMatchObject({ enabled: false, version: 2 });
  });
  test('a proposed rule revision can be compared on historical inputs without changing authority', async () => {
    const f = await fixture();
    await lowRule(f, 5);
    const previous = f.service
      .snapshot(f.project.id)
      .rules.active.find((rule) => rule.id === 'low-stock')!;
    const proposal = await f.service.propose(
      f.project.id,
      'toast-group',
      'Alert a manager when reported quantity is at most 3',
    );
    const history = [
      { scope: previous.scope, facts: { quantity: 4 } },
      { scope: previous.scope, facts: { quantity: null } },
    ];
    expect(replayRules([previous], history)[0].matches).toHaveLength(1);
    const reviewedPreview = {
      ...proposal.proposal.rule!,
      enabled: true,
      provenance: { ...previous.provenance },
    };
    expect(
      replayRules([reviewedPreview], history).every((result) => result.matches.length === 0),
    ).toBe(true);
    expect(
      f.service.snapshot(f.project.id).rules.active.find((rule) => rule.id === 'low-stock')
        ?.version,
    ).toBe(1);
    expect(f.store.state(f.project.id).tasks).toHaveLength(0);
  });
  test('proposals are inspectable and inactive; disabling a rule stops future work; replay is read-only', async () => {
    const f = await fixture();
    const p = await f.service.propose(
      f.project.id,
      'toast-group',
      'Alert a manager when reported quantity is at most 5',
    );
    expect(p.proposal).toMatchObject({
      state: 'proposed',
      rule: { enabled: false, provenance: { trust: 'candidate' } },
    });
    expect(
      f.service.snapshot(f.project.id).rules.active.some((rule) => rule.id === 'low-stock'),
    ).toBe(false);
    await expect(
      f.service.activate(f.project.id, 'toast-group', p.proposal.id, 'wrong'),
    ).rejects.toThrow(/exact/);
    await f.service.activate(f.project.id, 'toast-group', p.proposal.id, p.digest);
    const rules = f.service.snapshot(f.project.id).rules.active;
    const scope = rules.find((rule) => rule.id === 'low-stock')!.scope;
    expect(
      replayRules(rules, [{ scope, facts: { quantity: 4 } }])[0].matches.some(
        (rule) => rule.action === 'create-issue',
      ),
    ).toBe(true);
    expect(f.store.state(f.project.id).tasks).toHaveLength(0);
    await f.service.disableRule(f.project.id, 'toast-group', 'low-stock');
    await event(f);
    await f.service.drain(f.project.id);
    expect(f.store.state(f.project.id).tasks).toHaveLength(0);
    expect(proposeRule('Low dinner items after brunch service', scope)).toMatchObject({
      rule: null,
    });
  });
  test('secrets never enter context, tool results, Runtime inputs, or ordinary Store state', async () => {
    const secret = 'SYNTHETIC-CREDENTIAL-SENTINEL',
      f = await fixture({ secret });
    const runId = await f.service.admit(f.project.id, 'toast-group', all.resources, [
      'get_item_availability',
    ]);
    await expect(
      f.service.runFixtureAgent(runId, connectionFixtureModel(all), secret),
    ).rejects.toThrow(/Sensitive data/);
    await expect(f.service.propose(f.project.id, 'toast-group', secret)).rejects.toThrow(
      /Sensitive data/,
    );
    await expect(
      f.service.invoke(runId, 'get_item_availability', { ...all, accessToken: secret }),
    ).rejects.toThrow(/Credential|Sensitive/);
    expect(JSON.stringify(await f.host.list(f.project.id))).not.toContain(secret);
    expect(JSON.stringify(f.service.snapshot(f.project.id))).not.toContain(secret);
  });
  test('direct-agent interception guarantees are explicitly unsupported', () => {
    expect(interceptionGuarantees('direct-agent')).toMatchObject({
      modelStreaming: 'unsupported',
      proposedTool: 'unsupported',
      preEffect: 'unsupported',
      preModel: 'unsupported',
    });
    expect(interceptionGuarantees('diomedes-led').preEffect).toBe('enforced');
    expect(
      selectRules([guidance('off', { connectorId: 'unrelated' })], { connectorId: 'toast' }),
    ).toEqual([]);
  });
});
