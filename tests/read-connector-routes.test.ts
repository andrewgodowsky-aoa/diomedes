/**
 * Approved read connectors, managed over HTTP through the real app. Each saved
 * entry is read back by the same loader an Ask or Plan turn uses, so what
 * Settings approves is exactly what a read turn gets. Nothing here starts a
 * connector or reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { loadApprovedReadServers } from '../server/engines/read-scope';
import { CONNECTOR_DATA_KINDS, type ReadConnectorsView } from '../shared/read-connectors';
import { SMALL_BUSINESS_PACK } from '../shared/capability-packs';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const TOKEN_VALUE = 'test-only-pos-token-value-never-stored';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let file: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-read-connectors-'));
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: null,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  file = path.join(root, 'data', 'read-connectors.json');
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function call(route: string, method = 'GET', body?: unknown, extra: Record<string, string> = headers) {
  const response = await fetch(`${base}/api/ai/read-connectors${route}`, {
    method,
    headers: extra,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as ReadConnectorsView };
}

const pos = {
  name: 'pos',
  command: 'pos-mcp.exe',
  args: ['--read-only'],
  envFrom: ['POS_TOKEN'],
  readTools: ['list_orders', 'daily_sales'],
  provides: ['read-sales'],
  consent: true,
};

describe('approved read connectors', () => {
  test('a new install lists none, and an approved connector reaches the read turn exactly', async () => {
    const empty = await call('');
    expect(empty.status).toBe(200);
    expect(empty.json()).toEqual({ state: 'none', problem: null, connectors: [], ignored: [] });

    const added = await call('', 'POST', pos);
    expect(added.status, added.text).toBe(200);
    expect(added.json().connectors).toEqual([
      {
        name: 'pos',
        command: 'pos-mcp.exe',
        args: ['--read-only'],
        envFrom: ['POS_TOKEN'],
        missingEnv: process.env.POS_TOKEN ? [] : ['POS_TOKEN'],
        readTools: ['list_orders', 'daily_sales'],
        provides: ['read-sales'],
        note: null,
      },
    ]);
    // The same loader an Ask or Plan turn uses reads exactly what was approved.
    expect(loadApprovedReadServers(file)).toEqual([
      {
        name: 'pos',
        command: 'pos-mcp.exe',
        args: ['--read-only'],
        envFrom: ['POS_TOKEN'],
        readTools: ['list_orders', 'daily_sales'],
      },
    ]);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.servers[0]).toMatchObject({ approved: true, transport: 'stdio' });
    // The write left no temporary file behind.
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('an environment value is never accepted or stored, only a name', async () => {
    const withValue = await call('', 'POST', { ...pos, env: { POS_TOKEN: TOKEN_VALUE } });
    expect(withValue.status).toBe(400);
    expect(withValue.text).not.toContain(TOKEN_VALUE);
    const inName = await call('', 'POST', { ...pos, envFrom: [`POS_TOKEN=${TOKEN_VALUE}`] });
    expect(inName.status).toBe(400);
    expect(inName.text).not.toContain(TOKEN_VALUE);
    await expect(fs.access(file)).rejects.toThrow();
  });

  test.each([
    ['a forwarded variable that would reroute the host', { envFrom: ['NODE_OPTIONS'] }, 'NODE_OPTIONS cannot be forwarded'],
    ['a provider key', { envFrom: ['OPENAI_API_KEY'] }, 'cannot be forwarded'],
    ['a wildcard tool', { readTools: ['*'] }, 'no spaces or wildcards'],
    ['no read tool', { readTools: [] }, 'at least one read tool'],
    ['a name that is not a plain identifier', { name: 'My POS' }, 'lowercase letters'],
    ['no consent', { consent: false }, 'approve these read tools'],
    ['a transport other than a local command', { transport: 'http' }, ''],
    ['an unknown kind of data', { provides: ['read-everything'] }, ''],
  ])('refuses %s, and writes nothing', async (_label, patch, message) => {
    const refused = await call('', 'POST', { ...pos, ...patch });
    expect(refused.status).toBe(400);
    if (message) expect(refused.text).toContain(message);
    await expect(fs.access(file)).rejects.toThrow();
  });

  test('a write without the client header is refused', async () => {
    const refused = await call('', 'POST', pos, { 'Content-Type': 'application/json' });
    expect(refused.status).toBe(403);
    await expect(fs.access(file)).rejects.toThrow();
  });

  test('change keeps the name and remove takes the connector away', async () => {
    await call('', 'POST', pos);
    expect((await call('', 'POST', pos)).status).toBe(409);
    const changed = await call('/pos', 'PUT', { ...pos, readTools: ['daily_sales'], note: 'Front counter' });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.json().connectors[0]).toMatchObject({ readTools: ['daily_sales'], note: 'Front counter' });
    expect((await call('/pos', 'PUT', { ...pos, name: 'till' })).status).toBe(400);
    expect((await call('/none', 'PUT', { ...pos, name: 'none' })).status).toBe(404);
    const removed = await call('/pos', 'DELETE');
    expect(removed.json().connectors).toEqual([]);
    expect(loadApprovedReadServers(file)).toEqual([]);
    expect((await call('/pos', 'DELETE')).status).toBe(404);
  });

  test('a malformed file is reported and never written over', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const broken = '{"version": 1, "servers": [ {"name": "pos"';
    await fs.writeFile(file, broken);
    const read = await call('');
    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({ state: 'malformed', connectors: [] });
    expect(read.json().problem).toContain('read-connectors.json');
    for (const [route, method, body] of [
      ['', 'POST', pos],
      ['/pos', 'PUT', pos],
      ['/pos', 'DELETE', undefined],
    ] as const) {
      const refused = await call(route, method, body);
      expect(refused.status).toBe(409);
      expect(refused.text).toContain('nothing was changed');
    }
    expect(await fs.readFile(file, 'utf8')).toBe(broken);
    // A well-formed file of the wrong shape is refused the same way.
    await fs.writeFile(file, JSON.stringify({ version: 2, servers: [] }));
    expect((await call('')).json().state).toBe('malformed');
    expect((await call('', 'POST', pos)).status).toBe(409);
  });

  test('entries a read turn skips are listed and kept exactly as they were', async () => {
    const unapproved = { name: 'books', approved: false, transport: 'stdio', command: 'books.exe', readTools: ['list'] };
    const hand = { name: 'till', approved: true, transport: 'stdio', command: 'till.exe', readTools: ['sales'], extra: 1 };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, servers: [unapproved, hand] }));
    const listed = (await call('')).json();
    expect(listed.connectors).toEqual([]);
    expect(listed.ignored.map((entry) => [entry.index, entry.name])).toEqual([
      [0, 'books'],
      [1, 'till'],
    ]);
    expect(listed.ignored[0].reason).toContain('Not approved');
    await call('', 'POST', { ...pos, name: 'cafe' });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.servers.slice(0, 2)).toEqual([unapproved, hand]);
    // Adding a connector under a name a skipped entry holds is refused; changing it repairs it.
    expect((await call('', 'POST', { ...pos, name: 'till' })).status).toBe(409);
    const repaired = await call('/till', 'PUT', { ...pos, name: 'till' });
    expect(repaired.json().connectors.map((entry) => entry.name)).toEqual(['till', 'cafe']);
  });

  test('the kinds of data a connector provides are the Small Business pack’s read needs', () => {
    const needs = SMALL_BUSINESS_PACK.needs.map((need) => need.capability).filter((id) => id !== 'read-project-files');
    expect([...CONNECTOR_DATA_KINDS]).toEqual(needs);
  });
});
