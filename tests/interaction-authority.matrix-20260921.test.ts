import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import { EngineError } from '../server/engines/process';
import type { PersistentTextAdapter, TextRequest } from '../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import type { ClaudeSessionRuns } from '../server/harness/claude-session-run';
import type { HarnessHost } from '../server/harness/host';
import type { HarnessRun } from '../shared/harness';
import { routeContractFor } from '../server/harness/route-contract';
import { localHarnessPrincipal } from '../server/harness/bridge';
import { hash, type Store } from '../server/store';
import { conversationCommandIds } from '../server/interaction-admission';
import type { MessageResult } from '../server/interaction-service';
import { DECISION_FORMAT } from '../server/interaction-turn';
import { MODES } from '../server/modes';
import type { Project, Conversation } from '../shared/types';

// The conversation seam through the real app over HTTP: the real Store, RunService, session
// driver, task admission and Work admission, with only the provider faked. No live model is
// needed to prove these boundaries. `close()` then `open()` over the same data directory
// verifies restart recovery of a deliberately missing parent phase, not an abrupt OS crash.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'claude-fixture';
const accountRoute = 'claude-code:claude.ai';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;
let dispatches: TextRequest[];
let opened: string[];
let lockFreeDuringTurn: boolean[];
let afterPreview: ((turn: TextRequest) => Promise<void>) | null = null;
let releaseInterruptedTurn: (() => void) | null = null;

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
const driver = () => app.locals.harness.claudeSessions as ClaudeSessionRuns;

/**
 * The fake model. It reads the issued identity off the last line, as the instructions tell a
 * real one to, and answers by script: a message starting with ACT proposes work, FORGE names
 * another message's identity, and anything else is an ordinary answer.
 */
