/**
 * A Console conversation on each kept-session engine, through the real app over HTTP: a thread's
 * messages go through the conversation (`POST /threads/:id/messages`) to that engine's own kept
 * session, the next message continues it, and the thread's session view offers exactly that
 * route's controls. ChatGPT runs on the fixture app-server (tests/fixtures/codex-app-server.mjs),
 * Cursor and Devin on the fixture ACP agent, OpenCode on the fixture `opencode serve`, and Claude
 * Code on a scripted session. No engine binary or account is reached.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { CursorAdapter } from '../server/engines/cursor';
import { DevinAdapter } from '../server/engines/devin';
import { OpenCodeAdapter } from '../server/engines/opencode';
import type { PersistentTextAdapter, TextRequest } from '../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { createIntegrations, createRpcClient } from '../server/integrations';
import { forgetCatalog } from '../server/models';
import { routeContractFor } from '../server/harness/route-contract';
import { keptSessionOfRun } from '../server/conversation-sessions';
import { hash, type Store } from '../server/store';
import type { MessageResult } from '../shared/conversation';
import { sessionControls, type ThreadSessionView } from '../shared/session-controls';
import type { Conversation, Project } from '../shared/types';

const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const ACP_FIXTURE = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const OPENCODE_FIXTURE = fileURLToPath(new URL('./fixtures/opencode-session-server.mjs', import.meta.url));
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
type Engine = 'claude-code' | 'opencode' | 'cursor' | 'devin';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
async function boot(engines: EngineService, codex?: ReturnType<typeof createIntegrations>) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    ...(codex ? { codexIntegration: codex } : {}),
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  const closingApp = app,
    closingServer = server;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
  }
}
/** What discovery reports for an engine found on this computer. */
const installed = (id: Engine) => ({
  id,
  name: 'Fixture',
  kind: 'online' as const,
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Fixture',
  capabilities: [],
  signIn: 'unknown' as const,
  adapter: 'planned' as const,
  installedVersion: TESTED_VERSIONS[id],
  location: process.execPath,
  disclosure: [],
});
type On = { project: Project; thread: Conversation };
/** A project thread on `engine`, with Cloud sharing granted for `routes` and history on. */
async function threadOn(engine: string, routes: string[] = [engine]): Promise<On> {
  const project = await api<Project>('/projects', 'POST', { name: `${engine} conversation` });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes,
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  const thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine });
  return { project, thread };
}
const moveTo = (on: On, engine: string) => api(`/projects/${on.project.id}/threads/${on.thread.id}`, 'PUT', { engine });
const send = (on: On, commandId: string, text: string) =>
  api<MessageResult>(`/projects/${on.project.id}/threads/${on.thread.id}/messages`, 'POST', {
    commandId,
    text,
    mode: 'ask',
    sources: [],
    consent: true,
  });
const view = (on: On) => api<ThreadSessionView>(`/projects/${on.project.id}/threads/${on.thread.id}/native-session`);
const recorded = (on: On) =>
  (app.locals.store as Store).state(on.project.id).conversations.find((item) => item.id === on.thread.id)!;
const answeredOn = (on: On) =>
  recorded(on)
    .turns.filter((turn) => turn.role === 'assistant')
    .map((turn) => turn.route);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-conversation-engines-'));
});
afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  forgetCatalog();
  await fs.rm(root, { recursive: true, force: true });
});

