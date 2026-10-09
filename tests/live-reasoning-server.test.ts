/**
 * Live thinking reaches the events stream and the saved reply on both conversation surfaces.
 *
 * Real `createApp`, real `EngineService`, real RunService and Store events. Only the provider
 * transport is scripted: it reports thinking through the adapter-facing `onReasoningDelta` sink
 * that EngineService alone hands it, and only on a route whose descriptor declares thinking.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type {
  PersistentTextAdapter,
  TextEngineAdapter,
  TextRequest,
} from '../server/engines/contract.js';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { hash, type Store } from '../server/store.js';
import { reasoningPreviewSchema, type AdapterRouteContract } from '../shared/adapter-contract.js';
import type { IntegrationStatus, Turn } from '../shared/types.js';

const ENGINE = 'claude-code' as const;
const VERSION = TESTED_VERSIONS[ENGINE];
const ACCOUNT = 'claude-code:claude.ai';
const MODEL = 'sonnet';
const SECRET = 'sk-live-thinking-1234';
const THOUGHT = 'Weighing the menu. ';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

type Frame = Record<string, unknown> & { channel: 'text' | 'reasoning' };

let root: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base = '';
let frames: Frame[];
let seen: TextRequest[];

const store = (): Store => app!.locals.store;

/** The same descriptor, declaring whether the route streams thinking. */
const declaring = (
  contract: AdapterRouteContract,
  reasoning: 'reasoning-delta' | 'none',
): AdapterRouteContract => ({ ...contract, streaming: { ...contract.streaming, reasoning } });

const installed: IntegrationStatus = {
  id: ENGINE,
  name: 'Claude Code',
  kind: 'online',
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Found',
  capabilities: [],
  signIn: 'unknown',
  adapter: 'planned',
  installedVersion: VERSION,
  location: process.execPath,
  disclosure: [],
};
const inspect = async () => ({
  authentication: 'signed-in' as const,
  accountRoute: ACCOUNT,
  detail: 'Fixture only',
  models: [{ slug: MODEL, name: MODEL, description: '', efforts: [], defaultEffort: null }],
});

/** What a scripted provider does with one request; it may wait, as a real engine does. */
type Work = (input: TextRequest) => void | Promise<void>;

/** The provider's scripted work: thinking with a secret split across two chunks, then the answer. */
function think(input: TextRequest) {
  input.onReasoningDelta?.(THOUGHT);
  input.onReasoningDelta?.(`The key ${SECRET.slice(0, 11)}`);
  input.onReasoningDelta?.(`${SECRET.slice(11)} is not needed.`);
  input.onDelta?.('Soup and bread.');
}

async function open(adapter: TextEngineAdapter) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-reasoning-'));
  frames = [];
  seen = [];
  const engines = new EngineService(path.join(root, 'data', 'engines'), {
    discover: async () => [installed],
    version: async () => VERSION,
    adapter: () => adapter,
    redactFor: () => (text: string) => text.replaceAll(SECRET, '[redacted]'),
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    nativeGenerator: async () => {
      throw new Error('No native work runs in this fixture');
    },
  } as Parameters<typeof createApp>[0]);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store().on('engine-text', (frame: Record<string, unknown>) =>
    frames.push({ ...structuredClone(frame), channel: 'text' }),
  );
  store().on('engine-reasoning', (frame: Record<string, unknown>) =>
    frames.push({ ...structuredClone(frame), channel: 'reasoning' }),
  );
}

afterEach(async () => {
  if (!server) return;
  const closingApp = app!, closingServer = server, closingRoot = root;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(closingRoot, { recursive: true, force: true });
});

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

/** What is left of a JSON text once every `thinking` field is removed, or null when it isn't JSON. */
const withoutThinking = (text: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(text, (key, value) => (key === 'thinking' ? undefined : value)));
  } catch {
    return null;
  }
};

/**
 * Files under `dir` that hold `marker` anywhere except inside a `thinking` field. A file is read
 * as one JSON document, or else line by line as a journal; text that is neither is a leak.
 */
