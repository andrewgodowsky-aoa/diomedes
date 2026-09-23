/**
 * The host builds each Ask or Plan turn's read scope from that turn alone: its route, the
 * documents it sends, and the person's per-message `readAccess` choice. Real `createApp`, real
 * `EngineService` admission and real Store; only the provider is scripted, and it records the
 * scope it was handed and whether that scope's grant was live while it ran.
 */
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type { TextEngineAdapter, TextRequest } from '../server/engines/contract.js';
import { openReadGrant, readGrantLive } from '../server/engines/turn-scope.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import type { Store } from '../server/store.js';
import type { IntegrationStatus } from '../shared/types.js';

// Codex never runs here: a regression that let a whole-project read through would reach this
// stand-in, which records the call instead of starting the real runtime.
const codexCalls: unknown[] = [];
vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    askCodex: async (input: unknown) => {
      codexCalls.push(input);
      throw new Error('Codex is not run in this fixture');
    },
  };
});

const ENGINE = 'claude-code' as const;
const VERSION = TESTED_VERSIONS[ENGINE];
const ACCOUNT = 'claude-code:claude.ai';
const MODEL = 'sonnet';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

let root: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base = '';
let seen: { input: TextRequest; live: boolean }[];
const store = (): Store => app!.locals.store;

const installed: IntegrationStatus = {
  id: ENGINE,
  name: 'Claude Code',
  kind: 'online',
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Found',
  capabilities: [],
  signIn: 'unknown',
  adapter: 'planned',
  installedVersion: VERSION,
  location: process.execPath,
  disclosure: [],
};
const adapter: TextEngineAdapter = {
  id: ENGINE,
  contract: routeContractFor(ENGINE),
  inspect: async () => ({
    authentication: 'signed-in' as const,
    accountRoute: ACCOUNT,
    detail: 'Fixture only',
    models: [{ slug: MODEL, name: MODEL, description: '', efforts: [], defaultEffort: null }],
  }),
  generate: async (input) => {
    seen.push({ input, live: readGrantLive(input.readScope?.grant) });
    return {
      projectId: input.projectId,
      threadId: input.threadId,
      requestId: input.requestId,
      model: input.model,
      version: VERSION,
      text: 'Answered.',
    };
  },
};

async function open() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-scope-app-'));
  seen = [];
  const engines = new EngineService(path.join(root, 'data', 'engines'), {
    discover: async () => [installed],
    version: async () => VERSION,
    adapter: () => adapter,
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    nativeGenerator: async () => {
      throw new Error('No native work runs in this fixture');
    },
  } as Parameters<typeof createApp>[0]);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (!server) return;
  const closingApp = app!, closingServer = server, closingRoot = root;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(closingRoot, { recursive: true, force: true });
});

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

/** A project that shares its typed messages and the menu with Claude Code, and has payroll too. */
async function project() {
  await open();
  const created = await store().locked(() => store().createProject('Harbor Street'));
  const folder = store().state(created.id).project.folder;
  await fs.writeFile(path.join(folder, 'menu.md'), 'Tomato soup.\n');
  await fs.writeFile(path.join(folder, 'payroll.csv'), 'name,pay\nAda,1\n');
  store().settings.services = {
    'claude-code': true,
    'claude-codeModel': MODEL,
    'claude-codeAccountRoute': ACCOUNT,
  };
  await store().saveSettings(store().settings);
  const shared = await request(`/projects/${created.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['claude-code'], documents: ['menu.md'],
    shareConversationHistory: false, shareReviewPackets: false,
  });
  expect(shared.status).toBe(200);
  return { id: created.id, folder };
}
const ask = (id: string, extra: Record<string, unknown> = {}) =>
  request(`/projects/${id}/ask`, 'POST', {
    text: 'What sells best?',
    route: ENGINE,
    mode: 'ask',
    consent: true,
    ...extra,
  });

test('an Ask with no choice reads only the documents it sends', async () => {
  const { id, folder } = await project();
  const answered = await ask(id, { sources: ['menu.md'] });
  expect(answered.status).toBe(200);
  const scope = seen[0].input.readScope!;
  expect(scope.access).toBe('selected');
  expect(scope.files).toEqual([await fs.realpath(path.join(folder, 'menu.md'))]);
  expect(scope.shared).toEqual(['menu.md']);
  expect(seen[0].live).toBe(true);
  // The grant ended with the turn.
  expect(readGrantLive(scope.grant)).toBe(false);
});

test('a whole-project Ask carries the choice, the route\'s shared files and a grant that ends with it', async () => {
  const { id } = await project();
  const answered = await ask(id, { readAccess: 'project' });
  expect(answered.status).toBe(200);
  const scope = seen[0].input.readScope!;
  expect(scope.access).toBe('project');
  expect(scope.files).toEqual([]);
  // Payroll is in the folder but not on the sharing list, so it is not readable.
  expect(scope.shared).toEqual(['menu.md']);
  expect(seen[0].live).toBe(true);
  expect(readGrantLive(scope.grant)).toBe(false);
});

test('a malformed choice, or a whole-project read outside Ask and Plan, is refused before anything is sent', async () => {
  const { id } = await project();
  expect((await ask(id, { readAccess: 'everything' })).status).toBe(400);
  expect((await ask(id, { readAccess: 'project', mode: 'build' })).status).toBe(400);
  expect(seen).toHaveLength(0);
});

test('a whole-project read on a route that cannot check reads first is refused, not dropped', async () => {
  const { id } = await project();
  store().settings.services = { ...store().settings.services, codex: true };
  await store().saveSettings(store().settings);
  const shared = await request(`/projects/${id}/cloud-sharing`, 'PUT', {
    expectedVersion: 1, routes: ['claude-code', 'codex'], documents: ['menu.md'],
    shareConversationHistory: false, shareReviewPackets: false,
  });
  expect(shared.status).toBe(200);
  const refused = await ask(id, { route: 'codex', readAccess: 'project' });
  expect(refused.status).toBe(503);
  expect(JSON.stringify(refused.data)).toContain('not available on this route');
  expect(seen).toHaveLength(0);
  expect(codexCalls).toHaveLength(0);
});

test('changing Cloud sharing ends every read grant the project had outstanding', async () => {
  const { id } = await project();
  const queued = openReadGrant(id);
  const other = openReadGrant('another-project');
  expect(readGrantLive(queued)).toBe(true);
  const changed = await request(`/projects/${id}/cloud-sharing`, 'PUT', {
    expectedVersion: 1, routes: ['claude-code'], documents: [],
    shareConversationHistory: false, shareReviewPackets: false,
  });
  expect(changed.status).toBe(200);
  expect(readGrantLive(queued)).toBe(false);
  expect(readGrantLive(other)).toBe(true);
});
