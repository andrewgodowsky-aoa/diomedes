/**
 * H13 end to end on the second route: a Diomedes loop on Google Vertex AI
 * through the real host — setup over HTTP, the loop's own admission route, the
 * engine service's model-API admission and adapter, the real SDK request, the
 * existing Need and recorded writer, and H17's finish gate. Only Google's
 * network (below the AI SDK) and Google's token exchange are replaced, so
 * nothing reaches Google, nothing is spent and no real credential exists.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { VertexConnections } from '../server/engines/google-vertex';
import { testOnlySecretBox } from '../server/connection-secrets';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import type { Store } from '../server/store';
import type { HarnessHost } from '../server/harness/host';
import type { ApprovalCommand, Need, Project, Session } from '../shared/types';
import type { VertexConnectionView } from '../shared/model-api';
import type { LoopOutcome, LoopView } from '../shared/native-loop';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const TOKEN = 'ya29.test-only-vertex-token-never-real';
const PROJECT = 'nectovia-founder-proof';
const STREAM_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`;
const MENU = '# Lunch\n\nTomato soup and a grilled cheese sandwich.\n';
const SECRET = 'Payroll: the chef earns a private amount.';

type Item = Record<string, unknown>;
let seen: { url: string; body: Item }[];
let mints = 0;
const frames = (parts: Item[]): Item[] => [
  { candidates: [{ content: { role: 'model', parts }, index: 0 }], modelVersion: 'gemini-3.8-flash-001', responseId: `vtx-${seen.length}` },
  {
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 640 },
    modelVersion: 'gemini-3.8-flash-001',
    responseId: `vtx-${seen.length}`,
  },
];
const declared = (body: Item) =>
  ((body.tools as { functionDeclarations?: { name: string }[] }[] | undefined) ?? [])
    .flatMap((tool) => tool.functionDeclarations ?? [])
    .map((tool) => tool.name)
    .sort();
/** Plan, then try a file the project does not share, then read the menu, propose the report, finish. */
const script = (body: Item): Item[] => {
  if (!declared(body).length) return frames([{ text: '1. Read the menu.\n2. Write the report.\n3. Summarise.' }]);
  const answered = (JSON.stringify(body.contents).match(/functionResponse/g) ?? []).length;
  if (answered === 0) return frames([{ functionCall: { name: 'read_project_file', args: { path: 'secret.md' } }, thoughtSignature: 'sig-1' }]);
  if (answered === 1) return frames([{ functionCall: { name: 'read_project_file', args: { path: 'menu.md' } }, thoughtSignature: 'sig-2' }]);
  if (answered === 2)
    return frames([{ functionCall: { name: 'propose_write', args: { text: '# Lunch report\n\nTomato soup today.\n' } }, thoughtSignature: 'sig-3' }]);
  return frames([{ text: 'Proposed Harness report.md from menu.md. secret.md was not shared, so it was not read.' }]);
};
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as Item;
  seen.push({ url, body });
  if (!url.startsWith('https://aiplatform.googleapis.com/')) throw new Error(`Unexpected provider: ${url}`);
  return new Response(script(body).map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': `goog-${seen.length}` },
  });
}) as typeof globalThis.fetch;

let root: string;
let adcFile: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let taskId: string;
const store = () => app.locals.store as Store;
const host = () => app.locals.harness as HarnessHost;
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-loop-vertex-'));
  adcFile = path.join(root, 'adc.json');
  await fs.writeFile(
    adcFile,
    JSON.stringify({ type: 'authorized_user', client_id: 'founder-client', client_secret: 'cs-never-read', refresh_token: 'rt-never-read', quota_project_id: PROJECT }),
  );
  seen = [];
  mints = 0;
  service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  const dataDir = path.join(root, 'data');
  app = await createApp({
    dataDir,
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: network,
  });
  service.modelApi!.vertex = {
    connections: new VertexConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-google-vertex'), 'google-vertex'),
    env: { GOOGLE_APPLICATION_CREDENTIALS: adcFile },
    mint: async () => {
      mints += 1;
      return { token: TOKEN, expiresAt: null };
    },
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  };
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project = await api<Project>('/projects', 'POST', { name: 'Lunch service' });
  await fs.writeFile(path.join(project.folder, 'menu.md'), MENU);
  await fs.writeFile(path.join(project.folder, 'secret.md'), SECRET);
  // The project shares the menu with Google and nothing else.
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['google-vertex'],
    documents: ['menu.md'],
    shareConversationHistory: false,
    shareReviewPackets: false,
  });
  taskId = await store().locked(async () => {
    const task = store().createTask(store().state(project.id), { name: 'Write the lunch report' });
    await store().persist(store().state(project.id));
    return task.id;
  });
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

