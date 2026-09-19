import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EngineConnection } from '../shared/engines.js';
import type { ConnectionInstance, ConnectorManifest } from '../shared/connections.js';
import type { ReadinessRuntimeSnapshot } from '../shared/readiness.js';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import {
  assembleProductKnowledgeInstructions,
  loadShippedProductKnowledge,
  productKnowledgeSentence,
  resolveProductKnowledgeRoot,
} from '../server/readiness/instructions.js';
import { loadProductKnowledge } from '../server/readiness/product-knowledge.js';
import { projectReadiness } from '../server/readiness/projection.js';
import { mountReadinessRoutes } from '../server/readiness/routes.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const at = '2026-09-19T12:00:00.000Z';
const buildVersion = '0.1.4';
const roots: string[] = [];

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    indexBuild?: string;
    resourceBuild?: string;
    qualifiedAt?: string;
    staleAfterMs?: number;
    alterAfterIndex?: boolean;
    omitIndex?: boolean;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'fd03-knowledge-'));
  roots.push(root);
  const core = JSON.stringify(
    {
      schemaVersion: 1,
      id: 'diomedes-core',
      version: '2026-09-19.1',
      buildVersion: options.resourceBuild ?? buildVersion,
      title: 'Diomedes shipped capability facts',
      qualification: {
        status: 'verified',
        evidenceId: 'H01.R-20260917',
        source: 'evidence/H01.R-20260917.json',
        qualifiedAt: options.qualifiedAt ?? '2026-09-19T11:00:00.000Z',
        staleAfterMs: options.staleAfterMs ?? 86_400_000,
      },
      scopes: ['product', 'route:sample', 'route:claude-code', 'workflow:sample-draft'],
      routes: [
        { routeId: 'sample', contractVersion: 1, engineVersion: '0.1.0' },
        { routeId: 'claude-code', contractVersion: 1, engineVersion: '2.1.252' },
      ],
      connectors: [],
      workflows: [
        {
          id: 'sample-draft',
          title: 'Draft with the deterministic sample route',
          requirements: [{ kind: 'route', id: 'sample', commands: ['start'], controls: {} }],
        },
      ],
      statements: [
        {
          id: 'route-sample',
          scopes: ['route:sample'],
          text: 'The sample route is deterministic and does not call a model.',
          sources: ['server/work.ts', 'server/harness/route-contract.ts'],
        },
      ],
    },
    null,
    2,
  );
  await fs.writeFile(path.join(root, 'core.json'), core);
  if (!options.omitIndex) {
    const index = JSON.stringify(
      {
        schemaVersion: 1,
        version: '2026-09-19.1',
        buildVersion: options.indexBuild ?? buildVersion,
        resources: [
          {
            path: 'core.json',
            sha256: sha(core),
            scopes: ['product', 'route:sample', 'route:claude-code', 'workflow:sample-draft'],
          },
        ],
      },
      null,
      2,
    );
    await fs.writeFile(path.join(root, 'index.json'), index);
  }
  if (options.alterAfterIndex) await fs.appendFile(path.join(root, 'core.json'), '\n ');
  return root;
}

const engine = (patch: Partial<EngineConnection> = {}): EngineConnection => ({
  engine: 'claude-code',
  installation: 'found',
  compatibility: 'supported',
  authentication: 'signed-in',
  accountRoute: 'native-account',
  models: [
    {
      slug: 'claude-sonnet-4-5',
      name: 'Sonnet 4.5',
      description: 'Fixture model',
      defaultEffort: null,
      efforts: [],
    },
  ],
  checkedAt: '2026-09-19T11:59:00.000Z',
  detail: 'Checked.',
  version: '2.1.252',
  usage: { state: 'unknown', checkedAt: null },
  ...patch,
});

