/**
 * The read-only tools an Ask or Plan turn on a model-API route runs on the host:
 * the project-folder tools, the SSRF-guarded page fetch and the approved-connector
 * client. Every network here is fake (an injected resolver and transport) or an
 * in-memory MCP pair; the one real socket is a loopback server that proves the
 * page transport connects only to the address it was pinned to.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Json } from '../shared/harness';
import type { ApprovedMcpServer, ReadScope } from '../server/engines/read-scope';
import { closeReadGrant, openReadGrant } from '../server/engines/turn-scope';
import {
  checkPageUrl,
  fetchPage,
  htmlText,
  isPublicAddress,
  pinnedRequest,
  type PageAnswer,
  type PageRequest,
  type PageResolve,
} from '../server/harness/capabilities/page-fetch';
import { McpReadClients, stdioParameters } from '../server/harness/capabilities/mcp-read-client';
import {
  readScopeRecord,
  readScopeTools,
  readToolOutcome,
  readToolsNote,
  readToolSummary,
} from '../server/harness/capabilities/read-scope-tools';

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-read-tools-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'notes', 'menu.md'), '# Lunch\n\nTomato soup today.\nGrilled cheese too.\n');
  await fs.writeFile(path.join(root, 'orders.csv'), 'item,count\nsoup,12\n');
  await fs.writeFile(path.join(root, '.env'), 'POS_TOKEN=do-not-read\n');
  await fs.writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'the outside secret\n');
});
afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

/** Runs one tool as NativeAgent would: the validated input and a step signal. */
async function run(tools: ReturnType<typeof readScopeTools>, name: string, input: unknown, signal = new AbortController().signal) {
  const tool = tools.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} is not offered`);
  const parsed = tool.schema.parse(input);
  return (await tool.execute({
    input: parsed,
    idempotencyKey: 'k',
    attempt: 1,
    fence: 1,
    signal,
    publishPreview: async () => undefined,
  } as never)) as Record<string, Json>;
}

/**
 * A whole-project turn with a live host grant, sharing every ordinary file with the route.
 * (No model-API route takes a whole-project read today; the tools are checked as if one did.)
 */
const SHARED = ['notes/menu.md', 'orders.csv', 'logo.png', 'long.txt'];
const scope = (extra: Partial<ReadScope> = {}): ReadScope => ({
  root,
  web: false,
  access: 'project',
  files: [],
  shared: SHARED,
  grant: openReadGrant('project-1'),
  ...extra,
});

describe('project-folder tools', () => {
  test('list, read and search answer from inside the project; private and binary files are not shown or read', async () => {
    const tools = readScopeTools(scope(), { stop: new AbortController().signal });
    expect(tools.names).toEqual(['list_files', 'read_file', 'search_files']);

    const listed = await run(tools, 'list_files', {});
    expect(listed.entries).toEqual([
      { path: 'logo.png', type: 'file', bytes: 8 },
      { path: 'notes', type: 'folder' },
      { path: 'orders.csv', type: 'file', bytes: 19 },
    ]);
    const read = await run(tools, 'read_file', { path: './notes/menu.md' });
    expect(read).toMatchObject({ path: 'notes/menu.md', truncated: false });
    expect(read.text).toContain('Tomato soup');

    const found = await run(tools, 'search_files', { query: 'TOMATO' });
    expect(found.matches).toEqual([{ path: 'notes/menu.md', line: 3, text: 'Tomato soup today.' }]);
    expect(await run(tools, 'search_files', { query: 'do-not-read' })).toMatchObject({ matches: [] });

    expect(await run(tools, 'read_file', { path: '.env' })).toMatchObject({ refused: true });
    expect(await run(tools, 'read_file', { path: 'logo.png' })).toMatchObject({
      refused: true,
      message: 'That file is not text, so it was not read.',
    });
  });

  test('a path that climbs out, an absolute path and a linked folder are refused, and the refusal is an answer', async () => {
    const tools = readScopeTools(scope(), { stop: new AbortController().signal });
    for (const escape of ['../outside/secret.txt', 'notes/../../outside/secret.txt', path.join(outside, 'secret.txt'), 'C:\\Windows\\win.ini', '\\\\?\\C:\\x'])
      expect(await run(tools, 'read_file', { path: escape }), escape).toMatchObject({ refused: true });
    expect(await run(tools, 'list_files', { path: '..' })).toMatchObject({ refused: true });
    expect(await run(tools, 'search_files', { query: 'secret', path: '../outside' })).toMatchObject({ refused: true });

    // A junction needs no elevation on Windows; a symlink elsewhere.
    const link = path.join(root, 'linked');
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect(await run(tools, 'read_file', { path: 'linked/secret.txt' })).toMatchObject({ refused: true });
    expect(await run(tools, 'list_files', { path: 'linked' })).toMatchObject({ refused: true });
    const listed = await run(tools, 'list_files', {});
    expect((listed.entries as { path: string }[]).map((entry) => entry.path)).not.toContain('linked');
    const searched = await run(tools, 'search_files', { query: 'outside secret' });
    expect(searched.matches).toEqual([]);
  });

  test('a long file comes back in parts, and the turn allowance stops further reads', async () => {
    await fs.writeFile(path.join(root, 'long.txt'), 'x'.repeat(50_000));
    const tools = readScopeTools(scope(), { stop: new AbortController().signal });
    const first = await run(tools, 'read_file', { path: 'long.txt' });
    expect(first).toMatchObject({ truncated: true, nextOffset: 24_000, bytes: 50_000 });
    const second = await run(tools, 'read_file', { path: 'long.txt', offset: 24_000 });
    expect(second).toMatchObject({ truncated: true, nextOffset: 48_000 });
    await run(tools, 'read_file', { path: 'long.txt', offset: 48_000 });
    // 120,000 characters a message: after about 98,000, the next full part would pass it.
    await run(tools, 'read_file', { path: 'long.txt' });
    await run(tools, 'read_file', { path: 'long.txt' });
    expect(await run(tools, 'read_file', { path: 'long.txt' })).toMatchObject({ refused: true });
  });

  test('a stop aborts a read in progress', async () => {
    const stop = new AbortController();
    const tools = readScopeTools(scope(), { stop: stop.signal });
    stop.abort(new Error('stopped by the person'));
    await expect(run(tools, 'search_files', { query: 'soup' })).rejects.toThrow('stopped by the person');
  });

  test('no web or connector tool is offered unless the scope allows it', () => {
    expect(readScopeTools(scope({ web: true }), { stop: new AbortController().signal }).names).toEqual([
      'list_files',
      'read_file',
      'search_files',
      'fetch_page',
    ]);
    const pos: ApprovedMcpServer = { name: 'pos', command: 'pos-server', args: [], envFrom: [], readTools: ['list_orders'] };
    expect(readScopeTools(scope({ mcp: [pos] }), { stop: new AbortController().signal }).names).toContain('connector_read');
    expect(readScopeRecord(scope({ mcp: [pos] }))).toMatchObject({ web: false, connectors: [{ name: 'pos', readTools: ['list_orders'] }] });
    expect(JSON.stringify(readScopeRecord(scope({ mcp: [pos] })))).not.toContain(root);
    expect(JSON.stringify(readScopeRecord(scope({ mcp: [pos] })))).not.toContain('pos-server');
    const note = readToolsNote(scope({ web: true }));
    expect(note).toContain('Web search is not available');
    expect(note).not.toContain(root);
  });

  test('a selected-documents turn gets no file tools: its documents are already attached', () => {
    const selected = scope({ access: 'selected', web: true });
    expect(readScopeTools(selected, { stop: new AbortController().signal }).names).toEqual(['fetch_page']);
    expect(readScopeRecord(selected)).toMatchObject({ files: false });
    expect(readToolsNote(selected)).toContain('Only the documents chosen for this message can be read');
    expect(readToolsNote(selected)).not.toContain('list_files');
  });

  test('only files the project shares with the route are read or searched, and only under a live grant', async () => {
    await fs.writeFile(path.join(root, 'payroll.txt'), 'Tomato vendor paid 400\n');
    const tools = readScopeTools(scope(), { stop: new AbortController().signal });
    // Listing names is allowed; the unshared file's content is not.
    const listed = await run(tools, 'list_files', {});
    expect((listed.entries as { path: string }[]).map((entry) => entry.path)).toContain('payroll.txt');
    expect(await run(tools, 'read_file', { path: 'payroll.txt' })).toMatchObject({
      refused: true,
      message: 'That was not read: this project does not share that file with this route.',
    });
    const found = await run(tools, 'search_files', { query: 'tomato' });
    expect(found.matches).toEqual([{ path: 'notes/menu.md', line: 3, text: 'Tomato soup today.' }]);

    // The turn ended or the project's consent changed: its grant is gone and nothing more is read.
    const ended = scope();
    const late = readScopeTools(ended, { stop: new AbortController().signal });
    closeReadGrant(ended.grant);
    expect(await run(late, 'read_file', { path: 'orders.csv' })).toMatchObject({ refused: true });
    expect(await run(late, 'list_files', {})).toMatchObject({ refused: true });
    expect(await run(late, 'search_files', { query: 'soup' })).toMatchObject({ refused: true });
  });

  test('each call reads as one plain sentence, started and finished', () => {
    expect(readToolSummary('read_file', { path: 'notes/menu.md' })).toBe('Reading notes/menu.md');
    expect(readToolSummary('list_files', {})).toBe('Listing project files');
    expect(readToolSummary('search_files', { query: 'soup' })).toBe('Searching project files for soup');
    expect(readToolSummary('fetch_page', { url: 'https://example.com/menu' })).toBe('Opening https://example.com/menu');
    expect(readToolSummary('connector_read', { server: 'pos', tool: 'list_orders' })).toBe('Reading from pos (list_orders)');
    expect(readToolSummary('read_source', { path: 'x' })).toBeNull();
    expect(readToolOutcome('read_file', { path: 'a.md' }, { path: 'a.md', text: '' })).toEqual({ failed: false, summary: 'Read a.md' });
    expect(readToolOutcome('read_file', { path: '../a' }, { refused: true, message: 'Outside.' })).toEqual({
      failed: true,
      summary: 'Not read: Outside.',
    });
  });
});

// --- the page fetch ---------------------------------------------------------------

const answerOf = (status: number, body: string, headers: Record<string, string> = {}): PageAnswer => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body: (async function* () {
    yield Buffer.from(body);
  })(),
  cancel: () => undefined,
});

describe('the page fetch guard', () => {
  test('private, loopback, link-local, mapped and reserved addresses are never public', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      '2002:7f00:1::',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    for (const address of ['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(address), address).toBe(true);
    for (const url of ['http://localhost/', 'http://printer.local/', 'http://intranet/', 'http://127.1/', 'http://[::1]/', 'file:///C:/x', 'http://user:pw@example.com/'])
      expect(() => checkPageUrl(url), url).toThrow();
  });

  test('a host that resolves to a private address is refused before any request', async () => {
    let requested = 0;
    const request: PageRequest = async () => {
      requested += 1;
      return answerOf(200, 'never');
    };
    const resolve: PageResolve = async (host) =>
      host === 'metadata.example.com' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }];
    const signal = new AbortController().signal;
    expect(await fetchPage('http://metadata.example.com/latest', { signal, resolve, request })).toMatchObject({ ok: false });
    expect(await fetchPage('https://mixed.example.com/', { signal, resolve, request })).toMatchObject({ ok: false });
    expect(await fetchPage('http://169.254.169.254/latest/meta-data', { signal, resolve, request })).toMatchObject({ ok: false });
    expect(requested).toBe(0);
  });

  test('a redirect is checked again: one toward a private address is refused, and hops are bounded', async () => {
    const resolve: PageResolve = async (host) =>
      host === 'internal.example.com' ? [{ address: '192.168.0.10', family: 4 }] : [{ address: '93.184.215.14', family: 4 }];
    const seen: string[] = [];
    const request: PageRequest = async ({ url, addresses, headers }) => {
      seen.push(`${url} -> ${addresses.map((entry) => entry.address).join(',')}`);
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      if (url.pathname === '/to-internal') return answerOf(302, '', { location: 'http://internal.example.com/admin' });
      if (url.pathname === '/to-loopback') return answerOf(301, '', { location: 'http://127.0.0.1:8080/' });
      if (url.pathname.startsWith('/loop')) return answerOf(302, '', { location: `/loop${seen.length}` });
      return answerOf(200, '<html><head><title>Menu</title><script>alert(1)</script></head><body><h1>Soup</h1><p>Tomato &amp; basil</p></body></html>');
    };
    const signal = new AbortController().signal;
    expect(await fetchPage('https://example.com/to-internal', { signal, resolve, request })).toMatchObject({ ok: false });
    expect(await fetchPage('https://example.com/to-loopback', { signal, resolve, request })).toMatchObject({ ok: false });
    expect(seen.some((line) => line.includes('192.168') || line.includes('127.0.0.1'))).toBe(false);
    expect(await fetchPage('https://example.com/loop', { signal, resolve, request })).toMatchObject({
      ok: false,
      reason: 'The page redirected too many times.',
    });
    const page = await fetchPage('https://example.com/menu', { signal, resolve, request });
    expect(page).toMatchObject({ ok: true, status: 200, title: 'Menu', finalUrl: 'https://example.com/menu' });
    expect(page.ok && page.text).toBe('Soup\nTomato & basil');
  });

  test('a page that is not text is not read; a large page is cut at the byte cap; the time limit is a result', async () => {
    const resolve: PageResolve = async () => [{ address: '93.184.215.14', family: 4 }];
    const signal = new AbortController().signal;
    const binary: PageRequest = async () => answerOf(200, 'PK', { 'content-type': 'application/zip' });
    expect(await fetchPage('https://example.com/a.zip', { signal, resolve, request: binary })).toMatchObject({ ok: false });
    const large: PageRequest = async () => answerOf(200, 'y'.repeat(5_000), { 'content-type': 'text/plain' });
    const page = await fetchPage('https://example.com/big.txt', { signal, resolve, request: large, maxBytes: 1_000 });
    expect(page).toMatchObject({ ok: true, truncated: true });
    expect(page.ok && page.text.length).toBe(1_000);
    const slow: PageRequest = ({ signal: requestSignal }) =>
      new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
    expect(await fetchPage('https://example.com/slow', { signal, resolve, request: slow, timeoutMs: 20 })).toMatchObject({
      ok: false,
      reason: 'The page did not answer in time.',
    });
  });

  test('the person’s stop propagates instead of reading as a failed page', async () => {
    const stop = new AbortController();
    const resolve: PageResolve = async () => [{ address: '93.184.215.14', family: 4 }];
    const request: PageRequest = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(() => stop.abort(new Error('stopped by the person')), 5);
      });
    await expect(fetchPage('https://example.com/', { signal: stop.signal, resolve, request })).rejects.toThrow('stopped by the person');
  });

  test('the default transport connects only to the pinned address, never resolving the name again', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`host=${req.headers.host} method=${req.method}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      // `pinned.invalid` resolves nowhere; the connection still reaches the pinned address.
      const answer = await pinnedRequest({
        url: new URL(`http://pinned.invalid:${port}/`),
        addresses: [{ address: '127.0.0.1', family: 4 }],
        headers: {},
        signal: AbortSignal.timeout(5_000),
      });
      let text = '';
      for await (const chunk of answer.body) text += Buffer.from(chunk).toString('utf8');
      expect(text).toBe(`host=pinned.invalid:${port} method=GET`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('HTML becomes readable text', () => {
    expect(htmlText('<title>A &lt;b&gt;</title><style>x{}</style><p>One</p><p>Two&nbsp;&#x41;</p>')).toEqual({
      title: 'A <b>',
      text: 'One\nTwo A',
    });
  });
});

