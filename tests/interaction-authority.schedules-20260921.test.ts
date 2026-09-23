import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { PersistentTextAdapter } from '../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import type { ClaudeSessionRuns, InteractionPhase } from '../server/harness/claude-session-run';
import type { HarnessHost } from '../server/harness/host';
import { localHarnessPrincipal } from '../server/harness/bridge';
import { routeContractFor } from '../server/harness/route-contract';
import { hash, identifier, now, type Store } from '../server/store';
import { conversationCommandIds } from '../server/interaction-admission';
import type { MessageResult } from '../server/interaction-service';
import type { Conversation, Project, Session } from '../shared/types';

// Executed schedules for the guards the review's matrix and the repair file leave standing:
// the source run's queue held across a child commit, the prepared scope revalidated inside
// the guard on both Work paths, a lineage retired between the selection's pre-check and the
// commit, and the Work route a message pinned. The same seam, the same fake provider, and
// the real Store, RunService, task admission and both Work admissions.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'claude-fixture';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;

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
const store = () => app.locals.store as Store;
const driver = () => app.locals.harness.claudeSessions as ClaudeSessionRuns;
const runs = () => (app.locals.harness as HarnessHost).runs;

/** The same scripted model the review uses: ACT proposes work, anything else answers. */
function scripted(prompt: string) {
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(prompt)?.[1];
  const text = prompt.split('\n\n[[diomedes')[0];
  if (!text.startsWith('ACT') || !issued) return `answer:${text}`;
  return (
    'I can start that.\n\n```diomedes-decision\n' +
    JSON.stringify({
      source_message_id: issued,
      disposition: 'act',
      requested_project_id: null,
      operation_class: 'write_internal',
      source_refs: [],
      target_run_id: null,
      question: null,
      public_summary: `Do this: ${text}`,
    }) +
    '\n```'
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-interaction-schedules-'));
  const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute: 'claude-code:claude.ai',
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
  const service = new EngineService(path.join(root, 'engines'), {
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
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    // The native Work route is driven by the codex schedules below; no engine is launched.
    nativeGenerator: async () => ({
      text: JSON.stringify({ summary: 'Nothing to change', changes: [] }),
      model: 'test-model',
    }),
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['claude-code'], documents: [],
    shareConversationHistory: true, shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const state = store().state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

const messages = () => `/projects/${project.id}/threads/${thread.id}/messages`;
const send = (commandId: string, text: string) =>
  api<MessageResult>(messages(), 'POST', {
    commandId,
    text,
    mode: 'auto',
    sources: [],
    consent: true,
  });
const select = (commandId: string, proposalDigest: string) =>
  request(`${messages()}/${commandId}/select`, 'POST', {
    proposalDigest,
    projectId: project.id,
    consent: true,
  });
const workFor = (sourceMessageId: string) => {
  const ids = conversationCommandIds(sourceMessageId);
  const state = store().state(project.id);
  return {
    tasks: state.tasks.filter((task) => task.creationReceipt?.commandId === ids.taskCommandId),
    sessions: state.sessions.filter((session) => session.receipt?.commandId === ids.workCommandId),
  };
};
const phasesOf = (result: { runId: string; sourceMessageId: string }) =>
  driver().phases(project.id, result.runId, result.sourceMessageId);
const refusalIn = async (result: { runId: string; sourceMessageId: string }) =>
  (await phasesOf(result)).find((phase) => phase.phase === 'work-refused')?.body as
    | { status: number; message: string }
    | undefined;
/** A proposal this message can still start, or the test has nothing to schedule against. */
async function proposal(commandId: string) {
  const proposed = await send(commandId, 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  return { ...proposed, proposalDigest: proposed.outcome.proposalDigest };
}
/** Puts the target project's own Work on the native route, as a person's Start there would. */
async function useNativeRoute() {
  // The conversation keeps the engine it already has; only the Work route changes.
  await api('/settings', 'PUT', { services: { ...store().settings.services, codex: true } });
  const state = store().state(project.id);
  state.project.ai = { engine: 'codex', model: null };
  await store().persist(state);
}
/** A session another admission committed, in the shape the sample Work path writes one. */
const competingSession = (taskId: string): Session => ({
  id: identifier('S'),
  taskId,
  state: 'working',
  startedAt: now(),
  endedAt: null,
  sample: true,
  permission: 'show-first',
  log: [],
  entryIds: [],
  needId: null,
  engine: { name: 'Another worker', model: null, worker: 1, branch: null, context: null, events: 0 },
});

// Boundary 3 asks the guard to "hold the existing source-run queue through the child's
// durable admission commit". The matrix makes the Runtime's terminal state durable before
// the fence is entered, so its terminal check alone answers that schedule. This one asks for
// the transition while the commit is open.
test('a terminal transition asked for inside the child commit lands after it, never during', async () => {
  const proposed = await proposal('schedule-queue-hold');
  const ids = conversationCommandIds(proposed.sourceMessageId);
  const runtime = driver();
  const record = runtime.record.bind(runtime);
  const persist = store().persist.bind(store());
  let reached!: () => void;
  const insideCommit = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Armed when the Work input is saved, and fired on the one persist that carries this
  // message's own admitted session: that persist runs inside the fence callback, so the
  // barrier holds the child commit open rather than standing before or after it.
  let armed = false;
  runtime.record = async (...args: Parameters<typeof record>) => {
    await record(...args);
    if (args[2].some((phase) => phase.phase === 'work-input')) armed = true;
  };
  store().persist = async (state) => {
    if (
      armed &&
      state.project.id === project.id &&
      state.sessions.some((session) => session.receipt?.commandId === ids.workCommandId)
    ) {
      armed = false;
      reached();
      await held;
    }
    return persist(state);
  };
  let settled = false;
  let cancelling: Promise<void> | undefined;
  try {
    const selecting = select('schedule-queue-hold', proposed.proposalDigest);
    await insideCommit;
    const during = await driver().get(project.id, proposed.runId);
    // The Runtime primitive every terminal transition takes: cancel, a failed step commit,
    // a denial and startup recovery all enter this run's writer queue. The HTTP cancel route
    // reaches it only after Store.locked, which this admission is holding, so a cancellation
    // asked for through HTTP here would wait on Store and prove nothing about the queue.
    cancelling = runs()
      .cancel(proposed.runId, 'Cancelled while the child was committing', localHarnessPrincipal(project.id))
      .then(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // It has not landed: it is waiting on the queue the fence is holding, and nothing about
    // the source run has changed since it was asked for. The run is parked `waiting` for its
    // next command here, which is the live, non-terminal state the fence admits against.
    expect(settled).toBe(false);
    expect(await driver().get(project.id, proposed.runId)).toEqual(during);
    release();
    const response = await selecting;
    await cancelling;
    // What the guard is designed to guarantee, in the handoff's own words at boundary 4:
    // "Cancellation/narrowing first means no new prohibited child; child commit first
    // preserves that child's identity." This schedule is the second half. The commit was
    // first, so the child keeps its identity and the conversation settles after it. The
    // receipt phase cannot be written on a settled run, so the selection's own response
    // says 409 while the durable record reads as started.
    console.log(
      'QUEUE_HOLD_ORDER',
      JSON.stringify({ status: response.status, during: during.state, settled }),
    );
    expect(settled).toBe(true);
    expect((await driver().get(project.id, proposed.runId)).state).toBe('cancelled');
    const admitted = workFor(proposed.sourceMessageId).sessions;
    expect(admitted).toHaveLength(1);
    expect(admitted[0].receipt?.admittedAt).toBeTruthy();
    const read = await api<MessageResult>(`${messages()}/schedule-queue-hold`);
    expect(read.outcome).toMatchObject({ status: 'started', sessionId: admitted[0].id });
  } finally {
    release();
    runtime.record = record;
    store().persist = persist;
    await cancelling?.catch(() => undefined);
  }
});

test('a competing session admitted after the sample Work path prepared refuses the start', async () => {
  const proposed = await proposal('schedule-work-scope');
  const runtime = driver();
  const record = runtime.record.bind(runtime);
  const snapshot = store().snapshot.bind(store());
  const competing = competingSession(
    (await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: 'Another job' })).id,
  );
  // The sample Work path takes its snapshot after the in-progress check and before the guard.
  // Another admission committing there is what the revalidation inside the guard must see.
  let armed = false;
  runtime.record = async (...args: Parameters<typeof record>) => {
    await record(...args);
    if (args[2].some((phase) => phase.phase === 'work-input')) armed = true;
  };
  store().snapshot = async (...args: Parameters<typeof snapshot>) => {
    const result = await snapshot(...args);
    if (armed) {
      armed = false;
      const state = store().state(project.id);
      state.sessions.push(competing);
      await store().persist(state);
    }
    return result;
  };
  try {
    const response = await select('schedule-work-scope', proposed.proposalDigest);
    expect(response.status).toBe(200);
    expect((await response.json()) as MessageResult).toMatchObject({
      outcome: { status: 'not-started', reason: 'refused' },
    });
    expect(await refusalIn(proposed)).toMatchObject({
      status: 409,
      message: 'This project already has work in progress.',
    });
    // Nothing was persisted for the refused session: the one session here is the competitor's,
    // and the task this message made carries no work.
    const state = store().state(project.id);
    expect(state.sessions.map((session) => session.id)).toEqual([competing.id]);
    const work = workFor(proposed.sourceMessageId);
    expect(work.sessions).toEqual([]);
    expect(work.tasks).toHaveLength(1);
    expect(work.tasks[0].sessionIds).toEqual([]);
    expect(work.tasks[0].state).toBe('todo');
  } finally {
    runtime.record = record;
    store().snapshot = snapshot;
  }
});

test('the native Work path admits a session through the conversation guard', async () => {
  await useNativeRoute();
  const proposed = await proposal('schedule-native-control');
  const response = await select('schedule-native-control', proposed.proposalDigest);
  expect(response.status).toBe(200);
  expect(((await response.json()) as MessageResult).outcome.status).toBe('started');
  const admitted = workFor(proposed.sourceMessageId).sessions;
  expect(admitted).toHaveLength(1);
  expect(admitted[0].sample).toBe(false);
  expect(admitted[0].route).toBe('codex');
  expect(admitted[0].receipt?.route).toBe('codex');
});

/**
 * Runs `change` inside the native Work path's own preparation, after its checks and before
 * the guard. Three clocks keep it there and nowhere else: the Work input is saved, then the
 * child admission reads the targetable projects, and the folder check after that is the
 * native path's own. Returns what puts the seam back.
 */
function duringNativePreparation(change: () => Promise<void>) {
  const runtime = driver();
  const record = runtime.record.bind(runtime);
  const projects = store().projects.bind(store());
  const checkFolder = store().checkFolder.bind(store());
  let stage: 'idle' | 'input' | 'context' = 'idle';
  runtime.record = async (...args: Parameters<typeof record>) => {
    await record(...args);
    if (args[2].some((phase) => phase.phase === 'work-input')) stage = 'input';
  };
  store().projects = async () => {
    const result = await projects();
    if (stage === 'input') stage = 'context';
    return result;
  };
  store().checkFolder = async (...args: Parameters<typeof checkFolder>) => {
    const result = await checkFolder(...args);
    if (stage === 'context') {
      stage = 'idle';
      await change();
    }
    return result;
  };
  return () => {
    runtime.record = record;
    store().projects = projects;
    store().checkFolder = checkFolder;
  };
}

test('a task removed after the native Work path prepared refuses the start', async () => {
  await useNativeRoute();
  const proposed = await proposal('schedule-native-task');
  const restore = duringNativePreparation(async () => {
    const state = store().state(project.id);
    const created = workFor(proposed.sourceMessageId).tasks[0];
    state.tasks.splice(
      state.tasks.findIndex((task) => task.id === created.id),
      1,
    );
    await store().persist(state);
  });
  try {
    const response = await select('schedule-native-task', proposed.proposalDigest);
    expect(response.status).toBe(200);
    expect((await response.json()) as MessageResult).toMatchObject({
      outcome: { status: 'not-started', reason: 'refused' },
    });
    expect(await refusalIn(proposed)).toMatchObject({
      status: 404,
      message: 'This task was not found.',
    });
    // Nothing was persisted for the refused session: no session, and none of the entries the
    // native admission writes inside the guard.
    const state = store().state(project.id);
    expect(state.sessions).toEqual([]);
    expect(state.history.filter((entry) => entry.kind === 'work-admitted')).toEqual([]);
    expect(state.history.filter((entry) => entry.kind === 'instructions-sent')).toEqual([]);
  } finally {
    restore();
  }
});

test('a competing session admitted after the native Work path prepared refuses the start', async () => {
  await useNativeRoute();
  const proposed = await proposal('schedule-native-session');
  const competing = competingSession(
    (await api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { name: 'Another job' })).id,
  );
  const restore = duringNativePreparation(async () => {
    const state = store().state(project.id);
    state.sessions.push(competing);
    await store().persist(state);
  });
  try {
    const response = await select('schedule-native-session', proposed.proposalDigest);
    expect(response.status).toBe(200);
    expect((await response.json()) as MessageResult).toMatchObject({
      outcome: { status: 'not-started', reason: 'refused' },
    });
    expect(await refusalIn(proposed)).toMatchObject({
      status: 409,
      message: 'This project already has work in progress.',
    });
    const state = store().state(project.id);
    expect(state.sessions.map((session) => session.id)).toEqual([competing.id]);
    expect(state.history.filter((entry) => entry.kind === 'work-admitted')).toEqual([]);
    const work = workFor(proposed.sourceMessageId);
    expect(work.sessions).toEqual([]);
    expect(work.tasks[0].sessionIds).toEqual([]);
    expect(work.tasks[0].state).toBe('todo');
  } finally {
    restore();
  }
});

test('a lineage retired between the selection pre-check and the commit refuses the child', async () => {
  const proposed = await proposal('schedule-retired');
  const runtime = driver();
  const record = runtime.record.bind(runtime);
  // The selection's own admission check has already passed when the choice is saved. Retiring
  // the lineage here is the mutation `resolve` makes when a new generation replaces this one:
  // the run itself is untouched, so the liveness check before the commit still passes.
  runtime.record = async (...args: Parameters<typeof record>) => {
    await record(...args);
    if (args[2].some((phase) => phase.phase === 'action-selected')) {
      const state = store().state(project.id);
      const conversation = state.conversations.find((item) => item.id === thread.id)!;
      conversation.lineages!.find((item) => item.runId === proposed.runId)!.retired = 'scope-change';
      await store().persist(state);
    }
  };
  try {
    const response = await select('schedule-retired', proposed.proposalDigest);
    expect(response.status).toBe(200);
    expect((await response.json()) as MessageResult).toMatchObject({
      outcome: { status: 'not-started', reason: 'refused' },
    });
    expect((await driver().get(project.id, proposed.runId)).state).not.toBe('cancelled');
    const refused = (await phasesOf(proposed)).find(
      (phase: InteractionPhase) => phase.phase === 'task-refused',
    );
    expect(refused?.body).toMatchObject({
      status: 409,
      message: 'This conversation moved on before this was started.',
    });
    expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  } finally {
    runtime.record = record;
  }
});

test('a retry after the target project engine changed starts the route this message pinned', async () => {
  const proposed = await proposal('schedule-route-pin');
  const runtime = driver();
  const record = runtime.record.bind(runtime);
  // The first attempt saves the Work input and stops before the Work is admitted.
  runtime.record = async (...args: Parameters<typeof record>) => {
    await record(...args);
    if (args[2].some((phase) => phase.phase === 'work-input'))
      throw new Error('Synthetic stop after the Work input phase');
  };
  const first = await select('schedule-route-pin', proposed.proposalDigest);
  runtime.record = record;
  expect(first.status).toBe(500);
  expect(workFor(proposed.sourceMessageId).tasks).toHaveLength(1);
  expect(workFor(proposed.sourceMessageId).sessions).toEqual([]);
  // The person changes the project's engine before retrying. The route this message already
  // sent is the one it sends again, so the retry reaches the work it decided on.
  const state = store().state(project.id);
  state.project.ai = { engine: 'codex', model: null };
  await store().persist(state);
  const retry = await select('schedule-route-pin', proposed.proposalDigest);
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as MessageResult).outcome.status).toBe('started');
  const admitted = workFor(proposed.sourceMessageId).sessions;
  expect(admitted).toHaveLength(1);
  expect(admitted[0].sample).toBe(true);
  expect(admitted[0].receipt?.route).toBe('sample');
});
