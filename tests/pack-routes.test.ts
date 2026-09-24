import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';

vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    askCodex: async () => ({
      text: '{"summary":"A mocked proposal.","changes":[]}',
      model: 'gpt-6-astra',
      version: '0.153.4',
      threadId: 'mock-thread',
    }),
  };
});

let temp: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;

const call = async (route: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
};

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-pack-routes-'));
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    stepMs: 20,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  const closingApp = app,
    closingServer = server;
  try {
    await closingApp?.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(temp, { recursive: true, force: true });
  }
});

describe('the pack routes', () => {
  test('the listing says what is installed, what ships, and what this project loaded', async () => {
    const folder = path.join(temp, 'kitchen');
    await fs.mkdir(folder, { recursive: true });
    const project = (await call('/projects', 'POST', { name: 'Kitchen', folder })).data.id as string;
    const listed = await call(`/projects/${project}/packs`);
    expect(listed.status).toBe(200);
    expect(listed.data.storeProblem).toBeNull();
    expect(listed.data.installed.map((p: { id: string }) => p.id)).toEqual([
      'diomedes.small-business',
      'diomedes.software-engineering',
    ]);
    expect(listed.data.available.map((p: { id: string }) => p.id)).toContain('diomedes.industry.tire-service');
    expect(listed.data.loaded).toEqual([]);

    const ask = await call('/packs/install', 'POST', {
      source: { kind: 'bundled', packId: 'diomedes.industry.tire-service' },
    });
    expect(ask.status).toBe(409);
    expect(ask.data.code).toBe('needs-dependencies');
    expect(ask.data.dependencies).toEqual([
      { id: 'diomedes.weekly-brief', name: 'Weekly brief', version: '1.0.0' },
    ]);
    const done = await call('/packs/install', 'POST', {
      source: { kind: 'bundled', packId: 'diomedes.industry.tire-service' },
      includeDependencies: true,
    });
    expect(done.status).toBe(200);

    const on = await call(`/projects/${project}/packs/diomedes.industry.tire-service/activate`, 'POST', {
      includeDependencies: true,
    });
    expect(on.status).toBe(200);
    expect(on.data.activations.map((a: { packId: string }) => a.packId)).toEqual([
      'diomedes.weekly-brief',
      'diomedes.industry.tire-service',
    ]);
    const after = await call(`/projects/${project}/packs`);
    expect(after.data.loaded.map((p: { id: string; runtime: string }) => [p.id, p.runtime])).toEqual([
      ['diomedes.industry.tire-service', 'declared'],
      ['diomedes.weekly-brief', 'declared'],
    ]);

    const busy = await call('/packs/diomedes.weekly-brief/uninstall', 'POST', {});
    expect(busy.status).toBe(409);
    expect(busy.data.code).toBe('in-use');
    expect(busy.data.projects).toEqual([{ id: project, name: 'Kitchen' }]);
  });

  test('activate and deactivate still accept a request with no body, as before the lifecycle', async () => {
    const folder = path.join(temp, 'bare');
    await fs.mkdir(folder, { recursive: true });
    const project = (await call('/projects', 'POST', { name: 'Bare', folder })).data.id as string;
    // No Content-Type and no body, the way a bare client POST arrives.
    const bare = (route: string) =>
      fetch(`${url}/api${route}`, { method: 'POST', headers: { 'X-Diomedes-Client': '1' } }).then(
        async (response) => ({ status: response.status, data: await response.json() }),
      );
    const on = await bare(`/projects/${project}/packs/diomedes.software-engineering/activate`);
    expect(on.status).toBe(200);
    expect(on.data.activations).toEqual([
      expect.objectContaining({ packId: 'diomedes.software-engineering', state: 'active' }),
    ]);
    const off = await bare(`/projects/${project}/packs/diomedes.software-engineering/deactivate`);
    expect(off.status).toBe(200);
  });

  test('an id nobody ships or installed is 404 on every route', async () => {
    const folder = path.join(temp, 'kitchen');
    await fs.mkdir(folder, { recursive: true });
    const project = (await call('/projects', 'POST', { name: 'Kitchen', folder })).data.id as string;
    expect((await call(`/projects/${project}/packs/not.a.pack/activate`, 'POST', {})).status).toBe(404);
    expect((await call('/packs/not.a.pack/rollback', 'POST', {})).status).toBe(404);
    expect((await call('/packs/../uninstall', 'POST', {})).status).toBe(404);
  });

  test('a folder that is not a pack is refused by name', async () => {
    const empty = path.join(temp, 'empty');
    await fs.mkdir(empty, { recursive: true });
    const result = await call('/packs/inspect', 'POST', { source: { kind: 'directory', path: empty } });
    expect(result.status).toBe(404);
    expect(result.data.code).toBe('no-manifest');
    expect((await call('/packs/install', 'POST', { source: { kind: 'directory', path: 'relative/path' } })).status).toBe(400);
  });
});
