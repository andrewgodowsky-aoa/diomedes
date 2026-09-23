import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  approvedMcpTool,
  displayPath,
  insideRoot,
  loadApprovedReadServers,
  readDetail,
  readScopeDigest,
  serverEnvironment,
} from '../server/engines/read-scope.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function connectors(value: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes read connectors '));
  roots.push(root);
  const file = path.join(root, 'read-connectors.json');
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
const pos = {
  name: 'pos',
  approved: true,
  transport: 'stdio',
  command: 'pos-mcp.exe',
  args: ['--read'],
  envFrom: ['POS_TOKEN'],
  readTools: ['list_orders', 'get_menu'],
};

describe('project folder boundary', () => {
  const root = path.join(os.tmpdir(), 'Harbor Street');
  it.each([
    ['menu.md', true],
    ['docs/hours.md', true],
    ['.', true],
    [path.join(root, 'menu.md'), true],
    ['../outside.md', false],
    ['docs/../../outside.md', false],
    [path.join(os.homedir(), '.ssh', 'id_rsa'), false],
    ['https://example.com/menu', false],
    ['\\\\?\\C:\\Windows\\system.ini', false],
    ['', false],
  ])('%s inside the folder: %s', (candidate, expected) => {
    expect(insideRoot(root, candidate)).toBe(expected);
  });
  it('is not fooled by a sibling folder that shares a prefix', () => {
    expect(insideRoot(root, `${root} Annex${path.sep}menu.md`)).toBe(false);
  });
  it('judges a relative path against the tool working directory', () => {
    expect(insideRoot(root, 'menu.md', path.join(root, 'docs'))).toBe(true);
    expect(insideRoot(root, '../../menu.md', path.join(root, 'docs'))).toBe(false);
  });
  it('shows paths relative to the folder', () => {
    expect(displayPath(root, path.join(root, 'docs', 'hours.md'))).toBe('docs/hours.md');
    expect(displayPath(root, root)).toBe('the project folder');
  });
});

describe('owner-approved read connectors', () => {
  it('is empty when the owner has approved none', () => {
    expect(loadApprovedReadServers(path.join(os.tmpdir(), 'no-such-read-connectors.json'))).toEqual(
      [],
    );
  });
  it('loads an explicitly approved server with its exact read tools', async () => {
    const servers = loadApprovedReadServers(await connectors({ version: 1, servers: [pos] }));
    expect(servers).toEqual([
      {
        name: 'pos',
        command: 'pos-mcp.exe',
        args: ['--read'],
        envFrom: ['POS_TOKEN'],
        readTools: ['list_orders', 'get_menu'],
      },
    ]);
    const scope = { root: 'C:\\p', web: false, mcp: servers };
    expect(approvedMcpTool(scope, 'pos', 'list_orders')).toBeDefined();
    expect(approvedMcpTool(scope, 'pos', 'refund_order')).toBeUndefined();
    expect(approvedMcpTool(scope, 'mail', 'list_orders')).toBeUndefined();
  });
  it.each([
    ['an entry without explicit approval', { ...pos, approved: false }],
    ['an entry with no approval field', { ...pos, approved: undefined }],
    ['a wildcard tool', { ...pos, readTools: ['*'] }],
    ['a glob tool', { ...pos, readTools: ['list_*'] }],
    ['no read tools at all', { ...pos, readTools: [] }],
    ['a network transport', { ...pos, transport: 'http' }],
    ['a forwarded loader variable', { ...pos, envFrom: ['NODE_OPTIONS'] }],
    ['a forwarded provider key', { ...pos, envFrom: ['OPENAI_API_KEY'] }],
    ['an unexpected field', { ...pos, writeTools: ['refund'] }],
  ])('skips %s', async (_label, entry) => {
    expect(loadApprovedReadServers(await connectors({ version: 1, servers: [entry] }))).toEqual([]);
  });
  it('keeps the first of two entries with the same name', async () => {
    const servers = loadApprovedReadServers(
      await connectors({ version: 1, servers: [pos, { ...pos, command: 'other.exe' }] }),
    );
    expect(servers.map((server) => server.command)).toEqual(['pos-mcp.exe']);
  });
  it('refuses a malformed file whole', async () => {
    const file = await connectors({ version: 2, servers: [pos] });
    expect(() => loadApprovedReadServers(file)).toThrow(/malformed/);
    const broken = await connectors('{not json');
    expect(() => loadApprovedReadServers(broken)).toThrow();
  });
  it('forwards only the named variables that are set', () => {
    const server = { name: 'pos', command: 'x', args: [], envFrom: ['POS_TOKEN', 'POS_SITE'], readTools: ['a'] };
    expect(serverEnvironment(server, { POS_TOKEN: 't', OTHER: 'no' })).toEqual({ POS_TOKEN: 't' });
  });
});

describe('scope identity and details', () => {
  it('changes with the folder, the web setting and the connector set', () => {
    const base = { root: 'C:\\a', web: true };
    expect(readScopeDigest(undefined)).toBe('text-only');
    expect(readScopeDigest(base)).toBe(readScopeDigest({ ...base }));
    expect(readScopeDigest(base)).not.toBe(readScopeDigest({ ...base, root: 'C:\\b' }));
    expect(readScopeDigest(base)).not.toBe(readScopeDigest({ ...base, web: false }));
    expect(readScopeDigest(base)).not.toBe(
      readScopeDigest({
        ...base,
        mcp: [{ name: 'pos', command: 'x', args: [], envFrom: [], readTools: ['a'] }],
      }),
    );
  });
  it('removes tokens from the technical line', () => {
    const line = readDetail({ url: 'https://x', headers: { authorization: 'Bearer abc.def' }, token: 'sk-123' });
    expect(line).not.toContain('abc.def');
    expect(line).not.toContain('sk-123');
  });
});
