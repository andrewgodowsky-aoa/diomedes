/**
 * DIO-201: the local model's live identity, read from a fake server on this computer. The probe
 * reads the health check, then the model list, then llama.cpp's /props, and starts nothing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseLocalModelDescriptor, type LocalModelDescriptor } from '../shared/local-model.js';
import { probeLocalModel, runningProfile } from '../server/bonsai/probe.js';
import { MEADOW_FOLDER, MEADOW_MODEL, meadowDescriptor } from './fixtures/local-model.js';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
let routes: Record<string, Reply>;
let seen: string[];
let server: http.Server;
let descriptor: LocalModelDescriptor;

const props = (context: number, vision?: boolean): Reply => ({ status: 200, body: {
  default_generation_settings: { n_ctx: context }, ...(vision === undefined ? {} : { modalities: { vision } }) } });

beforeAll(async () => {
  server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    const reply = routes[request.url ?? ''] ?? { status: 404, body: { error: 'Not found' } };
    response.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
    response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  descriptor = parseLocalModelDescriptor(meadowDescriptor(`http://127.0.0.1:${port}`), MEADOW_FOLDER);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen = [];
  routes = {
    '/health': { status: 200, body: { status: 'ok' } },
    '/v1/models': { status: 200, body: { object: 'list', data: [{ id: MEADOW_MODEL, object: 'model' }] } },
    '/props': props(16384),
  };
});

describe('the live identity of a running server', () => {
  it('names the served model and chooses the profile whose context the server runs', async () => {
    expect(await probeLocalModel(descriptor)).toEqual({ state: 'ready', installed: true, mode: 'Quick', model: MEADOW_MODEL,
      contextTokens: 16384, owned: false, detail: 'meadow-9b Quick is ready.' });
    routes['/props'] = props(131072, true);
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'ready', mode: 'Deep', contextTokens: 131072,
      detail: 'meadow-9b Deep is ready.' });
    expect(seen).toEqual(['GET /health', 'GET /v1/models', 'GET /props', 'GET /health', 'GET /v1/models', 'GET /props']);
  });

  it('runs, with no known profile, when /props does not answer', async () => {
    delete routes['/props'];
    expect(await probeLocalModel(descriptor)).toEqual({ state: 'ready', installed: true, mode: null, model: MEADOW_MODEL,
      contextTokens: null, owned: false, detail: 'meadow-9b is running, but it did not report its context size.' });
  });

  it('shows the served context when it matches no profile', async () => {
    routes['/props'] = props(32768);
    expect(await probeLocalModel(descriptor)).toEqual({ state: 'ready', installed: true, mode: null, model: MEADOW_MODEL,
      contextTokens: 32768, owned: false,
      detail: 'meadow-9b is running with 32,768 tokens of context, which matches none of its profiles.' });
  });

  it('does not take a server without vision for the profile that takes images', async () => {
    routes['/props'] = props(131072, false);
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'ready', mode: null, contextTokens: 131072 });
    expect(runningProfile(descriptor, 131072, null)?.mode).toBe('Deep');
    expect(runningProfile(descriptor, 16384, false)?.mode).toBe('Quick');
  });

  it('refuses a server that lists another model', async () => {
    routes['/v1/models'] = { status: 200, body: { data: [{ id: 'other-7b' }] } };
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'error', mode: null,
      detail: 'The local server lists other-7b, not meadow-9b.' });
    routes['/v1/models'] = { status: 200, body: { data: [] } };
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'error', detail: 'The local server lists no model, not meadow-9b.' });
    delete routes['/v1/models'];
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'error', detail: 'Meadow Local did not list its models.' });
  });
});

describe('a server that is down, loading or failing', () => {
  it('is not running when nothing answers', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const down = parseLocalModelDescriptor(meadowDescriptor(`http://127.0.0.1:${port}`), MEADOW_FOLDER);
    expect(await probeLocalModel(down)).toEqual({ state: 'unloaded', installed: true, mode: null, model: null,
      contextTokens: null, owned: false, detail: "Meadow Local isn't running." });
  });

  it('is starting while its health check answers 503 or a status other than ok', async () => {
    routes['/health'] = { status: 503, body: { error: { message: 'Loading model' } } };
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'starting', detail: 'Meadow Local is starting.' });
    routes['/health'] = { status: 200, body: { status: 'loading model' } };
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'starting' });
    expect(seen).toEqual(['GET /health', 'GET /health']);
  });

  it('needs attention when its health check fails or redirects', async () => {
    routes['/health'] = { status: 500, body: { error: 'broken' } };
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'error', mode: null,
      detail: "Meadow Local's health check answered HTTP 500." });
    routes['/health'] = { status: 302, headers: { Location: 'http://127.0.0.1:1/elsewhere' } };
    expect(await probeLocalModel(descriptor)).toMatchObject({ state: 'error',
      detail: "Meadow Local's health check answered with a redirect." });
    expect(seen).toEqual(['GET /health', 'GET /health']);
  });

  it('needs attention when its health check does not answer in time', async () => {
    const slow = http.createServer(() => { /* Never answers. */ });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    try {
      const port = (slow.address() as AddressInfo).port;
      const quiet = parseLocalModelDescriptor(meadowDescriptor(`http://127.0.0.1:${port}`), MEADOW_FOLDER);
      expect(await probeLocalModel(quiet, { timeoutMs: 150 })).toMatchObject({ state: 'error',
        detail: 'Meadow Local did not answer its health check.' });
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});