const snapshot = (patch: Partial<ReadinessRuntimeSnapshot> = {}): ReadinessRuntimeSnapshot => ({
  build: { version: buildVersion, source: 'package.json' },
  settings: { services: { sample: true, 'claude-code': true }, observedAt: at },
  engines: [engine()],
  connectors: { manifests: [], instances: [], observations: [] },
  validatedEvidence: [
    {
      kind: 'route',
      id: 'sample',
      evidenceId: 'fixture-sample-proof',
      source: 'tests/fd03-readiness.test.ts',
      validatedAt: '2026-09-19T11:00:00.000Z',
      staleAfterMs: 86_400_000,
      buildVersion,
      contractVersion: 1,
      engineVersion: '0.1.0',
    },
    {
      kind: 'route',
      id: 'claude-code',
      evidenceId: 'fixture-claude-proof',
      source: 'tests/fd03-readiness.test.ts',
      validatedAt: '2026-09-19T11:00:00.000Z',
      staleAfterMs: 86_400_000,
      buildVersion,
      contractVersion: 1,
      engineVersion: '2.1.252',
    },
  ],
  ...patch,
});

describe('FD03 product knowledge integrity', () => {
  test('resolves source and bundled resource paths without escaping the desktop stage', () => {
    const sourceUrl = new URL('../server/readiness/instructions.ts', import.meta.url);
    expect(resolveProductKnowledgeRoot(sourceUrl, false)).toBe(
      path.resolve(process.cwd(), 'resources/product-knowledge'),
    );
    const bundledUrl = new URL('file:///C:/stage/server/app.mjs');
    expect(resolveProductKnowledgeRoot(bundledUrl, true).replaceAll('\\', '/')).toBe(
      'C:/stage/resources/product-knowledge',
    );
  });

  test('loads only indexed exact bytes and exposes deterministic resource and bundle hashes', async () => {
    const root = await fixture();
    const first = await loadProductKnowledge({ root, buildVersion, now: at });
    const second = await loadProductKnowledge({ root, buildVersion, now: at });
    expect(first.conflicts).toEqual([]);
    expect(first.resources[0].sha256).toHaveLength(64);
    expect(first.bundleSha256).toBe(second.bundleSha256);
    expect(first.resources[0].resource.id).toBe('diomedes-core');
  });

  test.each([
    ['old docs with a new build', { indexBuild: '0.1.3', resourceBuild: '0.1.3' }, 'build-version'],
    [
      'new docs with an old build',
      { indexBuild: '0.1.5', resourceBuild: '0.1.5' },
      'build-version',
    ],
    ['a missing index', { omitIndex: true }, 'missing-index'],
    [
      'a stale qualification',
      { qualifiedAt: '2026-09-17T11:00:00.000Z', staleAfterMs: 60_000 },
      'stale-qualification',
    ],
  ] as const)('%s produces scoped uncertainty', async (_name, options, code) => {
    const bundle = await loadProductKnowledge({
      root: await fixture(options),
      buildVersion,
      now: at,
    });
    expect(bundle.conflicts.some((conflict) => conflict.code === code)).toBe(true);
    expect(bundle.conflicts.every((conflict) => conflict.scopes.length > 0)).toBe(true);
    const view = projectReadiness({ snapshot: snapshot(), knowledge: bundle, now: at });
    expect(view.routes.find((route) => route.id === 'sample')?.axes.verified.value).toBe('unknown');
  });

  test('altered resource bytes are rejected under the scopes from the trusted index', async () => {
    const bundle = await loadProductKnowledge({
      root: await fixture({ alterAfterIndex: true }),
      buildVersion,
      now: at,
    });
    expect(bundle.resources).toEqual([]);
    expect(bundle.conflicts).toContainEqual(
      expect.objectContaining({
        code: 'digest-mismatch',
        scopes: expect.arrayContaining(['route:sample']),
      }),
    );
  });
});

