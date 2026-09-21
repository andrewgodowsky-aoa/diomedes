import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { PersistentTextAdapter, TextRequest } from '../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { routeContractFor } from '../server/harness/route-contract';
import { hash, identifier, now, type Store } from '../server/store';
import type { MessageResult } from '../server/interaction-service';
import type { Conversation, Project, Settings, TaskCandidate } from '../shared/types';

// The reserved workspace home Project and its one conversation, through the real app over
// HTTP: the real Store, the real settings file, the real task and Work admission, with only
// the provider faked. `close()` then `open()` over the same data directory is a crash and a
// restart. Nothing here provisions a home except a POST to the home route.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'claude-fixture';
const accountRoute = 'claude-code:claude.ai';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let dispatches: TextRequest[];
let nativeCalls: number;

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
async function open() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    // No test here may reach a native worker. One that does is counted, then fails.
    nativeGenerator: async () => {
      nativeCalls += 1;
      throw new Error('No native work runs in this fixture');
    },
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
}
const store = () => app.locals.store as Store;

/**
 * The fake model, reading the issued identity off the last line as the instructions tell a real
 * one to. ACT proposes work naming no project; TARGET <projectId> proposes work naming that
 * one. Anything else is an ordinary answer.
 */
function scripted(prompt: string) {
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(prompt)?.[1];
  const text = prompt.split('\n\n[[diomedes')[0];
  const named = /^TARGET (\S+)/.exec(text)?.[1] ?? null;
  if ((named !== null || text.startsWith('ACT')) && issued)
    return (
      'I can start that.\n\n```diomedes-decision\n' +
      JSON.stringify({
        source_message_id: issued,
        disposition: 'act',
        requested_project_id: named,
        operation_class: 'write_internal',
        source_refs: [],
        target_run_id: null,
        question: null,
        public_summary: `Do this: ${text}`,
      }) +
      '\n```'
    );
  return `answer:${text}`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-home-'));
  dispatches = [];
  nativeCalls = 0;
  const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute,
      detail: 'Fixture only',
      models: [{ slug: model, name: model, description: '', efforts: [], defaultEffort: null }],
    }),
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: async (input, options) => {
      let checkpoint: ClaudeSessionCheckpoint = options.restore
        ? structuredClone(options.restore)
        : {
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
          return checkpoint.nativeSessionId
            ? {
                providerId: 'claude-code',
                lineageId: checkpoint.lineageId,
                opaqueRef: checkpoint.nativeSessionId,
              }
            : null;
        },
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          dispatches.push(turn);
          const text = scripted(turn.prompt);
          turn.onDelta?.(text);
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: model,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text,
            model,
            version: TESTED_VERSIONS['claude-code'],
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
          };
        },
        interrupt: async () => {
          throw new Error('No held turn in this fixture');
        },
        close: async () => undefined,
      };
    },
  };
  service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'claude-code',
        name: 'Fixture',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Fixture',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS['claude-code'],
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS['claude-code'],
    adapter: () => adapter,
  });
  await open();
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

type Binding = { projectId: string; threadId: string };
const readHome = () => api<Binding | null>('/home/conversation');
const provision = () => api<Binding>('/home/conversation', 'POST');
const listed = async () => (await api<{ projects: Project[] }>('/projects')).projects;
/** Every registry row whose folder is the reserved one, however the binding points. */
const homeRows = async () =>
  (await store().projects()).filter(
    (project) => path.resolve(project.folder).toLowerCase() === store().homeFolder().toLowerCase(),
  );
const threadsOf = (projectId: string) => store().state(projectId).conversations;
/** A project a person really has, running the scripted sample worker rather than a provider. */
async function realProject(name = 'Linen service') {
  const created = await api<Project>('/projects', 'POST', { name });
  const state = store().state(created.id);
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
  return created;
}
/** Rewrite the saved settings file while the app is closed: settings written by an older build. */
async function saveRawHome(home: unknown) {
  const file = path.join(root, 'data', 'settings.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(file, JSON.stringify({ ...saved, home }, null, 2), 'utf8');
}
/** Put a binding into the live settings without going through the provisioner. */
const rebind = (home: Settings['home']) => store().saveSettings({ ...store().settings, home });
const send = (home: Binding, commandId: string, text: string) =>
  api<MessageResult>(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', {
    commandId,
    text,
    mode: 'auto',
    sources: [],
    consent: true,
  });

