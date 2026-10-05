/**
 * DIO-201: the real host script (resources/bonsai-host.ps1) under real PowerShell, against a fake
 * server on this computer. Every acquire here is an inference acquire (-NoStart), so the script
 * reads the server and holds or refuses the lease: it never runs the start or stop script, and
 * nothing starts, stops or loads a model. Skipped off Windows and where PowerShell 7 is missing.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseLocalModelDescriptor, type LocalModelDescriptor } from '../shared/local-model.js';
import { WindowsLocalModelHost } from '../server/bonsai/windows-host.js';
import { meadowDescriptor, writeLocalModelFolder } from './fixtures/local-model.js';

const powershell = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell/7/pwsh.exe'),
  ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'pwsh.exe')),
  path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'),
].find((file) => fs.existsSync(file));

let root: string, folder: string, server: http.Server, descriptor: LocalModelDescriptor, host: WindowsLocalModelHost;
let context: number, seen: string[];
const script = path.resolve('resources/bonsai-host.ps1');

describe.skipIf(process.platform !== 'win32' || !powershell)('the host script, reading a fake local server', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-route-script-'));
    server = http.createServer((request, response) => {
      seen.push(String(request.url));
      const routes: Record<string, unknown> = {
        '/health': { status: 'ok' },
        '/v1/models': { object: 'list', data: [{ id: 'meadow-9b', object: 'model' }] },
        '/props': { default_generation_settings: { n_ctx: context } },
      };
      const body = routes[String(request.url)];
      response.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body ?? { error: 'Not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const raw = meadowDescriptor(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    folder = writeLocalModelFolder(path.join(root, 'meadow'), raw);
    descriptor = parseLocalModelDescriptor(raw, folder);
    host = new WindowsLocalModelHost(path.join(root, 'data'), script, { NECTOVIA_LOCAL_MODEL_POWERSHELL: powershell });
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  beforeEach(() => {
    context = 16384;
    seen = [];
  });

  it('holds the running profile, reports the served model and context, and releases on request', async () => {
    const lease = await host.acquire(descriptor.profiles[0], { start: false }, descriptor);
    expect(lease.status).toEqual({ state: 'ready', installed: true, mode: 'Quick', model: 'meadow-9b', contextTokens: 16384,
      owned: false, detail: 'meadow-9b Quick is ready.' });
    expect(seen).toEqual(['/health', '/v1/models', '/props']);
    expect(fs.existsSync(path.join(folder, 'delegate.lock'))).toBe(true);
    await lease.release();
    expect(lease.signal?.aborted).toBe(false);
  }, 60_000);

  it('refuses another profile without switching it', async () => {
    await expect(host.acquire(descriptor.profiles[1], { start: false }, descriptor)).rejects.toMatchObject({ state: 'unloaded',
      message: 'The local model is running its Quick profile, not Deep. Start Deep first.' });
  }, 60_000);

  it('refuses work when the server runs a context no profile declares', async () => {
    context = 32768;
    await expect(host.acquire(descriptor.profiles[0], { start: false }, descriptor)).rejects.toMatchObject({ state: 'unloaded',
      message: 'The local model is running with 32,768 tokens of context, which matches none of its profiles. Start Quick first.' });
  }, 60_000);

  it('refuses work when nothing listens on the described port', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const raw = meadowDescriptor(`http://127.0.0.1:${port}`);
    const quiet = writeLocalModelFolder(path.join(root, 'quiet'), raw);
    await expect(host.acquire(descriptor.profiles[0], { start: false }, parseLocalModelDescriptor(raw, quiet)))
      .rejects.toMatchObject({ state: 'unloaded', message: "The local model isn't running. Start it first." });
  }, 60_000);
});
