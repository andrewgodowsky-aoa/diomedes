import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type { AdapterInspection } from '../server/engines/contract.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import type { EngineConnection } from '../shared/engines.js';

// The host, not the person, asks for the inspection once a native sign-in
// window ends, and the window ending is never itself read as signed in.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fakeWindow() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 4242, kill: () => true, exitCode: null, killed: false });
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

async function fixture(inspect: () => Promise<AdapterInspection>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-signin-wiring-'));
  const version = TESTED_VERSIONS['claude-code'];
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'claude-code',
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
        installedVersion: version,
        location: 'fixture.exe',
        disclosure: [],
      },
    ],
    version: async () => version,
    adapter: () => ({
      id: 'claude-code',
      contract: routeContractFor('claude-code'),
      inspect,
      generate: async () => {
        throw new Error('A sign-in recheck never sends a request.');
      },
    }),
  });
  const windows: ChildProcess[] = [];
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    nativeLoginLaunch: () => {
      const child = fakeWindow();
      windows.push(child);
      return child;
    },
  });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  cleanups.push(async () => {
    await app.locals.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const post = (route: string, body: unknown) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: JSON.stringify(body),
    });
  const status = async () =>
    ((await (await fetch(`${base}/ai/status`)).json()) as { connections: EngineConnection[] })
      .connections.find((c) => c.engine === 'claude-code')!;
  return { post, status, windows };
}

describe('a finished native sign-in asks the host for one fresh inspection', () => {
  it.skipIf(process.platform === 'win32')('asks for external sign-in on an unsupported console platform', async () => {
    const inspect = vi.fn<() => Promise<AdapterInspection>>();
    const { post, windows } = await fixture(inspect);
    expect((await post('/ai/discover', { consent: true })).status).toBe(200);
    const response = await post('/ai/login/claude-code', { consent: true });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Run the native tool sign-in on your platform');
    expect(windows).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('reports the Windows sign-in window, rechecks when it closes, and shows what the recheck found', async () => {
    const inspect = vi.fn<() => Promise<AdapterInspection>>(async () => ({
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
      detail: 'Claude Code is not signed in.',
    }));
    const { post, status, windows } = await fixture(inspect);
    expect((await post('/ai/discover', { consent: true })).status).toBe(200);
    expect((await post('/ai/login/claude-code', { consent: true })).status).toBe(200);
    expect((await status()).signInWindow).toBe('running');
    expect(inspect).not.toHaveBeenCalled();

    // Exit code zero is the case that used to be read as success.
    windows[0].emit('exit', 0, null);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await status()).signInWindow).toBe('idle'));
    const after = await status();
    expect(after.authentication).toBe('signed-out');
    expect(after.nextAction).toBe('sign-in');
  });

  it.skipIf(process.platform !== 'win32')('does not let a check that began before the Windows sign-in finished be the last word', async () => {
    // The first inspection starts while the person is still signing in, so it
    // can only ever answer signed-out. It is held open until the window closes.
    let releaseFirst: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const inspect = vi
      .fn<() => Promise<AdapterInspection>>()
      .mockImplementationOnce(async () => {
        await held;
        return {
          authentication: 'signed-out',
          accountRoute: null,
          models: [],
          detail: 'Claude Code is not signed in.',
        };
      })
      .mockImplementation(async () => ({
        authentication: 'signed-in',
        accountRoute: 'claude-code:claude.ai',
        models: [
          { slug: 'sonnet', name: 'Sonnet', description: '', efforts: [], defaultEffort: null },
        ],
        detail: 'Signed in.',
      }));
    const { post, status, windows } = await fixture(inspect);
    expect((await post('/ai/discover', { consent: true })).status).toBe(200);
    expect((await post('/ai/login/claude-code', { consent: true })).status).toBe(200);
    // The person presses Check while the window is still open.
    const early = post('/ai/check/claude-code', { consent: true });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));

    windows[0].emit('exit', 0, null);
    // The host is now waiting on the early check rather than colliding with it.
    releaseFirst!();
    await early;
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await status()).authentication).toBe('signed-in'));
  });
});
