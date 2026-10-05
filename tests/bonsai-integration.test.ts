import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { EngineService } from '../server/engines/service.js';
import { BonsaiError, BonsaiRuntime, type BonsaiHost } from '../server/bonsai/runtime.js';
import { localModelIntegrations } from '../server/bonsai/routes.js';
import { BONSAI_MODEL, type BonsaiStatus, type LocalModelsView, type ModelImage } from '../shared/bonsai.js';
import type { Conversation, IntegrationStatus, Project } from '../shared/types.js';
import { conversationSources } from '../client/console/thread-send.js';
import { turnRunId } from '../server/harness/model-session-run.js';
import type { RunService } from '../server/harness/run-service.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVnQAAAAASUVORK5CYII=', 'base64');
const headers = { 'content-type': 'application/json', 'X-Diomedes-Client': '1' };
const realFetch = globalThis.fetch;
let root: string, base: string, app: Awaited<ReturnType<typeof createApp>>, server: Server;
let project: Project, thread: Conversation, host: BonsaiHost;
type ChatBody = { model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[]; reasoning_effort: string };
let calls: ChatBody[], mode: 'answer' | 'tool' | 'hang' | 'proposal', dispatched: boolean;
const store = () => app.locals.store as Store;
async function request(route: string, method = 'GET', body?: unknown) {
  return realFetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await request(route, method, body), text = await res.text();
  expect(res.ok, `${route}: ${res.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const threadPath = () => `/projects/${project.id}/threads/${thread.id}`;
const select = (model = 'bonsai-gaming', effort = 'xhigh') => api<Conversation>(threadPath(), 'PUT', {
  engine: 'bonsai', requested: { model, effort, agent: 'auto' },
});
const body = (text = 'Hello', sources: { path: string; sha: string }[] = []) => ({
  commandId: randomUUID(), text, sources, mode: 'ask', consent: true,
});
const transport: typeof fetch = async (url, init) => {
  expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:18082\//);
  if (String(url).endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
  if (String(url).endsWith('/tokenize')) return Response.json({ tokens: [1, 2, 3] });
  expect(String(url)).toBe('http://127.0.0.1:18082/v1/chat/completions');
  const sent: ChatBody = JSON.parse(String(init?.body)); calls.push(sent); dispatched = true;
  if (mode === 'hang') return new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const toolResult = sent.messages.find(m => m.role === 'tool');
  const toolCall = mode === 'tool' && !toolResult;
  return Response.json({ id: `local-${calls.length}`, model: BONSAI_MODEL,
    choices: [{ finish_reason: toolCall ? 'tool_calls' : 'stop', message: toolCall
      ? { content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_source', arguments: '{"path":"note.md"}' } }] }
      : { content: mode === 'proposal' ? JSON.stringify({ summary: 'Write the agreed checklist',
          changes: [{ path: 'checklist.md', text: '# Checklist\n\n- Verify the result\n', summary: 'Add the checklist.' }] })
        : toolResult ? `Read result: ${String(toolResult.content)}` : 'Bonsai answered locally.' } }],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } });
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nectovia-bonsai-'));
  calls = []; mode = 'answer'; dispatched = false;
  host = {
    inspect: vi.fn(async (): Promise<BonsaiStatus> => ({ state: 'unloaded', installed: true, owned: false, mode: null, detail: 'Choose a profile.' })),
    acquire: vi.fn(async profile => ({ status: { state: 'ready' as const, installed: true, mode: profile.mode, owned: true, detail: 'Ready.' }, release: async () => {} })),
  };
  app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null, modelApiTransport: transport, bonsai: { host, configured: true }, automationTickMs: null });
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', ((url: RequestInfo | URL, init?: RequestInit) => String(url).startsWith('/api/')
    ? realFetch(`${base}${String(url)}`, init) : realFetch(url, init)) as typeof fetch);
  project = await api<Project>('/projects', 'POST', { name: 'Bonsai fixture' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const folder = store().state(project.id).project.folder;
  await fs.writeFile(path.join(folder, 'picture.png'), png);
  await fs.writeFile(path.join(folder, 'note.md'), 'Only the selected note.');
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', { expectedVersion: 0, routes: ['bonsai'],
    documents: ['picture.png', 'note.md'], shareConversationHistory: true, shareReviewPackets: false });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (app) await app.locals.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('Bonsai through the native Nectovia host', () => {
  it('offers installed profiles without starting one, wakes the exact selection, and persists separate fields', async () => {
    const catalog = await api<{ models: { slug: string }[] }>('/engines/bonsai/models');
    expect(catalog.models.map(p => p.slug)).toEqual(['bonsai-gaming', 'bonsai-full']);
    expect((await api<LocalModelsView>('/ai/local-models')).status.state).toBe('unloaded');
    expect(host.acquire).not.toHaveBeenCalled();
    expect(await select('bonsai-full')).toMatchObject({ engine: 'bonsai', requested: { model: 'bonsai-full', effort: 'xhigh', agent: 'auto' } });
    expect(await api('/ai/local-models/wake', 'POST', { model: 'bonsai-full' })).toMatchObject({ state: 'ready', mode: 'Full' });
    const reopened = new Store(path.join(root, 'data'), path.join(root, 'projects')); await reopened.init();
    expect(reopened.state(project.id).conversations.find(t => t.id === thread.id)?.requested).toMatchObject({ model: 'bonsai-full', effort: 'xhigh', agent: 'auto' });
    expect(calls).toEqual([]);
  });
  it.each(['bonsai-gaming', 'bonsai-full'])('runs %s with its native context, usage and bounded deadline', async model => {
    await select(model);
    expect(await api(`${threadPath()}/work-style`)).toMatchObject({ route: 'bonsai', refusal: null });
    const command = body();
    const answer = await api<{ runId: string }>(`${threadPath()}/messages`, 'POST', command);
    expect(answer).toMatchObject({ answerText: 'Bonsai answered locally.', interrupted: false });
    expect(calls[0]).toMatchObject({ model: BONSAI_MODEL, reasoning_effort: 'xhigh' });
    const turns = store().state(project.id).conversations.find(t => t.id === thread.id)!.turns;
    expect(turns.at(-1)).toMatchObject({ route: 'bonsai', context: { window: { tokens: model === 'bonsai-full' ? 131072 : 16384 },
      provider: { reportedCalls: 1, inputTokens: 30, outputTokens: 10 } } });
    const child = await (app.locals.harness.runs as RunService).get(turnRunId(answer.runId, command.commandId));
    expect(child.budget).toMatchObject({ wallMs: model === 'bonsai-full' ? 1_800_000 : 480_000, modelCalls: 8, toolCalls: 16 });
  });
  it('delivers actual Full image bytes from the client source path and saves their exact version', async () => {
    await select('bonsai-full');
    const sources = await conversationSources(project.id, ['picture.png']);
    const image = await api<ModelImage>(`/projects/${project.id}/image-source?path=picture.png`);
    expect(sources).toEqual([{ path: 'picture.png', sha: image.sha }]);
    await api(`${threadPath()}/messages`, 'POST', body('Describe the image.', sources));
    expect(JSON.stringify(calls[0])).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect((await store().objectBytes(project.id, image.sha))?.equals(png)).toBe(true);
    const turn = store().state(project.id).conversations.find(t => t.id === thread.id)!.turns.at(-1)!;
    expect(turn.context?.window.tokens).toBe(131072);
    const transcriptDir = path.join(root, 'data', 'model-transcripts-bonsai');
    const files = await fs.readdir(transcriptDir, { recursive: true });
    for (const file of files.filter(p => p.endsWith('.json'))) expect(await fs.readFile(path.join(transcriptDir, file), 'utf8')).not.toContain(png.toString('base64'));
  });
  it('rejects Gaming images and changed source bytes before waking or dispatching', async () => {
    await select(); const sources = await conversationSources(project.id, ['picture.png']);
    const gaming = await request(`${threadPath()}/messages`, 'POST', body('Describe.', sources));
    expect(gaming.status).toBe(415);
    await select('bonsai-full');
    await fs.writeFile(path.join(store().state(project.id).project.folder, 'picture.png'), Buffer.concat([png, Buffer.from('changed')]));
    expect((await request(`${threadPath()}/messages`, 'POST', body('Describe.', sources))).status).toBe(409);
    expect(host.acquire).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
  it('executes read tools under native source scope before asking the model again', async () => {
    await select(); mode = 'tool';
    const sources = await conversationSources(project.id, ['note.md']);
    const answer = await api<{ answerText: string }>(`${threadPath()}/messages`, 'POST', body('Read the note.', sources));
    expect(answer.answerText).toContain('Only the selected note.');
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.some(t => t.function.name === 'read_source')).toBe(true);
    expect(calls[1].messages.find(m => m.role === 'tool')?.content).toContain('Only the selected note.');
  });
  it('reports memory failure on wake and sends nothing to any provider', async () => {
    vi.mocked(host.acquire).mockRejectedValueOnce(new BonsaiError('insufficient-memory', 'Needs 12288 MiB of free VRAM.'));
    const response = await request('/ai/local-models/wake', 'POST', { model: 'bonsai-full' });
    expect(response.status).toBe(409); expect(await response.text()).toContain('12288');
    expect((await api<LocalModelsView>('/ai/local-models')).status.state).toBe('insufficient-memory');
    expect(calls).toEqual([]);
  });
  it('reports the installed model as a local integration with its loaded profile, starting nothing to say so', async () => {
    const local = async (route = '/integrations') =>
      (await api<{ integrations: IntegrationStatus[] }>(route)).integrations.filter(item => item.id === 'bonsai');
    expect(await local()).toEqual([expect.objectContaining({ id: 'bonsai', kind: 'local', adapter: 'ready',
      found: true, available: false, loaded: null, status: 'Not running' })]);
    expect(await local('/integrations/local')).toEqual(await local());
    vi.mocked(host.inspect).mockResolvedValue({ state: 'ready', installed: true, mode: 'Full', owned: true, detail: 'Bonsai Full is ready.' });
    expect(await local('/integrations/local')).toEqual([expect.objectContaining({ found: true, available: true,
      loaded: 'bonsai-full', status: 'Running', detail: 'Bonsai Full is ready.' })]);
    vi.mocked(host.inspect).mockResolvedValue({ state: 'missing', installed: false, mode: null, owned: false, detail: 'Not installed.' });
    expect(await local('/integrations/local')).toEqual([]);
    expect(await local()).toEqual([]);
    expect(host.acquire).not.toHaveBeenCalled();
    // A host with no installation is never asked at all.
    const absent = { inspect: vi.fn(), acquire: vi.fn() } as unknown as BonsaiHost;
    expect(await localModelIntegrations(new BonsaiRuntime(absent), false)).toEqual([]);
    expect(absent.inspect).not.toHaveBeenCalled();
  });
  it('never starts the model for a send: a stopped profile is refused, stays chosen, and nothing is sent anywhere', async () => {
    await select('bonsai-gaming');
    let running: string | null = null;
    vi.mocked(host.acquire).mockImplementation(async (profile, options) => {
      if (running !== profile.mode && !options?.start) throw new BonsaiError('unloaded', "The local model isn't running. Start it first.");
      running = profile.mode;
      return { status: { state: 'ready' as const, installed: true, mode: profile.mode, owned: true, detail: 'Ready.' }, release: async () => {} };
    });
    const refused = await request(`${threadPath()}/messages`, 'POST', body());
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("isn't running");
    expect(calls).toEqual([]);
    expect(vi.mocked(host.acquire).mock.calls.map(call => call[1])).toEqual([{ start: false }]);
    // Withdrawn, not replaced: the thread keeps its local profile and no tier or cloud route took over.
    expect(store().state(project.id).conversations.find(t => t.id === thread.id))
      .toMatchObject({ engine: 'bonsai', requested: { model: 'bonsai-gaming' } });
    // Only the person's Start may start it, and the next send then runs on it.
    await api('/ai/local-models/wake', 'POST', { model: 'bonsai-gaming' });
    expect(await api(`${threadPath()}/messages`, 'POST', body('Again.'))).toMatchObject({ answerText: 'Bonsai answered locally.' });
    expect(vi.mocked(host.acquire).mock.calls.map(call => call[1])).toEqual([{ start: false }, { start: true }, { start: false }]);
    expect(calls).toHaveLength(1);
  });
  it('will not substitute a cloud tier for a local route with no profile', async () => {
    await api(threadPath(), 'PUT', { engine: 'bonsai', requested: null, workStyle: 'thorough' });
    const response = await request(`${threadPath()}/messages`, 'POST', body());
    expect(response.status).toBe(409); expect(calls).toEqual([]); expect(host.acquire).not.toHaveBeenCalled();
  });
  it('stops an in-flight local request through the existing command interrupt', async () => {
    await select(); mode = 'hang'; const command = body('Wait.');
    const pending = request(`${threadPath()}/messages`, 'POST', command);
    await vi.waitFor(() => expect(dispatched).toBe(true), { timeout: 15000 });
    await api(`${threadPath()}/messages/${command.commandId}/interrupt`, 'POST', {});
    const response = await pending;
    expect(response.ok).toBe(true); expect(await response.json()).toMatchObject({ interrupted: true });
    expect(calls).toHaveLength(1);
  });
  it('Build proposes a recorded change and waits for the existing exact approval', async () => {
    await select('bonsai-full'); mode = 'proposal';
    const response = await request(`/projects/${project.id}/ask`, 'POST', { threadId: thread.id,
      route: 'bonsai', mode: 'build', text: 'Write a checklist.', consent: true, sources: [] });
    expect(response.status, await response.clone().text()).toBe(200);
    await vi.waitFor(() => expect(store().state(project.id).needs.some(need => need.state === 'open')).toBe(true), { timeout: 15000 });
    const need = store().state(project.id).needs.find(need => need.state === 'open')!;
    expect(need.files).toEqual(['checklist.md']); expect(calls).toHaveLength(1);
    await expect(fs.stat(path.join(store().state(project.id).project.folder, 'checklist.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', { protocolVersion: 1,
      commandId: randomUUID(), resolution: 'go-ahead', allowForTask: false,
      proposalDigest: need.approval!.proposalDigest, actionDigest: need.approval!.actionDigest, baseDigest: need.approval!.baseDigest });
    await vi.waitFor(async () => expect(await fs.readFile(path.join(store().state(project.id).project.folder, 'checklist.md'), 'utf8')).toContain('Verify the result'));
    expect(calls).toHaveLength(1);
  });
});
