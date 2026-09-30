import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { stdioTransport } from '../../../server/harness/capabilities/mcp-read-client';
import type { ApprovedMcpServer } from '../../../server/engines/read-scope';
import type { ConnectorDataKind, ReadConnectorInput } from '../../../shared/read-connectors';
import data from './data.json';

export const fixtures = data satisfies Record<ConnectorDataKind, {
  tool: string;
  description: string;
  records: unknown[];
}>;
export const fixtureServer = fileURLToPath(new URL('./server.mjs', import.meta.url));

export async function fixtureDirectory() {
  const parent = path.join(os.tmpdir(), 'astra-read-connector-fixtures');
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, 'case-'));
}

export function connector(kind: ConnectorDataKind, log: string): ReadConnectorInput {
  return {
    name: kind,
    command: process.execPath,
    args: [fixtureServer, kind, log],
    envFrom: [],
    readTools: [fixtures[kind].tool],
    provides: [kind],
    consent: true,
  };
}

export interface Receipt {
  pid: number;
  kind: ConnectorDataKind;
  event: string;
  probe?: string | null;
  params?: { name?: string; arguments?: Record<string, unknown> } | null;
}

export async function receipts(log: string): Promise<Receipt[]> {
  let text: string;
  try {
    text = await fs.readFile(log, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Receipt);
}

/** Discovery uses the same production stdio transport as a host read, with a real child. */
export async function discover(server: ApprovedMcpServer) {
  const client = new Client({ name: 'read-connector-fixture-discovery', version: '1' });
  try {
    await client.connect(stdioTransport(server), { timeout: 5_000 });
    return await client.listTools({}, { timeout: 5_000 });
  } finally {
    await client.close();
  }
}