describe('ChatGPT, and a thread moved between ChatGPT and Claude Code', () => {
  let codexDir: string;
  /** What the Claude Code session was sent, turn by turn. */
  let claudeTurns: TextRequest[];
  const calls = async () =>
    (await fs.readFile(path.join(codexDir, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { pid: number; method: string; params: Record<string, unknown> });
  const claude = (): PersistentTextAdapter<ClaudeSessionCheckpoint> => ({
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute: 'claude-code:claude.ai',
      detail: 'Fixture only',
      models: [{ slug: 'sonnet', name: 'sonnet', description: '', efforts: [], defaultEffort: null }],
    }),
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
        cliVersion: TESTED_VERSIONS['claude-code'],
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
          return { providerId: 'claude-code' as const, lineageId: checkpoint.lineageId, opaqueRef: checkpoint.nativeSessionId! };
        },
        turn: async (turn) => {
          claudeTurns.push(turn);
          checkpoint = { ...checkpoint, state: 'busy', requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }] };
          await options.onCheckpoint(checkpoint, signal);
          const text = 'Soup and bread.';
          turn.onDelta?.(text);
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: 'sonnet',
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return { text, model: 'sonnet', version: TESTED_VERSIONS['claude-code'], projectId: turn.projectId, threadId: turn.threadId, requestId: turn.requestId };
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      };
    },
  });
  beforeEach(async () => {
    codexDir = path.join(root, 'codex');
    claudeTurns = [];
    await fs.mkdir(codexDir, { recursive: true });
    // The model list a signed-in ChatGPT keeps: a conversation's model must be on it.
    const codexHome = path.join(root, 'codex-home');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'fixture-codex-model',
            display_name: 'Fixture',
            visibility: 'list',
            default_reasoning_level: 'medium',
            supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
          },
        ],
      }),
    );
    vi.stubEnv('CODEX_HOME', codexHome);
    forgetCatalog();
    const codex = createIntegrations({
      platform: 'win32',
      verifySandbox: async () => {},
      turnTimeoutMs: 20_000,
      createClient: async () =>
        createRpcClient(
          spawn(process.execPath, [CODEX_FIXTURE], {
            env: { PATH: process.env.PATH, CODEX_FIXTURE_DIR: codexDir },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          }),
        ),
    });
    await boot(
      new EngineService(path.join(root, 'engines'), {
        discover: async () => [installed('claude-code')],
        version: async () => TESTED_VERSIONS['claude-code'],
        adapter: () => claude(),
      }),
      codex,
    );
    // A settings save replaces `services` whole, so ChatGPT is set before Claude Code is selected.
    await api('/settings', 'PUT', { services: { codex: true, codexModel: 'fixture-codex-model' } });
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: 'claude-code', model: 'sonnet' });
  });

  test('a ChatGPT thread continues one Codex thread through the conversation, and offers exactly its controls', async () => {
    const on = await threadOn('codex');
    const first = await send(on, 'm-one', 'What is on the lunch menu?');
    const codexThread = /Fixture answer on (\S+) after 1 user turn\./.exec(first.answerText ?? '')?.[1];
    expect(codexThread, first.answerText ?? '').toBeTruthy();
    expect(keptSessionOfRun(first.runId)?.route).toBe('codex');
    const second = await send(on, 'm-two', 'And for dinner?');
    expect(second.answerText).toContain(`Fixture answer on ${codexThread} after 2 user turns.`);
    expect(second.runId).toBe(first.runId);
    const log = await calls();
    expect(log.filter((call) => call.method === 'thread/start')).toHaveLength(1);
    const turns = log.filter((call) => call.method === 'turn/start');
    expect(turns).toHaveLength(2);
    // The conversation's own process, kept between its turns.
    expect(new Set(turns.map((call) => call.pid)).size).toBe(1);
    expect(await view(on)).toMatchObject({
      runId: first.runId,
      controls: sessionControls(routeContractFor('codex-session')),
      busy: false,
      reportedModel: 'fixture-codex-model',
    });
    expect(answeredOn(on)).toEqual(['codex', 'codex']);
  });

  test('a whole-project read is refused on ChatGPT before anything is recorded or started', async () => {
    const on = await threadOn('codex');
    const refused = await request(`/projects/${on.project.id}/threads/${on.thread.id}/messages`, 'POST', {
      commandId: 'm-folder',
      text: 'Look through everything',
      mode: 'ask',
      sources: [],
      consent: true,
      readAccess: 'project',
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('Reading the whole project folder is not available on this route.');
    expect(recorded(on).lineages ?? []).toEqual([]);
    expect(await fs.readFile(path.join(codexDir, 'calls.jsonl'), 'utf8').catch(() => '')).toBe('');
  });

  test('a thread moved from ChatGPT to Claude Code and back opens a new lineage each time, and nothing crosses engines', async () => {
    const on = await threadOn('codex', ['codex', 'claude-code']);
    const first = await send(on, 'm-one', 'What is on the lunch menu?');
    expect(first.answerText).toContain('after 1 user turn.');
    await moveTo(on, 'claude-code');
    const second = await send(on, 'm-two', 'And for dinner?');
    expect(second.answerText).toBe('Soup and bread.');
    await moveTo(on, 'codex');
    const third = await send(on, 'm-three', 'Anything vegetarian?');
    // A fresh Codex thread: the first one is never resumed on the way back.
    expect(third.answerText).toContain('after 1 user turn.');
    expect(third.runId).not.toBe(first.runId);

    const thread = recorded(on);
    expect(thread.lineages!.map((lineage) => keptSessionOfRun(lineage.runId)?.route)).toEqual(['codex', 'claude-code', 'codex']);
    expect(thread.lineages!.map((lineage) => lineage.retired ?? null)).toEqual(['scope-change', 'scope-change', null]);
    const notes = thread.turns.filter((turn) => turn.role === 'diomedes' && turn.text.includes('started this conversation fresh'));
    expect(notes.map((turn) => turn.text)).toEqual([
      expect.stringContaining('this conversation moved to Claude Code'),
      expect.stringContaining('this conversation moved to ChatGPT'),
    ]);
    expect(answeredOn(on)).toEqual(['codex', 'claude-code', 'codex']);

    // Nothing ChatGPT answered reached Claude Code, and nothing Claude Code answered reached ChatGPT.
    expect(claudeTurns).toHaveLength(1);
    expect(JSON.stringify(claudeTurns[0])).not.toContain('Fixture answer');
    expect(claudeTurns[0].carriedFrom).toBeUndefined();
    const log = await calls();
    expect(log.filter((call) => call.method === 'thread/start')).toHaveLength(2);
    expect(log.filter((call) => call.method === 'thread/resume')).toHaveLength(0);
    const turns = log.filter((call) => call.method === 'turn/start');
    expect(turns).toHaveLength(2);
    expect(JSON.stringify(turns[1].params)).not.toContain('Soup and bread');
  });
});