// --- the connector client -----------------------------------------------------------

function posServer(calls: string[]) {
  const server = new McpServer({ name: 'pos', version: '1' });
  server.registerTool('list_orders', { description: 'Recent orders', inputSchema: { limit: z.number().optional() } }, async (args) => {
    calls.push(`list_orders:${JSON.stringify(args)}`);
    return { content: [{ type: 'text', text: 'Order 1182: 12 soups' }] };
  });
  server.registerTool('void_order', { description: 'Voids an order', inputSchema: { id: z.string() } }, async () => {
    calls.push('void_order');
    return { content: [{ type: 'text', text: 'voided' }] };
  });
  return server;
}

describe('the approved-connector client', () => {
  const pos: ApprovedMcpServer = { name: 'pos', command: 'pos-server', args: ['--read'], envFrom: ['POS_TOKEN'], readTools: ['list_orders'] };

  test('only an approved read tool is called; anything else is refused before a server is started', async () => {
    const calls: string[] = [];
    let opened = 0;
    let closed = 0;
    const clients = new McpReadClients({ root, web: false, mcp: [pos] }, () => {
      opened += 1;
      const [client, server] = InMemoryTransport.createLinkedPair();
      server.onclose = () => void (closed += 1);
      void posServer(calls).connect(server);
      return client;
    });
    const signal = new AbortController().signal;
    expect(await clients.call('pos', 'void_order', { id: '1182' }, signal)).toMatchObject({ ok: false });
    expect(await clients.call('bank', 'list_orders', {}, signal)).toMatchObject({ ok: false });
    expect(opened).toBe(0);

    expect(await clients.call('pos', 'list_orders', { limit: 1 }, signal)).toEqual({
      ok: true,
      server: 'pos',
      tool: 'list_orders',
      text: 'Order 1182: 12 soups',
      truncated: false,
      isError: false,
    });
    expect(await clients.call('pos', 'void_order', { id: '1182' }, signal)).toMatchObject({ ok: false });
    expect(calls).toEqual(['list_orders:{"limit":1}']);
    expect(opened).toBe(1);
    await clients.close();
    expect(closed).toBe(1);
    expect(await clients.call('pos', 'list_orders', {}, signal)).toMatchObject({ ok: false });
  });

  test('the server process gets the minimal environment and only the variables the owner named', () => {
    const params = stdioParameters(pos, { POS_TOKEN: 'pos-secret', OPENAI_API_KEY: 'sk-never', AWS_SECRET: 'never' });
    expect(params).toMatchObject({ command: 'pos-server', args: ['--read'], stderr: 'ignore' });
    expect(params.env.POS_TOKEN).toBe('pos-secret');
    expect(params.env.OPENAI_API_KEY).toBeUndefined();
    expect(params.env.AWS_SECRET).toBeUndefined();
    const inherited = new Set(process.platform === 'win32'
      ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES']
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']);
    for (const name of Object.keys(params.env)) expect(inherited.has(name) || name === 'POS_TOKEN', name).toBe(true);
  });

  test('connector_read through the tool refuses an unapproved tool and trims the answer', async () => {
    const calls: string[] = [];
    const tools = readScopeTools(
      { root, web: false, mcp: [pos] },
      {
        stop: new AbortController().signal,
        deps: {
          mcpTransport: () => {
            const [client, server] = InMemoryTransport.createLinkedPair();
            void posServer(calls).connect(server);
            return client;
          },
        },
      },
    );
    expect(await run(tools, 'connector_read', { server: 'pos', tool: 'void_order', arguments: { id: '1' } })).toMatchObject({ refused: true });
    expect(await run(tools, 'connector_read', { server: 'pos', tool: 'list_orders' })).toMatchObject({ text: 'Order 1182: 12 soups' });
    expect(() => tools.tools.find((tool) => tool.name === 'connector_read')!.schema.parse({ server: 'bank', tool: 'x' })).toThrow();
    expect(calls).toEqual(['list_orders:{}']);
    await tools.close();
  });
});
