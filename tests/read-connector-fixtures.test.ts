/** Real HTTP, Store, model-session loop and child MCP servers; only model responses are scripted. */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { loadApprovedReadServers } from '../server/engines/read-scope';
import { testOnlySecretBox } from '../server/connection-secrets';
import { CONNECTOR_DATA_KINDS, type ReadConnectorsView } from '../shared/read-connectors';
import type { Conversation, Project } from '../shared/types';
import { responsesEvents, sseResponse } from './fixtures/model-api-streams';
import { connector, discover, fixtureDirectory, fixtures, receipts } from './fixtures/read-connector-fixtures/helpers';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
type Item = Record<string, unknown>;
type ToolCall = { server: string; tool: string; arguments?: Record<string, unknown> };
let root: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;
let plan: ToolCall[];
let seen: Item[];
let observed: Item[];
let turnNumber: number;
let modelStep: number;

// There is no network fallback. The actual provider SDK parses these fixture SSE bytes.
const modelTransport: typeof fetch = async (input, init) => {
  expect(String(input)).toMatch(/^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\//);
  const body = JSON.parse(String(init?.body)) as Item;
  seen.push(body);
  const results = ((body.input ?? []) as Item[]).filter((item) => item.type === 'function_call_output');
  const last = results.at(-1);
  if (last) observed.push(JSON.parse(String(last.output)) as Item);
  const next = plan[modelStep++];
  const output = next
    ? [{ type: 'function_call', id: `fc_${turnNumber}_${modelStep}`, call_id: `call_${turnNumber}_${modelStep}`, name: 'connector_read', arguments: JSON.stringify(next), status: 'completed' }]
    : [{ type: 'message', id: `msg_${turnNumber}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Fixture answer: ${String(last?.output ?? 'No data requested.')}`, annotations: [] }] }];
  return sseResponse(responsesEvents({
    id: `resp_${turnNumber}_${modelStep}`,
    object: 'response', created_at: 1_790_000_000, status: 'completed',
    model: AWS_LUNA_MODEL, output,
    usage: { input_tokens: 500, output_tokens: 60, total_tokens: 560 },
    incomplete_details: null, error: null,
  }), { 'x-amzn-requestid': `fixture-${turnNumber}-${modelStep}` });
};

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) as Item };
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  expect([200, 201], response.text).toContain(response.status);
  return response.data as T;
}
function send(calls: ToolCall[], mode: 'ask' | 'plan' = 'ask') {
  plan = calls;
  seen = [];
  observed = [];
  modelStep = 0;
  turnNumber += 1;
  return request(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', {
    commandId: `fixture-turn-${turnNumber}`, text: 'Read the approved business data.',
    mode, sources: [], consent: true,
  });
}
const offeredTools = () => ((seen[0].tools ?? []) as Item[]).map((tool) => tool.name).sort();
const connectorFile = () => path.join(root, 'data', 'read-connectors.json');

beforeEach(async () => {
  root = await fixtureDirectory();
  plan = [];
  seen = [];
  observed = [];
  turnNumber = 0;
  modelStep = 0;
  const engines = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  app = await createApp({
    dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    engineService: engines, reviewerAdapter: null, secretBox: testOnlySecretBox(),
    modelApiTransport: modelTransport,
  });
  // Unexpected page access fails locally too. MCP keeps its production stdio transport.
  engines.modelApi!.readTools = {
    resolve: async () => { throw new Error('No page lookup is allowed in connector fixtures.'); },
    request: async () => { throw new Error('No page request is allowed in connector fixtures.'); },
  };
  server = await new Promise<Server>((resolve) => {
    const listener = app!.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Harbor Street fixture' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['aws-bedrock'], documents: [],
    shareConversationHistory: false, shareReviewPackets: false,
  });
  await api('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012', region: 'us-east-1', model: AWS_LUNA_MODEL,
    apiKey: 'test-only-read-connector-fixture-key-never-real', expiresAt: null, consent: true,
  });
  await api('/ai/model-api/aws-bedrock/spend-limit', 'PUT', { capUsd: 1, consent: true });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'aws-bedrock' });
});

