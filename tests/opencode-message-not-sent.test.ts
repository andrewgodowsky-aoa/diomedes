/**
 * A second message on a kept OpenCode conversation, sent by the real client conversation code to
 * the real app, against the fixture `opencode serve`. Every message is admitted with a fresh
 * check that starts its own OpenCode server and removes that server's folder afterwards. On
 * Windows the removal can fail for a moment (EBUSY, EPERM), and that system error used to reach
 * the route as a 500 on both of the client's attempts, so the message was offered back as one
 * Nectovia could not confirm. Live opencode 1.18.4 and Windows file locks are not reached here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import { OpenCodeAdapter } from '../server/engines/opencode.js';
import type { Conversation, Project } from '../shared/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/opencode-session-server.mjs', import.meta.url));
const realFetch = globalThis.fetch;
const realRm = fs.rm.bind(fs);
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

/** What Windows answers when a folder's files are still held by a process that just ended. */
const held = () =>
  Object.assign(new Error("EBUSY: resource busy or locked, rmdir 'C:\\engines\\opencode\\.diomedes-opencode-x'"), {
    code: 'EBUSY',
    syscall: 'rmdir',
  });

/** Faults switched on between messages. */
const faults = { admission: false };

/** The adapter with one seam: an admission check that fails with a system error. */
class AdmissionFault extends OpenCodeAdapter {
  override async inspect(signal?: AbortSignal) {
    const inspection = await super.inspect(signal);
    if (faults.admission) throw held();
    return inspection;
  }
}

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
let client: typeof import('../client/conversation-send.js');

/** The browser storage and locks the conversation client keeps its pending message in. */
function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  };
}
function locks() {
  const tail = new Map<string, Promise<void>>();
  return {
    async request(name: string, _options: unknown, callback: () => unknown) {
      const previous = tail.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      tail.set(name, previous.then(() => mine));
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await realFetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes opencode not sent '));
  vi.stubEnv('XDG_CACHE_HOME', path.join(os.tmpdir(), 'diomedes-no-opencode-cache'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'opencode-data'));
  faults.admission = false;
  const engines = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'opencode',
        name: 'OpenCode',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Fixture',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS.opencode,
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS.opencode,
    adapter: (_engine, _location, cwd) =>
      new AdmissionFault('opencode', cwd, {
        fetch: realFetch,
        spawn: (_command, args, options) =>
          spawn(process.execPath, [FIXTURE, args[args.indexOf('--port') + 1], 'ok'], options) as ChildProcessWithoutNullStreams,
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 5_000,
      }),
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
  } as Parameters<typeof createApp>[0]);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/opencode', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'opencode', model: 'opencode-go/go-model' });
  project = await api<Project>('/projects', 'POST', { name: 'OpenCode second message' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['opencode'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'opencode' });
  // The browser half: the client's relative /api requests reach this server.
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('navigator', { locks: locks() });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(`${base}${url}`, init));
  vi.resetModules();
  client = await import('../client/conversation-send.js');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (server) {
    const closingApp = app;
    const closingServer = server;
    server = undefined;
    try {
      await closingApp.locals.close();
    } finally {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
  }
  vi.unstubAllEnvs();
  await realRm(root, { recursive: true, force: true, maxRetries: 5 });
});

const say = (text: string) => ({ text, mode: 'ask' as const, sources: [] });

describe('a second message on a kept OpenCode conversation', () => {
  test('is answered when the folder of the check before it cannot be removed yet', async () => {
    const first = await client.sendMessage(project.id, thread.id, say('hi'));
    expect(first.outcome).toEqual({ status: 'answered' });
    // From here every OpenCode server folder is held, as Windows can hold one for a moment.
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('.diomedes-opencode-')) throw held();
      return realRm(target, options);
    });
    const second = await client.sendMessage(project.id, thread.id, say('second message'));
    expect(second.answerText).toMatch(/^answer:second message \(turn 2 of /);
    expect(client.pendingMessage(project.id, thread.id)).toBeNull();
    // Each server folder's removal was retried before the folder was left.
    const removals = rm.mock.calls.filter(
      ([target, options]) =>
        path.basename(String(target)).startsWith('.diomedes-opencode-') && options?.recursive === true,
    );
    expect(removals.length).toBeGreaterThan(0);
    for (const [, options] of removals) expect(options).toMatchObject({ maxRetries: 8 });
  });

  test('that could not be admitted is refused as not sent, and the next message goes on', async () => {
    const first = await client.sendMessage(project.id, thread.id, say('hi'));
    expect(first.outcome).toEqual({ status: 'answered' });
    faults.admission = true;
    const refused = await client.sendMessage(project.id, thread.id, say('second message')).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).not.toBeInstanceOf(client.UnconfirmedMessage);
    expect(refused).toMatchObject({
      status: 409,
      message: "Nectovia couldn't check OpenCode before sending, so your message wasn't sent. Send it again.",
      data: { code: 'ADMISSION_FAILED' },
    });
    // Nothing is offered back as unconfirmed.
    expect(client.pendingMessage(project.id, thread.id)).toBeNull();
    faults.admission = false;
    const again = await client.sendMessage(project.id, thread.id, say('second message'));
    expect(again.answerText).toMatch(/^answer:second message \(turn 2 of /);
  });

  test('that keeps failing admission is refused each time, never left waiting on an attempt limit', async () => {
    await client.sendMessage(project.id, thread.id, say('hi'));
    faults.admission = true;
    for (let attempt = 0; attempt < 4; attempt++) {
      const refused = await client.sendMessage(project.id, thread.id, say('second message')).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({ status: 409, data: { code: 'ADMISSION_FAILED' } });
      expect(client.pendingMessage(project.id, thread.id)).toBeNull();
    }
  });
});