test('startup creates no home, and a fresh listing of projects is empty', async () => {
  expect(await readHome()).toBe(null);
  expect(await listed()).toEqual([]);
  expect(store().settings.home).toBe(null);
  expect(await homeRows()).toEqual([]);
  // A restart is not a first message either.
  await close();
  await open();
  expect(await readHome()).toBe(null);
  expect(await listed()).toEqual([]);
  expect(await homeRows()).toEqual([]);
});

test('a binding with the wrong revision is dropped on load and reads as no home', async () => {
  const home = await provision();
  await close();
  await saveRawHome({ ...home, revision: 2 });
  await open();
  expect(store().settings.home).toBe(null);
  expect(await readHome()).toBe(null);
});

test('a malformed binding is dropped on load and reads as no home', async () => {
  const home = await provision();
  for (const malformed of [
    { projectId: home.projectId },
    { projectId: home.projectId, threadId: 7, revision: 1 },
    { projectId: home.projectId, threadId: home.threadId, revision: '1' },
    'home',
    [],
  ]) {
    await close();
    await saveRawHome(malformed);
    await open();
    expect(store().settings.home, JSON.stringify(malformed)).toBe(null);
    expect(await readHome()).toBe(null);
  }
});

test('a binding naming a foreign project reads as no home', async () => {
  const home = await provision();
  const other = await realProject();
  await rebind({ projectId: other.id, threadId: home.threadId, revision: 1 });
  expect(await readHome()).toBe(null);
  // The shape is fine, so this survives a reload: only the records refuse it.
  await close();
  await open();
  expect(store().settings.home).toEqual({
    projectId: other.id,
    threadId: home.threadId,
    revision: 1,
  });
  expect(await readHome()).toBe(null);
});

test('a binding naming a thread that is not the oldest reads as no home', async () => {
  const home = await provision();
  const state = store().state(home.projectId);
  const stamped = new Date(Date.parse(threadsOf(home.projectId)[0].createdAt!) + 1000);
  const second: Conversation = {
    id: identifier('C'),
    attachedTo: { kind: 'project', ref: home.projectId },
    turns: [],
    name: 'Later',
    createdAt: stamped.toISOString(),
    updatedAt: stamped.toISOString(),
    taskId: null,
    helper: null,
    permission: 'show-first',
    mode: 'auto',
  };
  state.conversations.push(second);
  await store().persist(state);
  await rebind({ projectId: home.projectId, threadId: second.id, revision: 1 });
  expect(await readHome()).toBe(null);
  // The designated thread is still the oldest one, and adoption returns to it.
  expect(await provision()).toEqual(home);
});

test('a binding naming records that are not there reads as no home', async () => {
  await provision();
  await rebind({ projectId: 'abcdef012345', threadId: 'Cabcdef012345', revision: 1 });
  expect(await readHome()).toBe(null);
});

test('a client PUT of settings carrying home does not change the binding', async () => {
  const home = await provision();
  const other = await realProject();
  const forged = { projectId: other.id, threadId: 'Cffffffffffff', revision: 1 as const };
  const saved = await api<Settings>('/settings', 'PUT', { ...store().settings, home: forged });
  expect(saved.home).toEqual({ ...home, revision: 1 });
  expect(store().settings.home).toEqual({ ...home, revision: 1 });
  expect(await readHome()).toEqual(home);
  // And a client cannot invent one where there is none either.
  await rebind(null);
  await api<Settings>('/settings', 'PUT', { ...store().settings, home: forged });
  expect(store().settings.home).toBe(null);
  expect(await readHome()).toBe(null);
});

test('adoption repairs an invalid binding without a second home Project or a second thread', async () => {
  const home = await provision();
  for (const broken of [
    null,
    { projectId: 'abcdef012345', threadId: 'Cabcdef012345', revision: 1 as const },
  ]) {
    await rebind(broken);
    expect(await readHome()).toBe(null);
    expect(await provision()).toEqual(home);
    expect(await homeRows()).toHaveLength(1);
    expect(threadsOf(home.projectId)).toHaveLength(1);
  }
});