afterEach(async () => {
  const closing = server;
  server = undefined;
  try {
    await app?.locals.close();
  } finally {
    if (closing) {
      closing.closeAllConnections();
      await new Promise<void>((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
    app = undefined;
  }
});

test('fixtures cover exactly the seven declared data kinds', () => {
  expect(Object.keys(fixtures).sort()).toEqual([...CONNECTOR_DATA_KINDS].sort());
});

test.each(CONNECTOR_DATA_KINDS)('%s: approve, discover, Ask, Plan and revoke through the real host', async (kind) => {
  const log = path.join(root, 'connector.jsonl');
  const input = connector(kind, log);
  const refused = await request('/ai/read-connectors', 'POST', { ...input, consent: false });
  expect(refused.status).toBe(400);
  expect(loadApprovedReadServers(connectorFile())).toEqual([]);
  expect(await receipts(log)).toEqual([]);

  const approved = await api<ReadConnectorsView>('/ai/read-connectors', 'POST', input);
  expect(approved.connectors[0]).toMatchObject({ name: kind, readTools: [fixtures[kind].tool], provides: [kind] });
  const [loaded] = loadApprovedReadServers(connectorFile());
  const tools = await discover(loaded);
  expect(tools.tools.map((tool) => tool.name)).toEqual([fixtures[kind].tool, 'read_private_notes', 'replace_record']);

  // Discovery and readOnlyHint confer no approval. Runtime refuses the turn
  // before a connector starts, so a later valid call in that turn is not reached.
  const afterDiscovery = await receipts(log);
  for (const tool of ['replace_record', 'read_private_notes']) {
    const unapproved = await send([
      { server: kind, tool },
      { server: kind, tool: fixtures[kind].tool },
    ]);
    expect(unapproved.status, unapproved.text).toBe(409);
    expect(unapproved.data).toEqual({
      code: 'ROUTE_REFUSED', error: 'This turn was not given that connector read access.',
    });
    expect(seen).toHaveLength(1);
    expect(observed).toEqual([]);
    expect(offeredTools()).toContain('connector_read');
    expect(await receipts(log)).toEqual(afterDiscovery);
  }

  // A new, authorized Ask still reads the approved tool through production stdio.
  const answer = await send([{ server: kind, tool: fixtures[kind].tool }]);
  expect(answer.status, answer.text).toBe(200);
  expect(observed).toHaveLength(1);
  const result = observed.at(-1)!;
  expect(result).toMatchObject({ server: kind, tool: fixtures[kind].tool, isError: false, truncated: false });
  expect(JSON.parse(String(result.text))).toEqual({ kind, records: fixtures[kind].records });
  expect(answer.text).toContain(kind);
  expect(offeredTools()).toEqual(['connector_read', 'fetch_page', 'list_sources', 'read_source']);
  const afterAsk = await receipts(log);
  expect(afterAsk.filter((row) => row.event === 'tools/call').map((row) => row.params?.name)).toEqual([fixtures[kind].tool]);
  expect(afterAsk.filter((row) => row.event === 'tools/list')).toHaveLength(1);
  expect(afterAsk.filter((row) => row.event === 'start')).toHaveLength(2);
  expect(afterAsk.filter((row) => row.event === 'close')).toHaveLength(2);

  const planned = await send([{ server: kind, tool: fixtures[kind].tool }], 'plan');
  expect(planned.status, planned.text).toBe(200);
  expect(observed).toHaveLength(1);
  expect(observed.at(-1)).toMatchObject({ server: kind, tool: fixtures[kind].tool, isError: false, truncated: false });
  expect(JSON.parse(String(observed.at(-1)!.text))).toEqual({ kind, records: fixtures[kind].records });

  const removed = await api<ReadConnectorsView>(`/ai/read-connectors/${kind}`, 'DELETE');
  expect(removed.connectors).toEqual([]);
  expect(loadApprovedReadServers(connectorFile())).toEqual([]);
  const beforeRevokedRead = await receipts(log);
  expect(beforeRevokedRead.filter((row) => row.event === 'tools/call').map((row) => row.params?.name))
    .toEqual([fixtures[kind].tool, fixtures[kind].tool]);
  expect(beforeRevokedRead.filter((row) => row.event === 'close')).toHaveLength(3);
  // Reuse the same conversation. A model still trying the old tool must be refused.
  const revoked = await send([{ server: kind, tool: fixtures[kind].tool }]);
  // The model API rejects an unoffered tool before the harness can dispatch it.
  expect(revoked.status, revoked.text).toBe(409);
  expect(revoked.data.code).toBe('PROVIDER_ERROR');
  expect(revoked.data.error).toBe('The model named a tool call this turn did not offer, or its arguments were malformed. It was not run.');
  expect(offeredTools()).not.toContain('connector_read');
  expect(await receipts(log)).toEqual(beforeRevokedRead);
});