describe.each(['cursor', 'devin'] as const)('a %s conversation', (engine) => {
  beforeEach(async () => {
    const deps = {
      spawn: (_file: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
        spawn(process.execPath, [ACP_FIXTURE], options) as ChildProcessWithoutNullStreams,
      capture: (async (options: { args: string[] }) =>
        options.args.includes('--version')
          ? { code: 0, stdout: engine === 'cursor' ? '2026.08.11-e8db854' : 'devin 3000.10.23' }
          : { code: 0, stdout: JSON.stringify({ status: 'authenticated', isAuthenticated: true }) }) as never,
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 10_000,
    };
    await boot(
      new EngineService(path.join(root, 'engines'), {
        discover: async () => [installed(engine)],
        version: async () => TESTED_VERSIONS[engine],
        adapter: (_engine, _location, cwd) =>
          engine === 'cursor'
            ? new CursorAdapter(path.join(root, 'agent'), cwd, deps)
            : new DevinAdapter(path.join(root, 'devin.exe'), cwd, deps),
      }),
    );
    await api('/ai/discover', 'POST', { consent: true });
    await api(`/ai/check/${engine}`, 'POST', {});
    await api('/ai/select', 'POST', { engine, model: 'fixture-model' });
  });

  test('continues its ACP session through the conversation, and offers exactly its controls', async () => {
    const on = await threadOn(engine);
    const first = await send(on, 'm-one', 'What is on the lunch menu?');
    expect(first.answerText).toBe('answer after 0 earlier turns');
    expect(keptSessionOfRun(first.runId)?.route).toBe(engine);
    const second = await send(on, 'm-two', 'And for dinner?');
    expect(second.answerText).toBe('answer after 1 earlier turns');
    expect(second.runId).toBe(first.runId);
    expect(await view(on)).toMatchObject({
      runId: first.runId,
      controls: sessionControls(routeContractFor(`${engine}-session`)),
      busy: false,
    });
    expect(answeredOn(on)).toEqual([engine, engine]);
  });
});

describe('an OpenCode conversation', () => {
  beforeEach(async () => {
    vi.stubEnv('XDG_CACHE_HOME', path.join(os.tmpdir(), 'diomedes-no-opencode-cache'));
    vi.stubEnv('XDG_DATA_HOME', path.join(root, 'opencode-data'));
    await boot(
      new EngineService(path.join(root, 'engines'), {
        discover: async () => [installed('opencode')],
        version: async () => TESTED_VERSIONS.opencode,
        adapter: (_engine, _location, cwd) =>
          new OpenCodeAdapter('opencode', cwd, {
            spawn: (_command, args, options) =>
              spawn(process.execPath, [OPENCODE_FIXTURE, args[args.indexOf('--port') + 1], 'ok'], options) as ChildProcessWithoutNullStreams,
            startupTimeoutMs: 5_000,
            requestTimeoutMs: 5_000,
          }),
      }),
    );
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/opencode', 'POST', {});
    await api('/ai/select', 'POST', { engine: 'opencode', model: 'opencode-go/go-model' });
  });

  test('continues its OpenCode session through the conversation, and offers exactly its controls', async () => {
    const on = await threadOn('opencode');
    const first = await send(on, 'm-one', 'What is on the lunch menu?');
    expect(first.answerText).toMatch(/^answer:What is on the lunch menu\?/);
    const session = /\(turn 1 of (\S+)\)$/.exec(first.answerText ?? '')?.[1];
    expect(session, first.answerText ?? '').toBeTruthy();
    const second = await send(on, 'm-two', 'And for dinner?');
    expect(second.answerText).toMatch(/^answer:And for dinner\?/);
    expect(second.answerText).toContain(`(turn 2 of ${session})`);
    expect(second.runId).toBe(first.runId);
    expect(await view(on)).toMatchObject({
      runId: first.runId,
      controls: sessionControls(routeContractFor('opencode-session')),
      busy: false,
    });
    expect(answeredOn(on)).toEqual(['opencode', 'opencode']);
  });
});