test('a crash after the home Project was registered leaves exactly one home', async () => {
  const project = await store().createProject('Diomedes', store().homeFolder());
  expect(store().settings.home).toBe(null);
  expect(threadsOf(project.id)).toHaveLength(0);
  const home = await provision();
  expect(home.projectId).toBe(project.id);
  expect(await homeRows()).toHaveLength(1);
  expect(threadsOf(home.projectId)).toHaveLength(1);
  expect(await listed()).toEqual([]);
});

test('a crash after the home thread was persisted leaves exactly one home', async () => {
  const project = await store().createProject('Diomedes', store().homeFolder());
  const state = store().state(project.id);
  const stamped = now();
  const thread: Conversation = {
    id: identifier('C'),
    attachedTo: { kind: 'project', ref: project.id },
    turns: [],
    name: 'Diomedes',
    createdAt: stamped,
    updatedAt: stamped,
    taskId: null,
    helper: null,
    permission: 'show-first',
    mode: 'auto',
    engine: 'claude-code',
  };
  state.conversations.push(thread);
  await store().persist(state);
  expect(store().settings.home).toBe(null);
  const home = await provision();
  expect(home).toEqual({ projectId: project.id, threadId: thread.id });
  expect(await homeRows()).toHaveLength(1);
  expect(threadsOf(home.projectId)).toHaveLength(1);
});

test('a crash after the binding was saved leaves exactly one home', async () => {
  const home = await provision();
  await close();
  await open();
  expect(await readHome()).toEqual(home);
  expect(await provision()).toEqual(home);
  expect(await homeRows()).toHaveLength(1);
  expect(threadsOf(home.projectId)).toHaveLength(1);
});

test('the home Project is never listed, and is still enumerated for recovery after a restart', async () => {
  const home = await provision();
  const mine = await realProject();
  // The conversation uses Claude Code without the person configuring a thread.
  expect(threadsOf(home.projectId)[0]).toMatchObject({ engine: 'claude-code', mode: 'auto' });
  expect((await listed()).map((project) => project.id)).toEqual([mine.id]);
  // The filter is the route's, not the store's: startup recovery reads this enumeration.
  expect((await store().projects()).map((project) => project.id)).toContain(home.projectId);
  const first = await send(home, 'm-hello', 'Good morning');
  expect(first.answerText).toBe('answer:Good morning');
  expect(dispatches).toHaveLength(1);
  await close();
  await open();
  expect((await listed()).map((project) => project.id)).toEqual([mine.id]);
  expect((await store().projects()).map((project) => project.id)).toContain(home.projectId);
  // The home conversation's run came back: the same message reads back with no second call.
  expect(await send(home, 'm-hello', 'Good morning')).toEqual(first);
  expect(dispatches).toHaveLength(1);
});

test('a task create and a Work start aimed at the home Project are refused, and record nothing', async () => {
  const home = await provision();
  const task = await request(`/projects/${home.projectId}/tasks`, 'POST', { name: 'Order plates' });
  expect(task.status).toBe(409);
  expect(await task.text()).toContain('not a place work runs');
  const work = await request(`/projects/${home.projectId}/work/start`, 'POST', {
    taskId: 'anything',
    instruction: 'Order plates',
    sources: [],
    consent: true,
  });
  expect(work.status).toBe(409);
  const state = store().state(home.projectId);
  expect(state.tasks).toEqual([]);
  expect(state.sessions).toEqual([]);
  expect(state.history).toEqual([]);
});

test('from home an Automatic proposal naming no project needs a target, and one naming a project is proposed there', async () => {
  const home = await provision();
  const mine = await realProject();
  const untargeted = await send(home, 'm-act', 'ACT order the usual');
  expect(untargeted.outcome).toMatchObject({ status: 'not-started', reason: 'needs-target' });
  expect(store().state(home.projectId).tasks).toEqual([]);
  expect(store().state(mine.id).tasks).toEqual([]);
  const targeted = await send(home, 'm-target', `TARGET ${mine.id} order the usual`);
  expect(targeted.outcome).toMatchObject({
    status: 'proposed',
    projectId: mine.id,
    operationClass: 'write_internal',
  });
  // Home itself is never a target, even when the model names it.
  const athome = await send(home, 'm-home', `TARGET ${home.projectId} order the usual`);
  expect(athome.outcome).toMatchObject({
    status: 'not-started',
    reason: 'home-is-not-a-target',
  });
  expect(store().state(home.projectId).tasks).toEqual([]);
});

