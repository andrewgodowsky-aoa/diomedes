import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { CursorAdapter } from '../server/engines/cursor';
import { shareAfter } from './fixtures/cloud-sharing-grant';

// A project thread on Cursor in a real browser: the Console sends Ask through the conversation to
// Cursor's kept ACP session (spec 3.1, O19), the next message continues that session, and Cursor's
// thinking is saved with the reply. The actual app, host, SSE and built Console; only the agent is
// the fixture ACP process (tests/fixtures/acp-agent.mjs), which answers with how many earlier
// turns its session holds.
test.describe.configure({ mode: 'serial' });
const FIXTURE = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${endpoint}: ${response.status}`).toBe(true);
  const value = (await response.json()) as T;
  await shareAfter(api, endpoint, method, value);
  return value;
}
async function start() {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results', 'kept-session-thread-ui-'));
  const deps = {
    spawn: (_file: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
      spawn(process.execPath, [FIXTURE], options) as ChildProcessWithoutNullStreams,
    capture: (async (options: { args: string[] }) =>
      options.args.includes('--version')
        ? { code: 0, stdout: '2026.08.11-e8db854' }
        : { code: 0, stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true }) }) as never,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
  };
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'cursor',
        name: 'Fixture',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Fixture',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS.cursor,
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS.cursor,
    adapter: (_engine, _location, cwd) => new CursorAdapter(path.join(root, 'agent'), cwd, deps),
  });
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  // The Console this spec reads must be built after the change it proves.
  expect((await fs.stat(path.join(dist, 'index.html'))).mtimeMs).toBeGreaterThan(
    (await fs.stat('client/console/thread-send.ts')).mtimeMs,
  );
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', (req, res) => app(req, res));
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/cursor', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'cursor', model: 'fixture-model' });
  const project = await api<{ id: string }>('/projects', 'POST', { name: 'Cursor kept session' });
  const thread = await api<{ id: string }>(`/projects/${project.id}/threads`, 'POST', { name: 'Lunch menu', mode: 'ask' });
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'cursor' });
  await api('/settings', 'PUT', {
    detail: 'technical',
    openProjects: [project.id],
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
}
test.afterEach(async () => {
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function open(page: Page) {
  await page.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.protocol.startsWith('http') && target.hostname !== '127.0.0.1')
      throw new Error(`Unexpected nonlocal request: ${target.origin}`);
    await route.continue();
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Cursor kept session', exact: true }).click();
}
async function send(page: Page, words: string) {
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill(words);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Send this message?' })
    .getByRole('button', { name: 'Send message', exact: true })
    .click();
}

test("a Cursor thread's Ask goes through its kept session: the next message continues it, and its thinking is kept", async ({ page }) => {
  await start();
  await open(page);
  const transcript = page.locator('.transcript');
  await send(page, 'Please think about the lunch menu.');
  await expect(transcript).toContainText('answer after 0 earlier turns');
  // Cursor's thinking, saved folded on its reply.
  await expect(transcript.getByRole('button', { name: /^Thought for/ })).toHaveCount(1);
  await send(page, 'And for dinner?');
  // The same ACP session answers: it holds the first turn.
  await expect(transcript).toContainText('answer after 1 earlier turns');
});