async function leaks(dir: string, marker: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    if (!text.includes(marker)) continue;
    const whole = withoutThinking(text);
    const outside =
      whole !== null
        ? whole.includes(marker)
        : text
            .split('\n')
            .filter((line) => line.includes(marker))
            .some((line) => withoutThinking(line)?.includes(marker) ?? true);
    if (outside) found.push(path.relative(dir, file));
  }
  return found;
}

/**
 * A provider that finishes its thinking, says so, then writes a two-part answer, and keeps
 * writing until the first part has reached the events stream. `seenWhileWriting` is what had
 * been shown by then: what a person reads while the engine is still at work.
 */
function thinkThenAnswer(seenWhileWriting: Frame[][]): Work {
  return async (input) => {
    input.onReasoningDelta?.(THOUGHT);
    input.onReasoningDelta?.('Then the prices.');
    input.onReasoningEnd?.();
    input.onDelta?.('Soup and bread are on the menu today. ');
    input.onDelta?.('Coffee and cake come after the meal.');
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.channel === 'text' && frame.kind === 'delta')).toBe(true),
    );
    seenWhileWriting.push(structuredClone(frames));
  };
}
const shownOn = (list: readonly Frame[], channel: 'text' | 'reasoning') =>
  list
    .filter((frame) => frame.channel === channel && frame.kind !== 'started' && frame.kind !== 'ended')
    .map((frame) => frame.text)
    .join('');

const replies = (projectId: string): Turn[] =>
  store()
    .state(projectId)
    .conversations.flatMap((conversation) => conversation.turns)
    .filter((turn) => turn.role === 'assistant');