describe('FD03 readiness projection', () => {
  test('native session readiness uses its underlying engine facts without inheriting route verification', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const view = projectReadiness({ snapshot: snapshot(), knowledge, now: at });
    const native = view.routes.find((route) => route.id === 'claude-code-session')!;
    expect(native.axes.installed.value).toBe('yes');
    expect(native.axes.authorized.value).toBe('yes');
    expect(native.axes.healthy.value).toBe('yes');
    expect(native.axes.verified.value).toBe('unknown');
    expect(native.ready).toBe(false);
  });
  test('shipped route descriptions do not self-certify verification', async () => {
    const knowledge = await loadShippedProductKnowledge({ buildVersion, now: at });
    expect(knowledge.conflicts).toEqual([]);
    const route = projectReadiness({
      snapshot: snapshot({ validatedEvidence: [] }),
      knowledge,
      now: at,
    }).routes.find((item) => item.id === 'sample')!;
    expect(route.axes.implemented.value).toBe('yes');
    expect(route.axes.verified).toMatchObject({
      value: 'unknown',
      freshness: { state: 'unknown' },
    });
    expect(route.axes.verified.detail).toContain('No trusted validated evidence');
  });

  test('a resource that labels its own qualification verified still cannot make the verified axis yes', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const route = projectReadiness({
      snapshot: snapshot({ validatedEvidence: [] }),
      knowledge,
      now: at,
    }).routes.find((item) => item.id === 'sample')!;
    expect(knowledge.resources[0].resource.qualification.status).toBe('verified');
    expect(route.axes.verified).toMatchObject({
      value: 'unknown',
      source: { kind: 'validated-evidence' },
    });
  });

  test('future-dated validated evidence is never fresh', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const future = snapshot().validatedEvidence!.map((item) =>
      item.id === 'sample' ? { ...item, validatedAt: '2026-09-19T13:00:00.000Z' } : item,
    );
    const route = projectReadiness({
      snapshot: snapshot({ validatedEvidence: future }),
      knowledge,
      now: at,
    }).routes.find((item) => item.id === 'sample')!;
    expect(route.axes.verified).toMatchObject({ value: 'unknown', freshness: { state: 'stale' } });
  });

  test('keeps implemented, installed, authorized, verified and healthy independent with sources', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const view = projectReadiness({
      snapshot: snapshot({ engines: [engine({ authentication: 'signed-out', models: [] })] }),
      knowledge,
      now: at,
    });
    const route = view.routes.find((item) => item.id === 'claude-code')!;
    expect(route.axes.implemented.value).toBe('yes');
    expect(route.axes.installed.value).toBe('yes');
    expect(route.axes.authorized.value).toBe('no');
    expect(route.axes.verified.value).toBe('yes');
    expect(route.axes.healthy.value).toBe('no');
    expect(route.ready).toBe(false);
    for (const axis of Object.values(route.axes)) {
      expect(axis.source.id.length).toBeGreaterThan(0);
      expect(axis.freshness.state).toMatch(/static|fresh|stale|unknown/);
    }
  });

  test('a stale cached engine observation becomes explicit unknown and cannot be ready', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const view = projectReadiness({
      snapshot: snapshot({ engines: [engine({ checkedAt: '2026-09-19T11:00:00.000Z' })] }),
      knowledge,
      now: at,
    });
    const route = view.routes.find((item) => item.id === 'claude-code')!;
    expect(route.axes.healthy).toMatchObject({ value: 'unknown', freshness: { state: 'stale' } });
    expect(route.ready).toBe(false);
  });

  test('a workflow contains only its declared capability and never switches routes automatically', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const view = projectReadiness({ snapshot: snapshot(), knowledge, now: at });
    const workflow = view.workflows.find((item) => item.id === 'sample-draft')!;
    expect(workflow.requirements.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'route:sample',
    ]);
    expect(workflow.routeSwitch).toBe('explicit-only');
    expect(workflow.selectedAlternatives).toEqual([]);
    expect(workflow.ready).toBe(true);
  });

  test('an unsupported required command blocks the selected workflow without choosing an alternative', async () => {
    const root = await fixture();
    const corePath = path.join(root, 'core.json');
    const core = JSON.parse(await fs.readFile(corePath, 'utf8'));
    core.workflows[0].requirements[0] = {
      kind: 'route',
      id: 'sample',
      commands: ['steer'],
      controls: {},
    };
    const text = JSON.stringify(core, null, 2);
    await fs.writeFile(corePath, text);
    const indexPath = path.join(root, 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    index.resources[0].sha256 = sha(text);
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    const knowledge = await loadProductKnowledge({ root, buildVersion, now: at });
    const workflow = projectReadiness({ snapshot: snapshot(), knowledge, now: at }).workflows[0];
    expect(workflow.ready).toBe(false);
    expect(workflow.blockers).toContainEqual(
      expect.objectContaining({ code: 'command-unsupported' }),
    );
    expect(workflow.selectedAlternatives).toEqual([]);
  });

  test('persisted connected state does not prove authorization and foreign observations do not prove health', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const manifest = {
      schemaVersion: 1,
      id: 'toast',
      version: '1.0.0',
      operations: [{ id: 'get_item_availability' }],
    } as unknown as ConnectorManifest;
    const instance: ConnectionInstance = {
      id: 'toast-main',
      connectorId: 'toast',
      version: '1.0.0',
      manifestDigest: 'a'.repeat(64),
      tenantId: 'tenant',
      projectId: 'project-a',
      name: 'Toast fixture',
      resources: [{ id: 'central', name: 'Central' }],
      vendorScopes: ['stock:read'],
      operations: ['get_item_availability'],
      mode: 'fixture',
      status: 'connected',
      generation: 2,
      staleAfterMs: 300_000,
      lastEventAt: null,
      lastReconciledAt: null,
      reconciledResources: {},
      problem: null,
    };
    const view = projectReadiness({
      snapshot: snapshot({
        connectors: {
          manifests: [{ manifest, digest: 'a'.repeat(64) }],
          instances: [instance],
          observations: [
            {
              connectionId: 'toast-foreign',
              generation: 2,
              projectId: 'project-b',
              observation: {
                resourceId: 'central',
                key: 'inventory',
                sourceAt: '2026-09-19T11:59:00.000Z',
                receivedAt: '2026-09-19T11:59:00.000Z',
                facts: {},
                source: 'foreign fixture',
              },
            },
          ],
        },
      }),
      knowledge,
      now: at,
    });
    const connector = view.connectors[0];
    expect(connector.axes.authorized.value).toBe('unknown');
    expect(connector.axes.healthy.value).toBe('unknown');
    expect(connector.axes.healthy.detail).toBe('No connector observation exists.');
  });

  test('a connection manifest mismatch blocks healthy even with a fresh bound observation', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const manifest = {
      schemaVersion: 1,
      id: 'toast',
      version: '1.0.0',
      operations: [],
    } as unknown as ConnectorManifest;
    const instance: ConnectionInstance = {
      id: 'toast-main',
      connectorId: 'toast',
      version: '0.9.0',
      manifestDigest: 'b'.repeat(64),
      tenantId: 'tenant',
      projectId: 'project-a',
      name: 'Toast fixture',
      resources: [{ id: 'central', name: 'Central' }],
      vendorScopes: [],
      operations: [],
      mode: 'fixture',
      status: 'connected',
      generation: 2,
      staleAfterMs: 300_000,
      lastEventAt: at,
      lastReconciledAt: at,
      reconciledResources: {},
      problem: null,
    };
    const connector = projectReadiness({
      snapshot: snapshot({
        connectors: {
          manifests: [{ manifest, digest: 'a'.repeat(64) }],
          instances: [instance],
          observations: [
            {
              connectionId: instance.id,
              generation: instance.generation,
              projectId: instance.projectId,
              observation: {
                resourceId: 'central',
                key: 'inventory',
                sourceAt: at,
                receivedAt: at,
                facts: {},
                source: 'bound fixture',
              },
            },
          ],
        },
      }),
      knowledge,
      now: at,
    }).connectors[0];
    expect(connector.axes.healthy.value).toBe('unknown');
    expect(connector.axes.healthy.detail).toContain('does not match');
  });
});