// Review r6, CD01-R-16. The two admission paths refused home, and the older direct route went
// round both. These cases hold the whole home Project still, not only its task and session lists.

/** Everything the older direct route could touch in the home Project. */
async function homeRecords(home: Binding) {
  const state = store().state(home.projectId);
  const thread = state.conversations.find((item) => item.id === home.threadId)!;
  return {
    tasks: state.tasks.length,
    sessions: state.sessions.length,
    history: state.history.length,
    plans: state.project.plans,
    threads: state.conversations.length,
    thread: [thread.mode, thread.engine, thread.turns.length],
    files: (await fs.readdir(store().homeFolder())).sort(),
  };
}
const direct = (projectId: string, threadId: string | undefined, patch: Record<string, unknown>) =>
  request(`/projects/${projectId}/ask`, 'POST', {
    ...(threadId ? { threadId } : {}),
    route: 'sample',
    text: 'Order plates',
    sources: [],
    consent: true,
    ...patch,
  });

test('R-16: the direct route is refused in the home Project for every mode, before it touches anything', async () => {
  const home = await provision();
  const before = await homeRecords(home);
  expect(before).toMatchObject({ tasks: 0, sessions: 0, thread: ['auto', 'claude-code', 0] });
  const requests: Record<string, unknown>[] = [
    { mode: 'build' },
    { mode: 'fix', failing: { text: 'The order total is wrong.' } },
    // Plan writes a file and a plans entry. Ask re-routes the thread it is given, and the home
    // conversation only runs on Claude Code, so either would damage home without starting Work.
    { mode: 'plan' },
    { mode: 'ask' },
  ];
  for (const patch of requests)
    for (const threadId of [home.threadId, undefined]) {
      const response = await direct(home.projectId, threadId, patch);
      expect([patch.mode, response.status]).toEqual([patch.mode, 409]);
      expect(await response.text()).toContain('does not take direct requests');
      expect(await homeRecords(home)).toEqual(before);
    }
  // The conversation itself is unharmed: its own route still answers.
  expect((await send(home, 'm-after', 'Good morning')).outcome).toEqual({ status: 'answered' });
  expect(dispatches).toHaveLength(1);
});

test('R-16: a native Build aimed at the home Project is refused before anything is sent', async () => {
  const home = await provision();
  await api('/settings', 'PUT', { services: { codex: true } });
  const before = await homeRecords(home);
  for (const mode of ['build', 'fix'])
    for (const threadId of [home.threadId, undefined]) {
      const response = await direct(home.projectId, threadId, {
        route: 'codex',
        mode,
        ...(mode === 'fix' ? { failing: { text: 'The order total is wrong.' } } : {}),
      });
      expect([mode, response.status]).toEqual([mode, 409]);
      expect(await homeRecords(home)).toEqual(before);
    }
  expect(nativeCalls).toBe(0);
});

test('R-16: no route makes a task in the home Project, so no Work start has one to run there', async () => {
  const home = await provision();
  // The one place a task is made refuses home, whoever asks.
  expect(() =>
    store().createTask(store().state(home.projectId), { name: 'Order plates' }),
  ).toThrow(/not a place work runs/);
  // A route that makes tasks through neither admission path: tasks found in a plan.
  await fs.writeFile(path.join(store().homeFolder(), 'Plan.md'), '# Plan\n\n- Order plates\n');
  const { found } = await api<{ found: TaskCandidate[] }>(
    `/projects/${home.projectId}/plans/find-tasks`,
    'POST',
    { path: 'Plan.md' },
  );
  expect(found).toHaveLength(1);
  const added = await request(`/projects/${home.projectId}/plans/add-tasks`, 'POST', {
    path: 'Plan.md',
    items: found,
  });
  expect(added.status).toBe(409);
  expect(store().state(home.projectId).tasks).toEqual([]);
  expect(await fs.readFile(path.join(store().homeFolder(), 'Plan.md'), 'utf8')).toBe(
    '# Plan\n\n- Order plates\n',
  );
});