describe('thread Ask on an external engine', () => {
  const adapter = (
    reasoning: 'reasoning-delta' | 'none',
    work: Work = think,
  ): TextEngineAdapter => ({
    id: ENGINE,
    contract: declaring(routeContractFor(ENGINE), reasoning),
    inspect,
    generate: async (input) => {
      seen.push(input);
      await work(input);
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        version: VERSION,
        text: 'Soup and bread.',
      };
    },
  });

  async function ask(expectOk = true) {
    const project = await store().locked(() => store().createProject('Live thinking'));
    store().settings.services = {
      'claude-code': true,
      'claude-codeModel': MODEL,
      'claude-codeAccountRoute': ACCOUNT,
    };
    await store().saveSettings(store().settings);
    await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
      expectedVersion: 0,
      routes: ['claude-code'],
      documents: [],
      shareConversationHistory: false,
      shareReviewPackets: false,
    });
    const response = await fetch(`${base}/api/projects/${project.id}/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'What is on the menu?', route: ENGINE, mode: 'ask', consent: true }),
    });
    if (expectOk) expect(response.ok, await response.clone().text()).toBe(true);
    return project;
  }

  test('thinking streams as its own frames, bound to the answer run, ahead of the answer', async () => {
    await open(adapter('reasoning-delta'));
    const project = await ask();
    // Frames follow what is safe to show, not the engine's chunks; all thinking is ahead of the answer.
    const channels = frames.map((frame) => (frame.channel === 'text' ? `text:${String(frame.kind)}` : 'think'));
    expect(channels.filter((channel, at) => channel !== channels[at - 1])).toEqual([
      'text:started',
      'think',
      'text:delta',
      'text:ended',
    ]);
    const delta = frames.find((frame) => frame.channel === 'text' && frame.kind === 'delta')!;
    for (const frame of frames.filter((item) => item.channel === 'reasoning')) {
      const { channel: _channel, ...wire } = frame;
      expect(reasoningPreviewSchema.safeParse(wire).success).toBe(true);
      expect(frame).toMatchObject({
        kind: 'reasoning-delta',
        projectId: project.id,
        runId: delta.runId,
        stepId: delta.stepId,
        attempt: delta.attempt,
        fence: delta.fence,
      });
    }
    const thinking = frames.filter((frame) => frame.channel === 'reasoning');
    expect(thinking.map((frame) => frame.seq)).toEqual(thinking.map((_frame, at) => at + 1));
    expect(thinking.map((frame) => frame.text).join('')).toBe(
      'Weighing the menu. The key [redacted] is not needed.',
    );
    const reply = replies(project.id).at(-1)!;
    expect(reply.text).toBe('Soup and bread.');
    expect(reply.thinking).toMatchObject({
      text: 'Weighing the menu. The key [redacted] is not needed.',
      shortened: false,
    });
    expect(reply.thinking!.ms).toBeGreaterThanOrEqual(0);
    // The adapter got the raw sink and never the caller's frame channel.
    expect(typeof seen[0].onReasoningDelta).toBe('function');
    expect(typeof seen[0].onReasoningEnd).toBe('function');
    expect(seen[0].onReasoning).toBeUndefined();
  });

  test('a finished block of thinking is shown whole, and the answer streams while the engine is still writing', async () => {
    const seenWhileWriting: Frame[][] = [];
    await open(adapter('reasoning-delta', thinkThenAnswer(seenWhileWriting)));
    await ask();
    expect(seenWhileWriting).toHaveLength(1);
    expect(shownOn(seenWhileWriting[0], 'reasoning')).toBe('Weighing the menu. Then the prices.');
    // The answer's own newest part is still held for redaction; the rest is on screen.
    expect(shownOn(seenWhileWriting[0], 'text')).toBe('Soup and bread are on the menu today. ');
  });

  test('a route that declares no thinking never gets the sink and saves none', async () => {
    await open(adapter('none'));
    const project = await ask();
    expect(frames.some((frame) => frame.channel === 'reasoning')).toBe(false);
    expect(seen[0].onReasoningDelta).toBeUndefined();
    expect(seen[0].onReasoningEnd).toBeUndefined();
    expect(replies(project.id).at(-1)!.thinking).toBeUndefined();
  });

  test('thinking and then a failure leaves no turn holding thinking', async () => {
    await open(
      adapter('reasoning-delta', (input) => {
        input.onReasoningDelta?.(THOUGHT);
        throw Object.assign(new Error('The provider stopped.'), { code: 'PROVIDER_ERROR' });
      }),
    );
    const project = await ask(false);
    expect(replies(project.id).some((turn) => turn.thinking !== undefined)).toBe(false);
    // The failed attempt still showed the thinking it had held back.
    const shown = frames.filter((frame) => frame.channel === 'reasoning').map((frame) => frame.text);
    expect(shown.join('')).toBe(THOUGHT);
  });

  test('a caller cannot hand the adapter-facing thinking sink in directly', async () => {
    await open(adapter('reasoning-delta'));
    const service = new EngineService(path.join(root, 'data', 'engines-direct'), {
      discover: async () => [installed],
      version: async () => VERSION,
      adapter: () => adapter('reasoning-delta'),
    });
    service.dispatch = async () => {
      throw new Error('never dispatched');
    };
    await expect(
      service.generate(ENGINE, {
        projectId: 'P1',
        threadId: 'T1',
        requestId: 'R1',
        prompt: 'x',
        documents: [],
        instructions: '',
        model: MODEL,
        accountRoute: ACCOUNT,
        onReasoningDelta: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_CONTRACT' });
    await expect(
      service.generate(ENGINE, {
        projectId: 'P1',
        threadId: 'T1',
        requestId: 'R2',
        prompt: 'x',
        documents: [],
        instructions: '',
        model: MODEL,
        accountRoute: ACCOUNT,
        onReasoningEnd: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_CONTRACT' });
    expect(seen).toHaveLength(0);
  });
});

describe('the Diomedes conversation driver', () => {
  const sessionAdapter = (work: Work = think): PersistentTextAdapter<ClaudeSessionCheckpoint> => ({
    id: ENGINE,
    contract: routeContractFor(ENGINE),
    sessionContract: declaring(routeContractFor('claude-code-session'), 'reasoning-delta'),
    inspect,
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: async (input, options) => {
      let checkpoint: ClaudeSessionCheckpoint = {
        version: 1,
        nativeSessionId: randomUUID(),
        lineageId: randomUUID(),
        parentSessionId: null,
        projectId: input.projectId,
        threadId: input.threadId,
        cwd: root,
        cliVersion: VERSION,
        accountDigest: hash('fixture-account')!,
        requestedModel: input.model,
        reportedModel: null,
        instructionDigest: hash(input.instructions)!,
        state: 'idle',
        requests: [],
        results: [],
      };
      const signal = new AbortController().signal;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return {
            providerId: 'claude-code' as const,
            lineageId: checkpoint.lineageId,
            opaqueRef: checkpoint.nativeSessionId!,
          };
        },
        turn: async (turn) => {
          seen.push(turn);
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          await work(turn);
          const text = 'Soup and bread.';
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: MODEL,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text,
            model: MODEL,
            version: VERSION,
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
          };
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      };
    },
  });

  test('a home message streams thinking and keeps it only on the saved reply', async () => {
    await open(sessionAdapter());
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: ENGINE, model: MODEL });
    const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST');
    await api(`/projects/${home.projectId}/threads/${home.threadId}`, 'PUT', { engine: ENGINE });
    const message = {
      commandId: 'm-think',
      text: 'What is on the menu?',
      mode: 'ask',
      sources: [],
      consent: true,
    };
    await api(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', message);
    const reasoning = frames.filter((frame) => frame.channel === 'reasoning');
    expect(reasoning.map((frame) => frame.text).join('')).toBe('Weighing the menu. The key [redacted] is not needed.');
    expect(reasoning[0]).toMatchObject({
      projectId: home.projectId,
      threadId: home.threadId,
      requestId: 'm-think',
    });
    const thread = () =>
      store().state(home.projectId).conversations.find((item) => item.id === home.threadId)!;
    const saved = thread().turns.at(-1)!;
    expect(saved).toMatchObject({
      role: 'assistant',
      thinking: { text: 'Weighing the menu. The key [redacted] is not needed.', shortened: false },
    });
    expect(typeof seen[0].onReasoningDelta).toBe('function');
    expect(typeof seen[0].onReasoningEnd).toBe('function');
    expect(seen[0].onReasoning).toBeUndefined();
    // The run record, the carried history and every other saved file never hold the thinking.
    expect(await leaks(path.join(root, 'data'), THOUGHT.trim())).toEqual([]);

    // The same message again is answered from the record: no new frames, nothing rewritten.
    const thinking = () => frames.filter((frame) => frame.channel === 'reasoning').length;
    const before = { frames: frames.length, thinking: thinking(), turns: thread().turns.length };
    await api(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', message);
    expect(thinking()).toBe(before.thinking);
    expect(frames.length - before.frames).toBeLessThanOrEqual(2);
    expect(thread().turns).toHaveLength(before.turns);
    expect(thread().turns.at(-1)!.thinking).toEqual(saved.thinking);
  });

  test('a kept conversation shows a finished block of thinking whole, and streams the answer before the turn ends', async () => {
    const seenWhileWriting: Frame[][] = [];
    await open(sessionAdapter(thinkThenAnswer(seenWhileWriting)));
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: ENGINE, model: MODEL });
    const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST');
    await api(`/projects/${home.projectId}/threads/${home.threadId}`, 'PUT', { engine: ENGINE });
    await api(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', {
      commandId: 'm-streams',
      text: 'What is on the menu?',
      mode: 'ask',
      sources: [],
      consent: true,
    });
    expect(seenWhileWriting).toHaveLength(1);
    expect(shownOn(seenWhileWriting[0], 'reasoning')).toBe('Weighing the menu. Then the prices.');
    expect(shownOn(seenWhileWriting[0], 'text')).toBe('Soup and bread are on the menu today. ');
  });

  test('a home message that fails still shows what it had held back, redacted', async () => {
    await open(
      sessionAdapter((turn) => {
        think(turn);
        throw Object.assign(new Error('The provider stopped.'), { code: 'PROVIDER_ERROR' });
      }),
    );
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: ENGINE, model: MODEL });
    const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST');
    await api(`/projects/${home.projectId}/threads/${home.threadId}`, 'PUT', { engine: ENGINE });
    const response = await fetch(`${base}/api/projects/${home.projectId}/threads/${home.threadId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ commandId: 'm-fail', text: 'What is on the menu?', mode: 'ask', sources: [], consent: true }),
    });
    await response.text();
    const shown = (channel: 'text' | 'reasoning') =>
      frames
        .filter((frame) => frame.channel === channel && frame.kind !== 'started' && frame.kind !== 'ended')
        .map((frame) => frame.text)
        .join('');
    expect(shown('reasoning')).toBe('Weighing the menu. The key [redacted] is not needed.');
    expect(shown('text')).toBe('Soup and bread.');
  });
});
