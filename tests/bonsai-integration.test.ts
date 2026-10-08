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
import { baselineRedact } from '../server/secrets.js';
import { LocalModelError, LocalModelRuntime, type LocalModelHost } from '../server/bonsai/runtime.js';
import { localModelIntegrations } from '../server/bonsai/routes.js';
import type { LocalModelStatus, LocalModelsView } from '../shared/local-model.js';
import type { ModelImage } from '../shared/model-images.js';
import type { Conversation, IntegrationStatus, Project } from '../shared/types.js';
import { conversationSources } from '../client/console/thread-send.js';
import { turnRunId } from '../server/harness/model-session-run.js';
import type { RunService } from '../server/harness/run-service.js';
import { BONSAI_MODEL, FixedLocalModel, localAnswerStream, meadowDescriptor, MEADOW_FOLDER } from './fixtures/local-model.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVnQAAAAASUVORK5CYII=', 'base64');
const headers = { 'content-type': 'application/json', 'X-Diomedes-Client': '1' };
const realFetch = globalThis.fetch;
let root: string, base: string, app: Awaited<ReturnType<typeof createApp>>, server: Server;
let project: Project, thread: Conversation, host: LocalModelHost;
type ChatBody = { model: string; messages: { role: string; content: unknown; tool_call_id?: string }[]; tools: { function: { name: string } }[]; reasoning_effort: string };
let calls: ChatBody[], mode: 'answer' | 'tool' | 'hang' | 'proposal', dispatched: boolean;
let source: FixedLocalModel, longPrompt: boolean, toolPreface: string | null, progressAfterTool: boolean, toolPath: string;
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
/** Reads /api/events the way the Console does, so a frame the stream never forwards fails the test. */
async function openEvents() {
  const controller = new AbortController();
  const response = await realFetch(`${base}/api/events`, { signal: controller.signal,
    headers: { Accept: 'text/event-stream', 'X-Diomedes-Client': '1' } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const next = async (name: string, timeoutMs = 5_000): Promise<unknown> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let boundary = buffer.indexOf('\n\n'); boundary >= 0; boundary = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.match(/^event: (.+)$/m)?.[1].trim() === name) return JSON.parse(block.match(/^data: (.+)$/m)![1]);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No ${name} event arrived on /api/events.`)), Math.max(1, deadline - Date.now()));
      })]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new Error(`The event stream ended before ${name} arrived.`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, close: async () => { controller.abort(); await reader.cancel().catch(() => undefined); } };
}
const select = (model = 'local:gaming', effort = 'xhigh') => api<Conversation>(threadPath(), 'PUT', {
  engine: 'bonsai', requested: { model, effort, agent: 'auto' },
});
/** A thread saved before profiles came from the description, with the slug it was saved under. */
const savedEarlier = (model: string) => store().locked(async () => {
  const state = store().state(project.id);
  const saved = state.conversations.find(t => t.id === thread.id)!;
  saved.engine = 'bonsai';
  saved.requested = { model, effort: 'xhigh', agent: 'auto' };
  await store().persist(state);
});
const body = (text = 'Hello', sources: { path: string; sha: string }[] = []) => ({
  commandId: randomUUID(), text, sources, mode: 'ask', consent: true,
});
// The copied descriptor names this server. The transport answers it; nothing reaches it.
const transport: typeof fetch = async (url, init) => {
  expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:18082\//);
  if (String(url).endsWith('/apply-template')) return Response.json({ prompt: 'Fixture template' });
  if (String(url).endsWith('/tokenize')) return Response.json({ tokens: longPrompt ? Array(115_164).fill(7) : [1, 2, 3] });
  expect(String(url)).toBe('http://127.0.0.1:18082/v1/chat/completions');
  const sent: ChatBody = JSON.parse(String(init?.body)); calls.push(sent); dispatched = true;
  if (mode === 'hang') return new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // The host reads the attached files before the message; the model's own read is answered as read-1.
  const ownRead = sent.messages.find(m => m.role === 'tool' && m.tool_call_id === 'read-1');
  const toolResult = ownRead ?? sent.messages.find(m => m.role === 'tool');
  const toolCall = mode === 'tool' && !ownRead;
  // The long prefill is the call that carries the ledger: Work inlines it, a conversation's host reads it before the message.
  const carriesLedger = longPrompt && String(init?.body).includes('ledger ledger ledger');
  return localAnswerStream({ id: `local-${calls.length}`, model: sent.model,
    choices: [{ finish_reason: toolCall ? 'tool_calls' : 'stop', message: toolCall
      ? { content: toolPreface, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_source', arguments: JSON.stringify({ path: toolPath }) } }] }
      : { content: mode === 'proposal' ? JSON.stringify({ summary: 'Write the agreed checklist',
          changes: [{ path: 'checklist.md', text: '# Checklist\n\n- Verify the result\n', summary: 'Add the checklist.' }] })
        : toolResult ? `Read result: ${String(toolResult.content).slice(0, 400)}` : 'The local model answered.' } }],
    usage: { prompt_tokens: longPrompt ? 115_164 : 30, completion_tokens: 10, total_tokens: longPrompt ? 115_174 : 40 } },
    carriesLedger ? { total: 115_164, cache: 0, processed: 512, time_ms: 500 }
      : progressAfterTool && ownRead ? { total: 4_096, cache: 2_048, processed: 3_072, time_ms: 250 } : undefined);
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-route-app-'));
  calls = []; mode = 'answer'; dispatched = false;
  source = new FixedLocalModel(); longPrompt = false; toolPreface = null; progressAfterTool = false; toolPath = 'note.md';
  host = {
    inspect: vi.fn(async (): Promise<LocalModelStatus> => ({ state: 'unloaded', installed: true, owned: false, mode: null, detail: 'Choose a profile.' })),
    acquire: vi.fn(async profile => ({ status: { state: 'ready' as const, installed: true, mode: profile.mode, owned: true, detail: 'Ready.' }, release: async () => {} })),
  };
  // The desktop's own redaction (app.ts redactFor): without it live text is never held, so order bugs hide.
  app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [], redactFor: () => baselineRedact }),
    reviewerAdapter: null, modelApiTransport: transport, localModel: { host, source }, automationTickMs: null });
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', ((url: RequestInfo | URL, init?: RequestInit) => String(url).startsWith('/api/')
    ? realFetch(`${base}${String(url)}`, init) : realFetch(url, init)) as typeof fetch);
  project = await api<Project>('/projects', 'POST', { name: 'Local model fixture' });
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

describe('the local model through the native Nectovia host', () => {
  it('offers the described profiles without starting one, wakes the exact selection, and persists separate fields', async () => {
    const catalog = await api<{ models: { slug: string; name: string }[] }>('/engines/bonsai/models');
    expect(catalog.models.map(p => [p.slug, p.name])).toEqual([['local:gaming', 'bonsai-2-27b Gaming'], ['local:full', 'bonsai-2-27b Full']]);
    const view = await api<LocalModelsView>('/ai/local-models');
    expect(view).toMatchObject({ route: 'bonsai', kind: 'local', name: 'Bonsai 2 Local', status: { state: 'unloaded' } });
    expect(host.acquire).not.toHaveBeenCalled();
    expect(await select('local:full')).toMatchObject({ engine: 'bonsai', requested: { model: 'local:full', effort: 'xhigh', agent: 'auto' } });
    expect(await api('/ai/local-models/wake', 'POST', { model: 'local:full' })).toMatchObject({ state: 'ready', mode: 'Full',
      model: BONSAI_MODEL, detail: 'bonsai-2-27b Full is ready.' });
    const reopened = new Store(path.join(root, 'data'), path.join(root, 'projects')); await reopened.init();
    expect(reopened.state(project.id).conversations.find(t => t.id === thread.id)?.requested).toMatchObject({ model: 'local:full', effort: 'xhigh', agent: 'auto' });
    expect(calls).toEqual([]);
  });
  it('wakes a profile by its saved slug, and refuses a slug the description does not list', async () => {
    expect(await api('/ai/local-models/wake', 'POST', { model: 'bonsai-gaming' })).toMatchObject({ state: 'ready', mode: 'Gaming' });
    const unknown = await request('/ai/local-models/wake', 'POST', { model: 'local:turbo' });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'Choose a local model profile.' });
    expect(vi.mocked(host.acquire).mock.calls.map(call => call[0].slug)).toEqual(['local:gaming']);
  });
  it('writes a saved slug back under its listed slug when a choice echoes it', async () => {
    await savedEarlier('bonsai-full');
    expect(await api<Conversation>(threadPath(), 'PUT', { requested: { model: 'bonsai-full', effort: 'xhigh', agent: 'auto' } }))
      .toMatchObject({ requested: { model: 'local:full' } });
    const refused = await request(threadPath(), 'PUT', { engine: 'bonsai', requested: { model: 'local:turbo', effort: null } });
    expect(refused.status).toBe(400);
  });
  it.each(['local:gaming', 'local:full', 'bonsai-full'])('runs %s with its declared context, usage and bounded deadline', async model => {
    if (model.startsWith('bonsai-')) await savedEarlier(model); else await select(model);
    const full = model.endsWith('full');
    expect(await api(`${threadPath()}/work-style`)).toMatchObject({ route: 'bonsai', refusal: null });
    const command = body();
    const answer = await api<{ runId: string }>(`${threadPath()}/messages`, 'POST', command);
    expect(answer).toMatchObject({ answerText: 'The local model answered.', interrupted: false });
    expect(calls[0]).toMatchObject({ model: BONSAI_MODEL, reasoning_effort: 'xhigh' });
    const turns = store().state(project.id).conversations.find(t => t.id === thread.id)!.turns;
    expect(turns.at(-1)).toMatchObject({ route: 'bonsai', context: { window: { tokens: full ? 131072 : 16384 },
      provider: { reportedCalls: 1, inputTokens: 30, outputTokens: 10 } } });
    const child = await (app.locals.harness.runs as RunService).get(turnRunId(answer.runId, command.commandId));
    expect(child.budget).toMatchObject({ wallMs: full ? 1_800_000 : 480_000, modelCalls: 8, toolCalls: 16 });
  });
  it('delivers actual Full image bytes from the client source path and saves their exact version', async () => {
    await select('local:full');
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
    expect(await gaming.json()).toMatchObject({ error: 'This model takes text only. Choose a model that takes images to send them.' });
    await select('local:full');
    await fs.writeFile(path.join(store().state(project.id).project.folder, 'picture.png'), Buffer.concat([png, Buffer.from('changed')]));
    expect((await request(`${threadPath()}/messages`, 'POST', body('Describe.', sources))).status).toBe(409);
    expect(host.acquire).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
  it('reads the attached note before the message, then executes the model\'s own read tools under native source scope before asking it again', async () => {
    await select(); mode = 'tool';
    const sources = await conversationSources(project.id, ['note.md']);
    const answer = await api<{ answerText: string }>(`${threadPath()}/messages`, 'POST', body('Read the note.', sources));
    expect(answer.answerText).toContain('Only the selected note.');
    expect(calls).toHaveLength(2);
    expect(calls[0].tools.some(t => t.function.name === 'read_source')).toBe(true);
    expect(calls[0].messages.find(m => m.role === 'tool' && m.tool_call_id === 'host-read-1')?.content).toContain('Only the selected note.');
    expect(calls[1].messages.find(m => m.role === 'tool' && m.tool_call_id === 'read-1')?.content).toContain('Only the selected note.');
  });
  it('reports memory failure on wake and sends nothing to any provider', async () => {
    vi.mocked(host.acquire).mockRejectedValueOnce(new LocalModelError('insufficient-memory', 'Needs 12288 MiB of free VRAM.'));
    const response = await request('/ai/local-models/wake', 'POST', { model: 'local:full' });
    expect(response.status).toBe(409); expect(await response.text()).toContain('12288');
    expect((await api<LocalModelsView>('/ai/local-models')).status.state).toBe('insufficient-memory');
    expect(calls).toEqual([]);
  });
  it('reports the described model as a local integration with its loaded profile, starting nothing to say so', async () => {
    const local = async (route = '/integrations') =>
      (await api<{ integrations: IntegrationStatus[] }>(route)).integrations.filter(item => item.id === 'bonsai');
    expect(await local()).toEqual([expect.objectContaining({ id: 'bonsai', name: 'Bonsai 2 Local', kind: 'local', adapter: 'ready',
      found: true, available: false, loaded: null, status: 'Not running', capabilities: ['text', 'tools', 'images in Full'] })]);
    expect(await local('/integrations/local')).toEqual(await local());
    vi.mocked(host.inspect).mockResolvedValue({ state: 'ready', installed: true, mode: 'Full', model: BONSAI_MODEL,
      contextTokens: 131072, owned: true, detail: 'bonsai-2-27b Full is ready.' });
    expect(await local('/integrations/local')).toEqual([expect.objectContaining({ found: true, available: true,
      loaded: 'local:full', status: 'Running', detail: 'bonsai-2-27b Full is ready.' })]);
    vi.mocked(host.inspect).mockResolvedValue({ state: 'missing', installed: false, mode: null, owned: false, detail: 'Not installed.' });
    expect(await local('/integrations/local')).toEqual([]);
    expect(await local()).toEqual([]);
    expect(host.acquire).not.toHaveBeenCalled();
    // A computer with no folder set is never asked at all.
    const absent = { inspect: vi.fn(), acquire: vi.fn() } as unknown as LocalModelHost;
    expect(await localModelIntegrations(new LocalModelRuntime(new FixedLocalModel(null), absent))).toEqual([]);
    expect(absent.inspect).not.toHaveBeenCalled();
  });
  it('never starts the model for a send: a stopped profile is refused, stays chosen, and nothing is sent anywhere', async () => {
    await select('local:gaming');
    let running: string | null = null;
    vi.mocked(host.acquire).mockImplementation(async (profile, options) => {
      if (running !== profile.mode && !options?.start) throw new LocalModelError('unloaded', "The local model isn't running. Start it first.");
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
      .toMatchObject({ engine: 'bonsai', requested: { model: 'local:gaming' } });
    // Only the person's Start may start it, and the next send then runs on it.
    await api('/ai/local-models/wake', 'POST', { model: 'local:gaming' });
    expect(await api(`${threadPath()}/messages`, 'POST', body('Again.'))).toMatchObject({ answerText: 'The local model answered.' });
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
    await select('local:full'); mode = 'proposal';
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

  async function longSource() {
    const raw = meadowDescriptor('http://127.0.0.1:18082');
    source.use({ ...raw, profiles: { Deep: { ...raw.profiles.Deep, outputTokens: 12_288,
      effortBudgets: { medium: { thinking: true, reasoningTokens: 4096, outputTokens: 8192 },
        xhigh: { thinking: true, reasoningTokens: 8192, outputTokens: 12_288 } } } } }, MEADOW_FOLDER);
    await select('local:deep', 'medium');
    const text = 'ledger '.repeat(41_111);
    await fs.writeFile(path.join(store().state(project.id).project.folder, 'ledger.txt'), text);
    await api(`/projects/${project.id}/cloud-sharing`, 'PUT', { expectedVersion: 1, routes: ['bonsai'],
      documents: ['ledger.txt'], shareConversationHistory: true, shareReviewPackets: false });
    longPrompt = true;
    return { text, sources: await conversationSources(project.id, ['ledger.txt']) };
  }

  it('admits a long local conversation and publishes reading progress under the active attempt', async () => {
    const { text, sources } = await longSource();
    const events = await openEvents();
    try {
      await events.next('ready');
      const emitted = vi.spyOn(store(), 'emit');
      const response = await request(`${threadPath()}/messages`, 'POST', body('Reconcile the ledger.', sources));
      expect(response.status, await response.clone().text()).toBe(200);
      // The host reads the ledger whole before the message, so the first call carries it: after the
      // opener and before the person's message, which lists the file and does not repeat it.
      expect(calls).toHaveLength(1);
      const sent = calls[0].messages;
      expect(sent.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
      expect(sent[3]).toMatchObject({ tool_call_id: 'host-read-1' });
      expect(String(sent[3].content)).toContain(text);
      expect(String(sent[4].content)).toContain('ledger.txt');
      expect(String(sent[4].content)).not.toContain(text);
      const frames = emitted.mock.calls.filter(([name]) => name === 'engine-prompt-progress');
      expect(frames).toHaveLength(1);
      expect(frames[0][1]).toMatchObject({ projectId: project.id, threadId: thread.id,
        kind: 'local-prompt-progress', text: 'Reading the document.', total: 115_164,
        processed: 512, cache: 0, time_ms: 500, attempt: 1, fence: expect.any(Number), seq: 1 });
      // The Console only sees what /api/events forwards.
      expect(await events.next('engine-prompt-progress')).toMatchObject({ projectId: project.id, threadId: thread.id,
        kind: 'local-prompt-progress', text: 'Reading the document.', total: 115_164, processed: 512, seq: 1 });
    } finally {
      await events.close();
    }
  });

  it('shows the next call\'s reading line without waiting behind text the earlier call left held', async () => {
    await select(); mode = 'tool'; toolPreface = 'Reading the note first.'; progressAfterTool = true;
    const sources = await conversationSources(project.id, ['note.md']);
    const emitted = vi.spyOn(store(), 'emit');
    const answer = await api<{ answerText: string }>(`${threadPath()}/messages`, 'POST', body('Read the note.', sources));
    expect(answer.answerText).toContain('Only the selected note.');
    expect(calls).toHaveLength(2);
    const sent = emitted.mock.calls.map(([name, frame]) => ({ name, text: (frame as { text?: unknown } | undefined)?.text }));
    const reading = sent.findIndex(frame => frame.name === 'engine-prompt-progress');
    const preface = sent.findIndex(frame => frame.name === 'engine-text' && String(frame.text ?? '').includes('Reading the note'));
    expect(reading).toBeGreaterThanOrEqual(0);
    // The first call's short text is held for redaction until more text arrives; the reading line must not wait for it.
    expect(preface).toBeGreaterThan(reading);
  });

  it('admits the same long local Work source and leaves the proposal behind the existing approval', async () => {
    const { text } = await longSource(); mode = 'proposal';
    const response = await request(`/projects/${project.id}/ask`, 'POST', { threadId: thread.id,
      route: 'bonsai', mode: 'build', text: 'Write a checklist from the ledger.', consent: true, sources: ['ledger.txt'] });
    expect(response.status, await response.clone().text()).toBe(200);
    await vi.waitFor(() => expect(store().state(project.id).needs.some(need => need.state === 'open')).toBe(true), { timeout: 15000 });
    expect(JSON.stringify(calls[0])).toContain(text);
    await expect(fs.stat(path.join(store().state(project.id).project.folder, 'checklist.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