describe('a Diomedes loop on Google Vertex AI through the real host', () => {
  test('plan, a refused unshared read, a read, an approved write and a Verified finish, attributed to Gemini under Diomedes', async () => {
    const view = await api<VertexConnectionView>('/ai/model-api/google-vertex', 'PUT', {
      projectId: PROJECT,
      location: 'global',
      model: 'gemini-3.8-flash',
      consent: true,
    });
    await api('/ai/model-api/google-vertex/spend-limit', 'PUT', { capUsd: 1, consent: true });
    await api(`/projects/${project.id}/tasks/${taskId}/acceptance`, 'PUT', {
      checks: [{ id: 'soup', kind: 'text-contains', path: 'Harness report.md', text: 'Tomato soup' }],
    });
    const started = await api<{ runId: string; session: Session }>(`/projects/${project.id}/loop/start`, 'POST', {
      protocolVersion: 1,
      commandId: 'vertex-loop-1',
      taskId,
      goal: 'Write a short lunch report from the menu.',
      route: 'google-vertex',
      consent: true,
      sources: ['menu.md'],
    });
    expect(started.session.route).toBe('google-vertex');
    await vi.waitFor(
      () => expect(store().state(project.id).needs.some((need) => need.sessionId === started.session.id && need.state === 'open')).toBe(true),
      { timeout: 15_000 },
    );
    const need = store().state(project.id).needs.find((item) => item.sessionId === started.session.id && item.state === 'open') as Need;
    const decision: ApprovalCommand = {
      protocolVersion: 1,
      commandId: `decision-${need.id}`,
      resolution: 'go-ahead',
      proposalDigest: need.approval!.proposalDigest,
      actionDigest: need.approval!.actionDigest,
      baseDigest: need.approval!.baseDigest,
    };
    await api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', decision);
    await vi.waitFor(async () => expect((await host().get(project.id, started.runId)).state).toBe('completed'), { timeout: 15_000 });
    await vi.waitFor(
      async () =>
        expect((await api<{ outcome: LoopOutcome }>(`/projects/${project.id}/loop/runs/${started.runId}`)).outcome.state).toBe('verified'),
      { timeout: 15_000 },
    );
    const read = await api<{ view: LoopView; outcome: LoopOutcome }>(`/projects/${project.id}/loop/runs/${started.runId}`);

    // Five calls, all to the project's global endpoint; the plan call offered no tools.
    expect(seen.map((request) => request.url)).toEqual(Array(5).fill(STREAM_URL));
    expect(declared(seen[0].body)).toEqual([]);
    expect(declared(seen[1].body)).toEqual(['list_project_files', 'propose_write', 'read_project_file']);
    // The unshared file never left the computer; the refusal is what Gemini was told.
    expect(JSON.stringify(seen.map((request) => request.body))).not.toContain('Payroll');
    expect(JSON.stringify(seen[2].body.contents)).toContain('not shared with google-vertex');
    expect(read.view.turns.map((turn) => turn.decision)).toEqual(['tool', 'tool', 'tool', 'finish']);
    expect(read.view.turns[0].observation?.excerpt).toContain('not shared');
    expect(read.view.turns[1].observation?.excerpt).toContain('Tomato soup');
    // Attribution: Gemini as Google reported it, Diomedes as the supervising actor of the loop.
    expect(read.view.models).toEqual([{ engine: 'google-vertex', reported: 'gemini-3.8-flash-001', calls: 5 }]);
    const session = store().state(project.id).sessions.find((item) => item.id === started.session.id)!;
    expect(session.origin).toMatchObject({ mode: 'supervisor', engine: { id: 'google-vertex' }, model: { reported: 'gemini-3.8-flash-001' } });
    // Verified: the finish gate ran the person's check on the bytes the run wrote.
    expect(read.outcome).toMatchObject({ state: 'verified', label: 'Verified' });
    expect(store().state(project.id).tasks.find((task) => task.id === taskId)!.state).toBe('done');
    const report = await fs.readFile(path.join(project.folder, 'Harness report.md'), 'utf8');
    expect(report).toContain('Tomato soup');
    // Spend: each paid call held and settled on the Vertex ledger. A token is minted when the loop
    // is driven, once before the approval and once after it resumed, never ahead of admission.
    const holds = service.modelApi!.exposure.list('google-vertex-1');
    expect(holds.map((hold) => hold.state)).toEqual(Array(5).fill('settled'));
    expect(mints).toBe(2);
    expect(view.connection!.accountRoute).toBeTruthy();
  });
});