test('R-16: an ordinary project keeps the direct route exactly as it was', async () => {
  const mine = await realProject();
  const response = await direct(mine.id, undefined, { mode: 'build' });
  expect(response.status).toBe(200);
  const state = store().state(mine.id);
  expect([state.tasks.length, state.sessions.length]).toEqual([1, 1]);
  expect(state.conversations.at(-1)).toMatchObject({ mode: 'build', engine: 'sample' });
  expect(store().createTask(state, { name: 'Count the linen' }).name).toBe('Count the linen');
});

// Review r7, CD01-R-17 and obligation O5. The reproducer is pasted as written.
test('R-17: the ordinary thread update cannot reroute home away from its conversation engine', async () => {
  const home = await provision();
  const threadPath = `/projects/${home.projectId}/threads/${home.threadId}`;
  const updated = await request(threadPath, 'PUT', { engine: 'sample' });
  const message = await request(`${threadPath}/messages`, 'POST', {
    commandId: 'm-r17',
    text: 'Good morning',
    mode: 'auto',
    sources: [],
    consent: true,
  });
  const state = store().state(home.projectId);
  expect({
    updateStatus: updated.status,
    messageStatus: message.status,
    engine: state.conversations.find((item) => item.id === home.threadId)!.engine,
    tasks: state.tasks.length,
    sessions: state.sessions.length,
  }).toEqual({
    updateStatus: 409,
    messageStatus: 200,
    engine: 'claude-code',
    tasks: 0,
    sessions: 0,
  });
  expect((await message.json()).outcome).toEqual({ status: 'answered' });
});

test('R-17: a refused home engine change is whole, and the conversation still answers after a restart', async () => {
  const home = await provision();
  const threadPath = `/projects/${home.projectId}/threads/${home.threadId}`;
  // Every field the update route can write. Loading a project fills an absent `requested`
  // with null on any thread, so the two spellings of "no choice" are read as one.
  const written = () => {
    const { name, mode, engine, permission, requested } = threadsOf(home.projectId)[0];
    return { name, mode, engine, permission, requested: requested ?? null };
  };
  const before = written();
  // One request that renames, narrows the Mode and re-routes: refused as one thing.
  const mixed = await request(threadPath, 'PUT', { name: 'Renamed', mode: 'ask', engine: 'codex' });
  expect(mixed.status).toBe(409);
  expect(await mixed.text()).toContain('runs on Claude Code');
  // An engine nobody offers is refused the same way, not half applied.
  expect((await request(threadPath, 'PUT', { name: 'Renamed', engine: 'nonsense' })).status).toBe(409);
  expect(written()).toEqual(before);
  await close();
  await open();
  expect(written()).toEqual(before);
  expect(await readHome()).toEqual(home);
  expect((await send(home, 'm-after-restart', 'Good morning')).outcome).toEqual({
    status: 'answered',
  });
});

test('R-17: home keeps every control that is not its engine, and an ordinary project keeps them all', async () => {
  const home = await provision();
  const threadPath = `/projects/${home.projectId}/threads/${home.threadId}`;
  // Answer only and Plan only are the conversation's own restrictions: narrowing is allowed.
  for (const mode of ['ask', 'plan', 'auto'])
    expect((await api<Conversation>(threadPath, 'PUT', { mode })).mode).toBe(mode);
  expect((await api<Conversation>(threadPath, 'PUT', { name: 'Morning desk' })).name).toBe(
    'Morning desk',
  );
  // Naming the engine it already runs on changes nothing and is not a refusal.
  expect((await api<Conversation>(threadPath, 'PUT', { engine: 'claude-code' })).engine).toBe(
    'claude-code',
  );
  expect(await readHome()).toEqual(home);
  expect((await send(home, 'm-still', 'Good morning')).outcome).toEqual({ status: 'answered' });

  const mine = await realProject();
  const thread = await api<Conversation>(`/projects/${mine.id}/threads`, 'POST', {});
  const rerouted = await api<Conversation>(`/projects/${mine.id}/threads/${thread.id}`, 'PUT', {
    name: 'Orders',
    engine: 'sample',
  });
  expect([rerouted.name, rerouted.engine]).toEqual(['Orders', 'sample']);
});
