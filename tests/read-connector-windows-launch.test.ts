/** Pin the real MCP SDK's Windows launch behavior; no provider or package runner is invoked. */
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpReadClients } from '../server/harness/capabilities/mcp-read-client';
import { closeReadGrant, openReadGrant } from '../server/engines/turn-scope';
import type { ApprovedMcpServer, ReadScope } from '../server/engines/read-scope';
import { connector, discover, fixtureDirectory, fixtureServer, fixtures, receipts } from './fixtures/read-connector-fixtures/helpers';

let root: string | undefined;
const grants: string[] = [];
function readClients(approved: ApprovedMcpServer) {
  const scope: ReadScope = { root: root!, projectId: 'connector-launch-fixture', web: false, mcp: [approved] };
  const grant = openReadGrant(scope.projectId!, undefined, { scope });
  grants.push(grant);
  return new McpReadClients({ ...scope, grant });
}
afterEach(async () => {
  grants.splice(0).forEach(closeReadGrant);
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

test.runIf(process.platform === 'win32').each([
  ['node_modules/.bin', 'absolute path'],
  ['node_modules/.bin', 'PATH lookup'],
  ['ordinary directory', 'absolute path'],
  ['ordinary directory', 'PATH lookup'],
] as const)(
  'Windows %s .cmd launcher works through %s and preserves literal arguments',
  async (layout, lookup) => {
    root = await fixtureDirectory();
    // Exercise both cross-spawn escape branches with identical owned shim bytes.
    const bin = layout === 'node_modules/.bin'
      ? path.join(root, 'fixture package', 'node_modules', '.bin')
      : path.join(root, 'ordinary launchers');
    await fs.mkdir(bin, { recursive: true });
    const launcher = path.join(bin, 'read-fixture.cmd');
    await fs.writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixtureServer}" %*\r\n`);
    const log = path.join(root, 'launch receipt.jsonl');
    const marker = path.join(root, 'unexpected-shell-output.txt');
    const probe = `literal & echo UNEXPECTED > "${marker}" & rem | < > ^ ( )`;
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const approved = {
      ...connector('read-sales', log),
      command: lookup === 'absolute path' ? launcher : 'read-fixture',
      args: ['read-sales', log, probe],
    };
    const listed = await discover(approved);
    expect(listed.tools.map((tool) => tool.name)).toContain(fixtures['read-sales'].tool);
    const clients = readClients(approved);
    try {
      const result = await clients.call(approved.name, fixtures['read-sales'].tool, {}, AbortSignal.timeout(5_000));
      expect(result).toMatchObject({ ok: true, isError: false });
      if (!result.ok) throw new Error(result.reason);
      expect(JSON.parse(result.text)).toEqual({ kind: 'read-sales', records: fixtures['read-sales'].records });
    } finally {
      await clients.close();
    }
    const logRows = await receipts(log);
    expect(logRows.filter((row) => row.event === 'start').map((row) => row.probe)).toEqual([probe, probe]);
    expect(logRows.filter((row) => row.event === 'close')).toHaveLength(2);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

test('a direct Node command is a working shell-free connector configuration', async () => {
  root = await fixtureDirectory();
  const log = path.join(root, 'node-receipt.jsonl');
  const approved = connector('read-inventory', log);
  const clients = readClients(approved);
  try {
    const result = await clients.call(approved.name, fixtures['read-inventory'].tool, {}, AbortSignal.timeout(5_000));
    expect(result).toMatchObject({ ok: true, isError: false });
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.parse(result.text)).toEqual({ kind: 'read-inventory', records: fixtures['read-inventory'].records });
  } finally {
    await clients.close();
  }
  expect((await receipts(log)).filter((row) => row.event === 'close')).toHaveLength(1);
});