function scripted(prompt: string) {
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(prompt)?.[1];
  const text = prompt.split('\n\n[[diomedes')[0];
  const block = (sourceMessageId: string, patch: Record<string, unknown> = {}) =>
    '```diomedes-decision\n' +
    JSON.stringify({
      source_message_id: sourceMessageId,
      disposition: 'act',
      requested_project_id: null,
      operation_class: 'write_internal',
      source_refs: [],
      target_run_id: null,
      question: null,
      public_summary: `Do this: ${text}`,
      ...patch,
    }) +
    '\n```';
  if (text.startsWith('ACT') && issued) return `I can start that.\n\n${block(issued)}`;
  if (text.startsWith('FORGE')) return `Sure.\n\n${block('sm.' + 'f'.repeat(32))}`;
  return `answer:${text}`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-interaction-'));
  dispatches = [];
  opened = [];
  afterPreview = null;
  releaseInterruptedTurn = null;
  lockFreeDuringTurn = [];
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
      opened.push(input.instructions);
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
      let interrupted = false;
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
          interrupted = false;
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          dispatches.push(turn);
          // No Store lock is held while the provider runs: the lock is free to take right now.
          lockFreeDuringTurn.push(
            await Promise.race([
              store().locked(async () => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
            ]),
          );
          const text = scripted(turn.prompt);
          turn.onDelta?.(text);
          await afterPreview?.(turn);
          if (interrupted) throw new EngineError('CANCELLED', 'The fixture acknowledged interruption.');
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
          if (!releaseInterruptedTurn) throw new Error('No held turn in this fixture');
          interrupted = true;
          checkpoint = { ...checkpoint, state: 'idle' };
          await options.onCheckpoint(checkpoint, signal);
          releaseInterruptedTurn();
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
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const state = store().state(project.id);
  // The conversation runs on the fixture provider. Work in this project runs on the scripted
  // sample worker, so a Work start here needs no provider at all.
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

const messages = () => `/projects/${project.id}/threads/${thread.id}/messages`;
const message = (commandId: string, text: string, patch: Record<string, unknown> = {}) => ({
  commandId,
  text,
  mode: 'auto',
  sources: [],
  consent: true,
  ...patch,
});
const send = (commandId: string, text: string, patch: Record<string, unknown> = {}) =>
  api<MessageResult>(messages(), 'POST', message(commandId, text, patch));
const turnsOf = () =>
  store()
    .state(project.id)
    .conversations.find((item) => item.id === thread.id)!
    .turns.map((turn) => turn.text);
const phaseNames = async (result: { runId: string; sourceMessageId: string }) =>
  (await driver().phases(project.id, result.runId, result.sourceMessageId)).map(
    (phase: { phase: string }) => phase.phase,
  );
const workFor = (sourceMessageId: string) => {
  const ids = conversationCommandIds(sourceMessageId);
  const state = store().state(project.id);
  return {
    tasks: state.tasks.filter((task) => task.creationReceipt?.commandId === ids.taskCommandId),
    sessions: state.sessions.filter((session) => session.receipt?.commandId === ids.workCommandId),
  };
};
async function select(commandId: string, proposalDigest: string, projectId = project.id) {
  return request(`${messages()}/${commandId}/select`, 'POST', {
    proposalDigest,
    projectId,
    consent: true,
  });
}


const cancelThroughHttp = (runId: string) =>
  api('/projects/' + project.id + '/harness/runs/' + runId + '/cancel', 'POST', { reason: 'Review barrier' });
const sourceSnapshot = (runId: string) => driver().get(project.id, runId);

test('matrix: HTTP cancellation after work-input preserves the task and admits no Work', async () => {
  const proposed = await send('matrix-http-cancel', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  const runtime = driver();
  const original = runtime.record.bind(runtime);
  runtime.record = async (...args: Parameters<typeof original>) => {
    await original(...args);
    if (args[2].some((phase) => phase.phase === 'work-input')) await cancelThroughHttp(proposed.runId);
  };
  try {
    await select('matrix-http-cancel', proposed.outcome.proposalDigest);
    expect((await sourceSnapshot(proposed.runId)).state).toBe('cancelled');
    expect(workFor(proposed.sourceMessageId).tasks).toHaveLength(1);
    expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(0);
  } finally { runtime.record = original; }
});

for (const mode of ['ask', 'plan'] as const) {
  test('matrix: real ' + mode + ' message after work-input prevents new Work', async () => {
    const proposed = await send('matrix-mode-' + mode, 'ACT create an owned draft');
    if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
    const runtime = driver();
    const original = runtime.record.bind(runtime);
    runtime.record = async (...args: Parameters<typeof original>) => {
      await original(...args);
      if (args[2].some((phase) => phase.phase === 'work-input'))
        await send('matrix-narrow-' + mode, 'Only respond under the selected mode', { mode });
    };
    try {
      await select('matrix-mode-' + mode, proposed.outcome.proposalDigest);
      expect(store().state(project.id).conversations.find((item) => item.id === thread.id)!.mode).toBe(mode);
      expect(workFor(proposed.sourceMessageId).tasks).toHaveLength(1);
      expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(0);
    } finally { runtime.record = original; }
  });
}

test('matrix: concurrent identical selections converge on one receipt', async () => {
  const proposed = await send('matrix-duplicate', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  const runtime = driver();
  const original = runtime.record.bind(runtime);
  let release!: () => void;
  const bothSelected = new Promise<void>((resolve) => { release = resolve; });
  let arrivals = 0;
  runtime.record = async (...args: Parameters<typeof original>) => {
    await original(...args);
    if (args[2].some((phase) => phase.phase === 'action-selected')) {
      arrivals++;
      if (arrivals === 2) release();
      await bothSelected;
    }
  };
  try {
    const responses = await Promise.all([
      select('matrix-duplicate', proposed.outcome.proposalDigest),
      select('matrix-duplicate', proposed.outcome.proposalDigest).finally(release),
    ]);
    const results = await Promise.all(responses.map((response) => response.json() as Promise<MessageResult>));
    console.log('DUPLICATE_SELECTION', JSON.stringify({
      statuses: responses.map((response) => response.status), results,
      tasks: workFor(proposed.sourceMessageId).tasks.length,
      sessions: workFor(proposed.sourceMessageId).sessions.length,
    }));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(results[0].outcome.status).toBe('started');
    expect(results[0].outcome).toEqual(results[1].outcome);
    expect(workFor(proposed.sourceMessageId).tasks).toHaveLength(1);
    expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(1);
    expect(dispatches).toHaveLength(1);
  } finally { release(); runtime.record = original; }
});

test('matrix: admission first preserves its receipt across cancel, narrowing and observational replay', async () => {
  const proposed = await send('matrix-admission-first', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  const started = await (await select('matrix-admission-first', proposed.outcome.proposalDigest)).json() as MessageResult;
  expect(started.outcome.status).toBe('started');
  await cancelThroughHttp(proposed.runId);
  await api('/projects/' + project.id + '/threads/' + thread.id, 'PUT', { mode: 'ask' });
  const before = await sourceSnapshot(proposed.runId);
  const calls = dispatches.length;
  const read = await api<MessageResult>(messages() + '/matrix-admission-first');
  const replay = await send('matrix-admission-first', 'ACT create an owned draft');
  expect(read.outcome).toEqual(started.outcome);
  expect(replay.outcome).toEqual(started.outcome);
  expect(await sourceSnapshot(proposed.runId)).toEqual(before);
  expect(dispatches).toHaveLength(calls);
  expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(1);
  const mismatch = await request(messages(), 'POST', message('matrix-admission-first', 'ACT different intent'));
  expect(mismatch.status).toBe(409);
  expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(1);
});

test('matrix: another project or changed selected target cannot read or admit this message', async () => {
  const proposed = await send('matrix-scope', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  const other = await api<Project>('/projects', 'POST', { name: 'Other review project' });
  const otherThread = await api<Conversation>('/projects/' + other.id + '/threads', 'POST', {});
  const elsewhere = '/projects/' + other.id + '/threads/' + otherThread.id + '/messages/matrix-scope';
  expect((await request(elsewhere)).status).toBe(404);
  expect((await select('matrix-scope', proposed.outcome.proposalDigest, other.id)).status).toBe(409);
  expect((await select('matrix-scope', 'f'.repeat(64))).status).toBe(409);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  expect(store().state(other.id).sessions).toHaveLength(0);
});

test('matrix: an identical selection retry returns its committed receipt after authority is withdrawn', async () => {
  const proposed = await send('matrix-select-receipt', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  const first = await select('matrix-select-receipt', proposed.outcome.proposalDigest);
  expect(first.status).toBe(200);
  const started = await first.json() as MessageResult;
  expect(started.outcome.status).toBe('started');
  await cancelThroughHttp(proposed.runId);
  await api('/projects/' + project.id + '/threads/' + thread.id, 'PUT', { mode: 'ask' });
  const before = await sourceSnapshot(proposed.runId);
  const calls = dispatches.length;
  const replay = await select('matrix-select-receipt', proposed.outcome.proposalDigest);
  expect(replay.status).toBe(200);
  expect((await replay.json() as MessageResult).outcome).toEqual(started.outcome);
  expect(await sourceSnapshot(proposed.runId)).toEqual(before);
  expect(dispatches).toHaveLength(calls);
  expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(1);
});

test('matrix: a child command already bound to different task intent must conflict', async () => {
  const proposed = await send('matrix-child-intent', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  const ids = conversationCommandIds(proposed.sourceMessageId);
  await api('/projects/' + project.id + '/tasks', 'POST', {
    protocolVersion: 1,
    commandId: ids.taskCommandId,
    name: 'A different task',
    description: 'Unrelated previously bound intent',
    owner: 'you',
  });
  const before = workFor(proposed.sourceMessageId);
  expect(before.tasks).toHaveLength(1);
  const response = await select('matrix-child-intent', proposed.outcome.proposalDigest);
  console.log('CHILD_INTENT_COLLISION', JSON.stringify({
    status: response.status,
    tasks: workFor(proposed.sourceMessageId).tasks.length,
    sessions: workFor(proposed.sourceMessageId).sessions.length,
  }));
  expect(response.status).toBe(409);
  expect(workFor(proposed.sourceMessageId).tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
  expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(0);
});

test('matrix: repeated polling during partial output is observational and unfinished', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let markPreview!: () => void;
  const previewed = new Promise<void>((resolve) => { markPreview = resolve; });
  afterPreview = async () => { markPreview(); await held; };
  const sending = send('matrix-partial', 'Partial result');
  try {
    await previewed;
    const runId = store().state(project.id).conversations.find((item) => item.id === thread.id)!.lineages!.at(-1)!.runId;
    const before = await sourceSnapshot(runId);
    for (let n = 0; n < 3; n++) {
      const read = await api<MessageResult>(messages() + '/matrix-partial');
      expect(read.outcome.status).toBe('unresolved');
      expect(read.answerText).toBeNull();
      expect(read.interrupted).toBe(false);
    }
    expect(await sourceSnapshot(runId)).toEqual(before);
    expect(dispatches).toHaveLength(1);
    expect(store().state(project.id).sessions).toHaveLength(0);
  } finally { release(); await sending; }
  expect((await api<MessageResult>(messages() + '/matrix-partial')).outcome.status).toBe('answered');
});

test('matrix: restart after child admission before receipt phase never creates another child', async () => {
  const proposed = await send('matrix-child-gap', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  const runtime = driver();
  const original = runtime.record.bind(runtime);
  runtime.record = async (...args: Parameters<typeof original>) => {
    if (args[2].some((phase) => phase.phase === 'work-receipt')) throw new Error('Synthetic stop before receipt phase');
    return original(...args);
  };
  const response = await select('matrix-child-gap', proposed.outcome.proposalDigest);
  runtime.record = original;
  expect(response.status).toBe(500);
  const child = workFor(proposed.sourceMessageId).sessions[0];
  expect(child).toBeDefined();
  await close();
  await open();
  const resumed = await send('matrix-child-gap', 'ACT create an owned draft');
  expect(resumed.outcome).toMatchObject({ status: 'started', sessionId: child.id });
  expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(1);
  expect(dispatches).toHaveLength(1);
});

test('matrix: polling preserves a durably acknowledged interruption', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let markPreview!: () => void;
  const previewed = new Promise<void>((resolve) => { markPreview = resolve; });
  afterPreview = async () => { markPreview(); await held; };
  releaseInterruptedTurn = release;
  const sending = send('matrix-interrupted', 'An interrupted answer');
  try {
    await previewed;
    const runId = store().state(project.id).conversations.find((item) => item.id === thread.id)!.lineages!.at(-1)!.runId;
    await api('/projects/' + project.id + '/claude-sessions/' + runId + '/interrupt', 'POST', { commandId: 'matrix-interrupt-control' });
    const result = await sending;
    expect(result.interrupted).toBe(true);
    expect(result.answerText).toBeNull();
    const before = await sourceSnapshot(runId);
    const read = await api<MessageResult>(messages() + '/matrix-interrupted');
    expect(read.runId).toBe(result.runId);
    expect(read.commandId).toBe(result.commandId);
    expect(read.outcome.status).toBe('unresolved');
    expect(read.interrupted).toBe(true);
    expect(await sourceSnapshot(runId)).toEqual(before);
    expect(dispatches).toHaveLength(1);
  } finally { release(); await sending; releaseInterruptedTurn = null; }
});

test('matrix: late cancelled output cannot overwrite a later conversation generation', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let markPreview!: () => void;
  const previewed = new Promise<void>((resolve) => { markPreview = resolve; });
  afterPreview = async (turn) => {
    if (turn.requestId === 'matrix-late-old') { markPreview(); await held; }
  };
  const sending = request(messages(), 'POST', message('matrix-late-old', 'Old generation'));
  try {
    await previewed;
    const oldRun = store().state(project.id).conversations.find((item) => item.id === thread.id)!.lineages!.at(-1)!.runId;
    await cancelThroughHttp(oldRun);
    const next = await send('matrix-late-new', 'New generation', { mode: 'ask' });
    expect(next.runId).not.toBe(oldRun);
    expect(next.answerText).toBe('answer:New generation');
  } finally { release(); await sending; }
  expect(turnsOf()).not.toContain('answer:Old generation');
  expect(store().state(project.id).conversations.find((item) => item.id === thread.id)!.mode).toBe('ask');
});

test('matrix: a concurrent provider failure after liveness check must prevent new Work', async () => {
  const proposed = await send('matrix-prior-selection', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected proposal');
  let releaseProvider!: () => void;
  const held = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let markPreview!: () => void;
  const previewed = new Promise<void>((resolve) => { markPreview = resolve; });
  afterPreview = async (turn) => {
    if (turn.requestId === 'matrix-provider-error') {
      markPreview();
      await held;
      throw new Error('Synthetic provider outcome is unknown');
    }
  };
  const failing = request(messages(), 'POST', message('matrix-provider-error', 'A second turn'));
  const runtime = driver();
  const original = runtime.assertLive.bind(runtime);
  // Run persistence notifies before HostRunService.afterStep flushes Store projections.
  // Waiting for the HTTP response while the admission holds Store would deadlock that flush.
  let markTerminal!: () => void;
  let failTerminal!: (error: unknown) => void;
  const terminalSaved = new Promise<void>((resolve, reject) => {
    markTerminal = resolve;
    failTerminal = reject;
  });
  const unsubscribe = (app.locals.harness as HarnessHost).subscribe(proposed.runId, () => {
    void sourceSnapshot(proposed.runId).then((run) => {
      if (run.state === 'reconcile_required') markTerminal();
    }, failTerminal);
  }, () => failTerminal(new Error('The fixture closed before the source transition')));
  let checks = 0;
  try {
    await previewed;
    runtime.assertLive = async (...args: Parameters<typeof original>) => {
      await original(...args);
      if (++checks === 2) {
        releaseProvider();
        await terminalSaved;
        expect((await sourceSnapshot(proposed.runId)).state).toBe('reconcile_required');
      }
    };
    const response = await select('matrix-prior-selection', proposed.outcome.proposalDigest);
    const work = workFor(proposed.sourceMessageId);
    console.log('PROVIDER_FAILURE_ADMISSION', JSON.stringify({
      status: response.status, checks, source: (await sourceSnapshot(proposed.runId)).state,
      tasks: work.tasks.length, sessions: work.sessions.length,
    }));
    expect(checks).toBe(2);
    expect(work.tasks).toHaveLength(1);
    expect(work.sessions).toHaveLength(0);
  } finally { unsubscribe(); runtime.assertLive = original; releaseProvider(); expect((await failing).status).not.toBe(200); }
});