describe('FD03 read-only HTTP and instruction delivery', () => {
  test('GET reads injected snapshots only and performs no probe or authorization mutation', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const getSnapshot = vi.fn(async () => snapshot());
    const getKnowledge = vi.fn(async () => knowledge);
    const app = express();
    mountReadinessRoutes(app, { snapshot: getSnapshot, knowledge: getKnowledge, now: () => at });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/api/readiness/workflows/sample-draft`);
      expect(response.status).toBe(200);
      expect((await response.json()).workflow.id).toBe('sample-draft');
      expect(getSnapshot).toHaveBeenCalledOnce();
      expect(getKnowledge).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('instruction assembly hashes the exact whole outgoing section and omits it whole when over budget', async () => {
    const knowledge = await loadProductKnowledge({ root: await fixture(), buildVersion, now: at });
    const sent = assembleProductKnowledgeInstructions({
      knowledge,
      routeId: 'sample',
      budgetBytes: 20_000,
      at,
    });
    expect(sent.section).toContain('BEGIN DIOMEDES PRODUCT KNOWLEDGE');
    expect(sent.receipt.state).toBe('prepared');
    expect(sent.receipt.sectionSha256).toBe(sha(sent.section!));
    expect(sent.receipt.resources[0].sha256).toBe(knowledge.resources[0].sha256);
    expect(productKnowledgeSentence(sent.receipt)).not.toContain('sent');

    const omitted = assembleProductKnowledgeInstructions({
      knowledge,
      routeId: 'sample',
      budgetBytes: 8,
      at,
    });
    expect(omitted.section).toBeNull();
    expect(omitted.receipt).toMatchObject({ state: 'omitted', sectionSha256: null });
  });

  test('the real generator sees product knowledge and the receipt becomes sent only after a response', async () => {
    const temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'fd03-native-'));
    roots.push(temp);
    let resolve!: (value: { text: string; model: string }) => void;
    const pending = new Promise<{ text: string; model: string }>((done) => (resolve = done));
    const generator = vi.fn<NativeGenerator>((_input) => pending);
    const app = await createApp({
      dataDir: path.join(temp, 'data'),
      projectRoot: path.join(temp, 'projects'),
      nativeGenerator: generator,
    });
    let server: Server | undefined;
    try {
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((done) => server!.once('listening', done));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
      const call = async (route: string, method = 'GET', body?: unknown) => {
        const response = await fetch(base + route, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      };
      const projectId = (await call('/projects/sample', 'POST', {})).data.id;
      const taskId = (
        await call(`/projects/${projectId}/tasks`, 'POST', {
          name: 'Draft',
          description: 'Draft a note',
        })
      ).data.id;
      await call('/settings', 'PUT', { services: { codex: true } });
      expect(
        (
          await call(`/projects/${projectId}/work/start`, 'POST', {
            taskId,
            route: 'codex',
            consent: true,
            sources: [],
          })
        ).status,
      ).toBe(200);
      await vi.waitFor(() => expect(generator).toHaveBeenCalledOnce());
      expect(generator.mock.calls[0][0].prompt).toContain('BEGIN DIOMEDES PRODUCT KNOWLEDGE');
      let state = (await call(`/projects/${projectId}/state`)).data;
      expect(state.sessions[0].productKnowledge.state).toBe('prepared');
      resolve({
        text: JSON.stringify({ summary: 'Nothing needed', changes: [] }),
        model: 'fixture-model',
      });
      await vi.waitFor(async () => {
        state = (await call(`/projects/${projectId}/state`)).data;
        expect(state.sessions[0].productKnowledge.state).toBe('sent-and-response-returned');
      });
      expect(state.sessions[0].productKnowledge.sectionSha256).toBe(
        sha(
          generator.mock.calls[0][0].prompt.match(
            /--- BEGIN DIOMEDES PRODUCT KNOWLEDGE[\s\S]*?--- END DIOMEDES PRODUCT KNOWLEDGE ---/,
          )![0],
        ),
      );
    } finally {
      await app.locals.close();
      if (server)
        await new Promise<void>((resolveClose, reject) =>
          server!.close((error) => (error ? reject(error) : resolveClose())),
        );
    }
  });

  test('a provider failure never upgrades a prepared product-knowledge receipt to sent', async () => {
    const temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'fd03-native-fail-'));
    roots.push(temp);
    const app = await createApp({
      dataDir: path.join(temp, 'data'),
      projectRoot: path.join(temp, 'projects'),
      nativeGenerator: async () => {
        throw new Error('fixture provider failure');
      },
    });
    try {
      const project = await app.locals.store.createProject('FD03 failure fixture');
      const state = app.locals.store.state(project.id);
      const task = app.locals.store.createTask(state, {
        name: 'Draft',
        description: 'Draft a note',
      });
      await app.locals.store.persist(state);
      app.locals.store.settings.services = { ...app.locals.store.settings.services, codex: true };
      await app.locals.nativeWork.start(project.id, task.id, { sources: [], consent: true });
      await vi.waitFor(() => {
        const receipt = app.locals.store.state(project.id).sessions[0].productKnowledge;
        expect(receipt?.state).toBe('prepared');
        expect(app.locals.store.state(project.id).sessions[0].state).toBe('failed');
      });
    } finally {
      await app.locals.close();
    }
  });
});
