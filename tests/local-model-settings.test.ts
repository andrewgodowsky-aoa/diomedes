/**
 * DIO-201: which local model the app offers comes from the folder Settings names, then the folder
 * the environment names, then none, when the option stays hidden. Real folders on disk, a fake
 * host, no model and no server: nothing here starts, stops or calls a model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import type { LocalModelsView } from '../shared/local-model.js';
import type { IntegrationStatus, Settings } from '../shared/types.js';
import { fakeLocalHost, meadowDescriptor, writeLocalModelFolder } from './fixtures/local-model.js';

const headers = { 'content-type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, base: string, app: Awaited<ReturnType<typeof createApp>>, server: Server;
let env: Record<string, string | undefined>;
let fake: ReturnType<typeof fakeLocalHost>;
let meadow: string, orchard: string;

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  expect(response.status, `${method} ${route}: ${JSON.stringify(response.data)}`).toBe(200);
  return response.data as T;
}
const local = async () => (await api<{ integrations: IntegrationStatus[] }>('/integrations/local')).integrations;
const listed = async () => (await api<{ integrations: IntegrationStatus[] }>('/integrations')).integrations
  .filter((item) => item.id === 'bonsai');
const setFolder = (folder: string | null) => api<Settings>('/settings', 'PUT', { localModelFolder: folder });

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-route-settings-'));
  meadow = writeLocalModelFolder(path.join(root, 'meadow'), meadowDescriptor('http://127.0.0.1:18100'));
  const second = meadowDescriptor('http://127.0.0.1:18101');
  orchard = writeLocalModelFolder(path.join(root, 'orchard'), { ...second, name: 'Orchard Local', model: 'orchard-12b',
    profiles: { Small: second.profiles.Quick } });
  env = {};
  fake = fakeLocalHost();
  app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null, automationTickMs: null, localModel: { host: fake.host, env } });
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (app) await app.locals.close();
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('where the local model comes from', () => {
  it('offers nothing with no folder in Settings or the environment', async () => {
    expect(await listed()).toEqual([]);
    expect(await local()).toEqual([]);
    expect((await api<{ models: unknown[] }>('/engines/bonsai/models')).models).toEqual([]);
    expect(await api<LocalModelsView>('/ai/local-models')).toMatchObject({ name: null, folder: null, models: [],
      status: { state: 'missing', installed: false, detail: 'No local model folder is set.' } });
    const wake = await request('/ai/local-models/wake', 'POST', { model: 'local:quick' });
    expect(wake.status).toBe(409);
    expect(fake.state.starts).toEqual([]);
  });

  it('reads the older environment name, then the new one, then the Settings folder ahead of both', async () => {
    env.NECTOVIA_BONSAI_HOME = orchard;
    expect(await listed()).toEqual([expect.objectContaining({ id: 'bonsai', name: 'Orchard Local', found: true, location: orchard })]);
    env.NECTOVIA_LOCAL_MODEL_HOME = meadow;
    expect(await local()).toEqual([expect.objectContaining({ name: 'Meadow Local', location: meadow })]);
    expect(await api<LocalModelsView>('/ai/local-models')).toMatchObject({ name: 'Meadow Local',
      folder: { path: meadow, source: 'environment' } });

    expect((await setFolder(orchard)).localModelFolder).toBe(orchard);
    expect(await local()).toEqual([expect.objectContaining({ name: 'Orchard Local', location: orchard })]);
    const view = await api<LocalModelsView>('/ai/local-models');
    expect(view).toMatchObject({ name: 'Orchard Local', folder: { path: orchard, source: 'settings' } });
    expect(view.models.map((model) => [model.slug, model.name])).toEqual([['local:small', 'orchard-12b Small']]);

    expect((await setFolder(null)).localModelFolder).toBeNull();
    expect(await local()).toEqual([expect.objectContaining({ name: 'Meadow Local' })]);
    delete env.NECTOVIA_LOCAL_MODEL_HOME;
    delete env.NECTOVIA_BONSAI_HOME;
    expect(await local()).toEqual([]);
  });

  it('lists the profiles the folder describes, under the name its server lists, and wakes them by slug', async () => {
    await setFolder(meadow);
    const catalog = await api<{ models: { slug: string; name: string; contextTokens: number }[] }>('/engines/bonsai/models');
    expect(catalog.models.map((model) => [model.slug, model.name, model.contextTokens])).toEqual([
      ['local:quick', 'meadow-9b Quick', 16384], ['local:deep', 'meadow-9b Deep', 131072]]);
    expect(await api('/ai/local-models/wake', 'POST', { model: 'local:deep' })).toMatchObject({ state: 'ready', mode: 'Deep',
      model: 'meadow-9b', contextTokens: 131072, detail: 'meadow-9b Deep is ready.' });
    expect(fake.state.starts).toEqual(['local:deep']);
    expect(await local()).toEqual([expect.objectContaining({ available: true, loaded: 'local:deep', status: 'Running',
      capabilities: ['text', 'tools', 'images in Deep'] })]);
    // A slug saved for another model's profile is refused in plain words, and nothing starts.
    const earlier = await request('/ai/local-models/wake', 'POST', { model: 'bonsai-gaming' });
    expect(earlier).toEqual({ status: 400, data: expect.objectContaining({
      error: 'The local model has no Gaming profile now. Choose one of its profiles.' }) });
    expect(fake.state.starts).toEqual(['local:deep']);
  });

  it('lists a folder it cannot use as needing attention, with the reason, and offers no profile', async () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    await setFolder(empty);
    expect(await listed()).toEqual([expect.objectContaining({ id: 'bonsai', name: 'Local model', found: false, available: false,
      status: 'Needs attention', detail: `There is no nectovia-connection.json in ${empty}.`, location: empty })]);
    expect((await api<{ models: unknown[] }>('/engines/bonsai/models')).models).toEqual([]);
    expect(await api<LocalModelsView>('/ai/local-models')).toMatchObject({ name: null, folder: { path: empty, source: 'settings' },
      models: [], status: { state: 'error', installed: false } });
  });

  it('takes only a full path, at most 260 characters, in Settings', async () => {
    for (const folder of ['models\\meadow', 'meadow', 42, `C:\\${'x'.repeat(300)}`]) {
      const refused = await request('/settings', 'PUT', { localModelFolder: folder });
      expect(refused).toEqual({ status: 400, data: expect.objectContaining({
        error: 'Enter the local model folder as a full path, such as F:\\Models\\Local.' }) });
    }
    expect((await setFolder(`  ${meadow}  `)).localModelFolder).toBe(meadow);
    expect((await setFolder('   ')).localModelFolder).toBeNull();
  });
});
