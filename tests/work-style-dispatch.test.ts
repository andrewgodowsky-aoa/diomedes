import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { forgetCatalog } from '../server/models.js';

/**
 * WorkStyle at dispatch: the model and level a ChatGPT request is actually sent
 * with. The runtime is stubbed and every call is recorded; the catalogue is a
 * cache written into a private CODEX_HOME, so the test reads what the runtime
 * would list and never the machine's own account.
 */
const calls: { model?: string; effort?: string; prompt: string }[] = [];
vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    askCodex: async (input: { model?: string; effort?: string; prompt: string }) => {
      calls.push({ model: input.model, effort: input.effort, prompt: input.prompt });
      return {
        text: 'An answer.',
        model: input.model ?? 'gpt-6-astra',
        version: '0.153.4',
        threadId: 'mock-thread',
      };
    },
  };
});

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const entry = (slug: string, priority: number, levels = LEVELS) => ({
  slug,
  display_name: slug.toUpperCase(),
  description: '',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: levels.map((effort) => ({ effort, description: '' })),
  visibility: 'list',
  priority,
});
const FULL = [entry('gpt-6-astra', 1), entry('gpt-6-sol', 2), entry('gpt-6-luna', 3, LEVELS.slice(0, 5))];

let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
let home: string, previousHome: string | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
function writeCatalog(models: unknown[]) {
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models }), 'utf8');
  forgetCatalog();
}
async function project() {
  await request('/settings', 'PUT', { services: { codex: true } });
  const created = await request('/projects/sample', 'POST', {});
  expect(created.status).toBe(200);
  const projectId = created.data.id as string;
  const thread = await request(`/projects/${projectId}/threads`, 'POST', { name: 'Styles' });
  expect(thread.status).toBe(201);
  return { projectId, threadId: thread.data.id as string };
}
async function ask(projectId: string, threadId: string, text = 'What should we do next?', mode = 'ask') {
  return request(`/projects/${projectId}/ask`, 'POST', { mode, text, route: 'codex', threadId, consent: true });
}

beforeEach(async () => {
  calls.length = 0;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-style-codex-'));
  previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  writeCatalog(FULL);
  await fsp.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fsp.mkdtemp(path.join(process.cwd(), 'test-results', 'work-style-'));
  app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20 });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  const closingApp = app, closingServer = server;
  try {
    await closingApp?.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close((e) => (e ? reject(e) : resolve())));
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    forgetCatalog();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('dispatch without a style', () => {
  test('sends exactly what it sent before: the saved default, or nothing', async () => {
    const { projectId, threadId } = await project();
    expect((await ask(projectId, threadId)).status).toBe(200);
    expect(calls.at(-1)?.model).toBeUndefined();
    expect(calls.at(-1)?.effort).toBe('low'); // Ask's own level
    await request('/settings', 'PUT', { services: { codex: true, codexModel: 'gpt-6-astra', codexEffort: 'high' } });
    expect((await ask(projectId, threadId)).status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
  });
});

describe('dispatch with a style', () => {
  test('each style sends the model and level it resolves to', async () => {
    const { projectId, threadId } = await project();
    const expected = {
      efficient: { model: 'gpt-6-luna', effort: 'low' },
      focused: { model: 'gpt-6-sol', effort: 'medium' },
      thorough: { model: 'gpt-6-astra', effort: 'high' },
    };
    for (const [style, sent] of Object.entries(expected)) {
      const put = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: style });
      expect(put.status).toBe(200);
      expect((await ask(projectId, threadId)).status).toBe(200);
      expect(calls.at(-1)).toMatchObject(sent);
    }
  });

  test('a greeting stays cheap in Thorough; Plan reasons one level deeper', async () => {
    const { projectId, threadId } = await project();
    await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: 'thorough' });
    await ask(projectId, threadId, 'hi');
    expect(calls.at(-1)).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
    await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: 'focused' });
    await ask(projectId, threadId, 'Plan the migration.', 'plan');
    expect(calls.at(-1)).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
  });

  test('the Settings default applies to a thread that names no style', async () => {
    const { projectId, threadId } = await project();
    expect((await request('/settings', 'PUT', { services: { codex: true, workStyle: 'focused' } })).status).toBe(200);
    await ask(projectId, threadId);
    expect(calls.at(-1)).toMatchObject({ model: 'gpt-6-sol', effort: 'medium' });
    expect((await request('/settings', 'PUT', { services: { codex: true, workStyle: 'build' } })).status).toBe(400);
  });

  test('an explicit pin always wins over the style', async () => {
    const { projectId, threadId } = await project();
    const pinned = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      workStyle: 'efficient',
      engine: 'codex',
      requested: { model: 'gpt-6-astra', effort: 'xhigh' },
    });
    expect(pinned.status).toBe(200);
    await ask(projectId, threadId, 'hi');
    expect(calls.at(-1)).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' });
    const view = await request(`/projects/${projectId}/threads/${threadId}/work-style`);
    expect(view.data.resolution).toMatchObject({ model: 'gpt-6-astra', pinScope: 'all-calls', selection: 'manual' });
  });

  test('asks instead of downgrading, and sends nothing', async () => {
    writeCatalog([entry('gpt-6-luna', 3, LEVELS.slice(0, 5))]);
    const { projectId, threadId } = await project();
    await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: 'focused' });
    const refused = await ask(projectId, threadId);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.data)).toContain('Sol');
    expect(calls).toHaveLength(0);
    const view = await request(`/projects/${projectId}/threads/${threadId}/work-style`);
    expect(view.data).toMatchObject({ style: 'focused', source: 'thread', resolution: { outcome: 'ask' } });
  });

  test('a pinned model the route withdrew is not swapped for the account default', async () => {
    const { projectId, threadId } = await project();
    const pinned = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      engine: 'codex',
      requested: { model: 'gpt-6-sol', effort: 'medium' },
    });
    expect(pinned.status).toBe(200);
    writeCatalog([entry('gpt-6-astra', 1)]);
    const refused = await ask(projectId, threadId);
    expect(refused.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test('Work records a style-chosen model as chosen automatically, never as the person’s', async () => {
    const { projectId, threadId } = await project();
    await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: 'focused' });
    const started = await request(`/projects/${projectId}/ask`, 'POST', {
      mode: 'work',
      text: 'Tidy the brief.',
      route: 'codex',
      threadId,
      consent: true,
    });
    expect(started.status).toBe(200);
    expect(started.data.session.agent).toMatchObject({ requestedModel: 'gpt-6-sol', modelSelection: 'automatic' });
    expect(started.data.turn.helper).toMatchObject({ model: 'gpt-6-sol', verified: false });
  });

  test('a style never changes the mode, the permission or the route', async () => {
    const { projectId, threadId } = await project();
    await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { mode: 'plan', permission: 'show-first', engine: 'codex' });
    const before = (await request(`/projects/${projectId}/threads`)).data.threads.find((t: { id: string }) => t.id === threadId);
    for (const style of ['efficient', 'focused', 'thorough', null]) {
      const put = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: style });
      expect(put.status).toBe(200);
      expect(put.data).toMatchObject({ mode: before.mode, permission: before.permission, engine: before.engine, workStyle: style });
    }
    expect((await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', { workStyle: 'ultra' })).status).toBe(400);
  });
});
