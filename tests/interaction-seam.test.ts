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
import type { ClaudeSessionRuns } from '../server/harness/claude-session-run';
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
// needed to prove these boundaries. `close()` then `open()` over the same data directory is a
// crash and restart.

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
          // No Store lock is held while the provider runs: the lock is free to take right now.
          lockFreeDuringTurn.push(
            await Promise.race([
              store().locked(async () => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
            ]),
          );
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

test('C01: a greeting is answered and creates nothing', async () => {
  const hello = await send('m-hello', 'Good morning');
  expect(hello.answerText).toBe('answer:Good morning');
  expect(hello.outcome).toEqual({ status: 'answered' });
  expect(await phaseNames(hello)).toEqual(['decision']);
  expect(workFor(hello.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  expect(turnsOf()).toEqual(['Good morning', 'answer:Good morning']);
  expect(lockFreeDuringTurn).toEqual([true]);
  // The identity line went to the model and is nowhere in the transcript.
  expect(dispatches[0].prompt).toContain('[[diomedes source_message_id=sm.');
  expect(turnsOf().join('\n')).not.toContain('diomedes source_message_id');
  // The model was told how to propose: the Mode text, then the format, at open and on the turn.
  expect(opened).toEqual([`${MODES.auto.instructions}\n\n${DECISION_FORMAT}`]);
  expect(dispatches[0].instructions).toBe(opened[0]);
});

test('C06: under Automatic a valid act proposal is shown, never started, until the person selects it', async () => {
  const proposed = await send('m-act', 'ACT just explain, do not change anything');
  expect(proposed.outcome).toMatchObject({
    status: 'proposed',
    projectId: project.id,
    operationClass: 'write_internal',
  });
  expect(proposed.answerText).toBe('I can start that.');
  expect(turnsOf()[1]).toBe('I can start that.');
  expect(await phaseNames(proposed)).toEqual(['decision']);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  // Sending the same message again shows the same proposal and still starts nothing.
  expect(await send('m-act', 'ACT just explain, do not change anything')).toEqual(proposed);
  expect(dispatches).toHaveLength(1);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
});

test('a selection bound to the message, the proposal and the target starts exactly one task and one work session', async () => {
  const proposed = await send('m-act', 'ACT order the usual');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  const digest = proposed.outcome.proposalDigest;
  // A choice for other words, or for another project, starts nothing and records nothing.
  expect((await select('m-act', 'f'.repeat(64))).status).toBe(409);
  const other = await api<Project>('/projects', 'POST', { name: 'Catering' });
  expect((await select('m-act', digest, other.id)).status).toBe(409);
  expect((await select('m-unknown', digest)).status).toBe(404);
  expect(await phaseNames(proposed)).toEqual(['decision']);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });

  const chosen = await select('m-act', digest);
  expect(chosen.status).toBe(200);
  const started = (await chosen.json()) as MessageResult;
  expect(started.outcome).toMatchObject({ status: 'started', projectId: project.id });
  expect(await phaseNames(proposed)).toEqual([
    'decision',
    'action-selected',
    'task-input',
    'task-receipt',
    'work-input',
    'work-receipt',
  ]);
  const made = workFor(proposed.sourceMessageId);
  expect(made.tasks).toHaveLength(1);
  expect(made.sessions).toHaveLength(1);
  expect(made.tasks[0].description).toBe('ACT order the usual');
  // Selecting again, re-sending the message and re-reading all report the same one start.
  expect(((await (await select('m-act', digest)).json()) as MessageResult).outcome).toEqual(
    started.outcome,
  );
  expect((await send('m-act', 'ACT order the usual')).outcome).toEqual(started.outcome);
  expect((await api<MessageResult>(`${messages()}/m-act`)).outcome).toEqual(started.outcome);
  expect(workFor(proposed.sourceMessageId).tasks).toHaveLength(1);
  expect(workFor(proposed.sourceMessageId).sessions).toHaveLength(1);
  expect(dispatches).toHaveLength(1);
});

test('a proposal naming another message is not a proposal', async () => {
  const forged = await send('m-forge', 'FORGE a decision');
  expect(forged.outcome).toEqual({ status: 'answered' });
  expect(forged.answerText).toBe('Sure.');
  const [decision] = await driver().phases(project.id, forged.runId, forged.sourceMessageId);
  expect(decision.body).toMatchObject({ block: 'refused' });
  expect((await select('m-forge', 'a'.repeat(64))).status).toBe(409);
});

test('Answer only and Plan only never show or start work, whatever the model proposes', async () => {
  for (const mode of ['ask', 'plan']) {
    const limited = await send(`m-${mode}`, 'ACT order the usual', { mode });
    // These modes give the model no identity line, so the fake model answers plainly; the
    // ceiling is proved against an adversarial proposal in tests/interaction-admission.test.ts.
    expect(limited.outcome).toEqual({ status: 'answered' });
    expect(workFor(limited.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  }
  // Neither is told about a decision block: each is sent exactly its own Mode text.
  expect(opened).toEqual([MODES.ask.instructions, MODES.plan.instructions]);
  expect(dispatches.map((turn) => turn.instructions)).toEqual(opened);
  // Each mode is its own lineage and its own run.
  const lineages = store().state(project.id).conversations.find((item) => item.id === thread.id)!
    .lineages!;
  expect(lineages.map((lineage) => [lineage.mode, lineage.generation])).toEqual([
    ['ask', 1],
    ['plan', 2],
  ]);
  // After the switch to Plan only, the Answer only message is still found on its own lineage:
  // the same body reads back with no model call, and a changed one is refused.
  const again = await send('m-ask', 'ACT order the usual', { mode: 'ask' });
  expect(again.answerText).toBe('answer:ACT order the usual');
  expect(
    (await request(messages(), 'POST', message('m-ask', 'ACT order the usual', { mode: 'auto' })))
      .status,
  ).toBe(409);
  expect(dispatches).toHaveLength(2);
});

test('narrowing the Mode control after a proposal was shown means it can no longer be started', async () => {
  const proposed = await send('m-act', 'ACT order the usual');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  await send('m-narrow', 'And now only answer', { mode: 'ask' });
  expect((await select('m-act', proposed.outcome.proposalDigest)).status).toBe(409);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
});

test('R-03: a reused command with a changed text, mode or source list is refused before and after projection, and changes nothing', async () => {
  const first = await send('m-one', 'ACT order the usual');
  const before = structuredClone(store().state(project.id));
  const runBefore = await driver().get(project.id, first.runId);
  for (const changed of [
    message('m-one', 'ACT order double'),
    message('m-one', 'ACT order the usual', { mode: 'plan' }),
    message('m-one', 'ACT order the usual', {
      sources: [{ path: 'prices.md', sha: 'a'.repeat(64) }],
    }),
  ])
    expect((await request(messages(), 'POST', changed)).status).toBe(409);
  expect(store().state(project.id)).toEqual(before);
  expect(await driver().get(project.id, first.runId)).toEqual(runBefore);
  expect(dispatches).toHaveLength(1);
  // A byte-equivalent retry after a restart is the same message, even with the model changed.
  await close();
  await open();
  expect(await send('m-one', 'ACT order the usual')).toEqual(first);
  expect(dispatches).toHaveLength(1);
});

test('R-14: a message answered on a cancelled conversation is still readable, and nothing can be started through it', async () => {
  const proposed = await send('m-act', 'ACT order the usual');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  await app.locals.harness.runs.cancel(
    proposed.runId,
    'the conversation moved on',
    localHarnessPrincipal(project.id),
  );
  const settled = await driver().get(project.id, proposed.runId);
  expect(settled.state).toBe('cancelled');
  // Read back: the same answer, and the proposal is no longer offered.
  const replay = await send('m-act', 'ACT order the usual');
  expect(replay.answerText).toBe('I can start that.');
  expect(replay.outcome.status).toBe('unresolved');
  // A changed body is refused on the settled run too.
  expect((await request(messages(), 'POST', message('m-act', 'ACT order double'))).status).toBe(409);
  // The person's choice cannot start it either.
  expect((await select('m-act', proposed.outcome.proposalDigest)).status).toBe(409);
  expect(await driver().get(project.id, proposed.runId)).toEqual(settled);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  expect(dispatches).toHaveLength(1);
  // A new message continues on a new generation; the retired lineage keeps its answer.
  const next = await send('m-next', 'Good morning');
  expect(next.runId).not.toBe(proposed.runId);
  const lineages = store().state(project.id).conversations.find((item) => item.id === thread.id)!
    .lineages!;
  expect(lineages.map((lineage) => [lineage.generation, lineage.retired ?? null])).toEqual([
    [1, 'terminated'],
    [2, null],
  ]);
  expect((await send('m-act', 'ACT order the usual')).answerText).toBe('I can start that.');
  // Retired as well as settled: a changed body is still refused, against what was first sent.
  for (const changed of [
    message('m-act', 'ACT order double'),
    message('m-act', 'ACT order the usual', { mode: 'plan' }),
  ])
    expect((await request(messages(), 'POST', changed)).status).toBe(409);
  expect(await driver().get(project.id, proposed.runId)).toEqual(settled);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  expect(dispatches).toHaveLength(2);
});

test('a busy target is a final refusal: the task exists, the work did not start, and a retry does not try again', async () => {
  const busy = await send('m-busy', 'ACT first job');
  if (busy.outcome.status !== 'proposed') throw new Error('expected a proposal');
  expect((await select('m-busy', busy.outcome.proposalDigest)).status).toBe(200);
  const second = await send('m-second', 'ACT second job');
  if (second.outcome.status !== 'proposed') throw new Error('expected a proposal');
  const refused = (await (
    await select('m-second', second.outcome.proposalDigest)
  ).json()) as MessageResult;
  expect(refused.outcome).toMatchObject({ status: 'not-started', reason: 'refused' });
  expect(await phaseNames(second)).toEqual([
    'decision',
    'action-selected',
    'task-input',
    'task-receipt',
    'work-input',
    'work-refused',
  ]);
  const made = workFor(second.sourceMessageId);
  expect(made.tasks).toHaveLength(1);
  expect(made.sessions).toHaveLength(0);
  expect((await send('m-second', 'ACT second job')).outcome).toEqual(refused.outcome);
  expect(workFor(second.sourceMessageId).sessions).toHaveLength(0);
});

test('a receipt that exists without its phase is linked after a restart, never sent again', async () => {
  const proposed = await send('m-act', 'ACT order the usual');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  // The crash window: the task was admitted under the derived command id, and the process
  // died before the phase that links it was saved.
  const ids = conversationCommandIds(proposed.sourceMessageId);
  await driver().record(project.id, proposed.runId, [
    {
      phase: 'action-selected',
      sourceMessageId: proposed.sourceMessageId,
      body: {
        sourceMessageId: proposed.sourceMessageId,
        proposalDigest: proposed.outcome.proposalDigest,
        projectId: project.id,
      },
    },
  ]);
  await api(`/projects/${project.id}/tasks`, 'POST', {
    protocolVersion: 1,
    commandId: ids.taskCommandId,
    name: 'Do this: ACT order the usual',
    description: 'ACT order the usual',
    owner: 'diomedes-with-ok',
  });
  await close();
  await open();
  const resumed = await send('m-act', 'ACT order the usual');
  expect(resumed.outcome).toMatchObject({ status: 'started' });
  const made = workFor(proposed.sourceMessageId);
  expect(made.tasks).toHaveLength(1);
  expect(made.sessions).toHaveLength(1);
  expect(dispatches).toHaveLength(1);
  expect(await phaseNames(proposed)).toEqual([
    'decision',
    'action-selected',
    'task-input',
    'task-receipt',
    'work-input',
    'work-receipt',
  ]);
});

// ---- Round 6: the reproducers from review r5, each at the boundary it names ----

const lineagesOf = () =>
  store().state(project.id).conversations.find((item) => item.id === thread.id)!.lineages ?? [];
const narrowTo = async (mode: 'ask' | 'plan') =>
  api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { mode });

for (const narrowed of ['ask', 'plan'] as const)
  test(`R-05: a selection saved before a crash cannot start work once the Mode is narrowed to ${narrowed}`, async () => {
    const proposed = await send('m-act', 'ACT order the usual');
    if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
    // The crash window the selection-before-admission order creates: the choice is saved and
    // nothing has been admitted yet.
    await driver().record(project.id, proposed.runId, [
      {
        phase: 'action-selected',
        sourceMessageId: proposed.sourceMessageId,
        body: {
          sourceMessageId: proposed.sourceMessageId,
          proposalDigest: proposed.outcome.proposalDigest,
          projectId: project.id,
        },
      },
    ]);
    await close();
    await open();
    await narrowTo(narrowed);
    expect((await select('m-act', proposed.outcome.proposalDigest)).status).toBe(409);
    const replay = await send('m-act', 'ACT order the usual');
    expect(replay.answerText).toBe('I can start that.');
    expect(replay.outcome.status).toBe('not-started');
    expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
    // Reading the old message back did not move the control the person narrowed.
    expect(store().state(project.id).conversations.find((c) => c.id === thread.id)!.mode).toBe(
      narrowed,
    );
    expect(dispatches).toHaveLength(1);
  });

test('R-05: narrowing after the task was admitted stops the Work start and keeps the task readable', async () => {
  const proposed = await send('m-act', 'ACT order the usual');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  const d = driver();
  const record = d.record.bind(d);
  // The process dies right after the task receipt is recorded, before the Work input.
  d.record = async (...args: Parameters<typeof record>) => {
    if (args[2].some((phase) => phase.phase === 'work-input')) throw new Error('the process died');
    return record(...args);
  };
  expect((await select('m-act', proposed.outcome.proposalDigest)).status).toBe(500);
  d.record = record;
  expect(workFor(proposed.sourceMessageId).tasks).toHaveLength(1);
  await close();
  await open();
  await narrowTo('ask');
  const replay = await send('m-act', 'ACT order the usual');
  expect(replay.outcome.status).not.toBe('started');
  const after = workFor(proposed.sourceMessageId);
  expect(after.tasks).toHaveLength(1);
  expect(after.sessions).toEqual([]);
});

for (const gap of ['task-input', 'work-input'] as const)
  test(`R-15: a cancellation after ${gap} is recorded and before its admission starts nothing`, async () => {
    const proposed = await send('m-cancel-gap', 'ACT order the usual');
    if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
    const d = driver();
    const record = d.record.bind(d);
    d.record = async (...args: Parameters<typeof record>) => {
      await record(...args);
      if (args[2].some((phase) => phase.phase === gap))
        await app.locals.harness.runs.cancel(
          proposed.runId,
          'cancelled before the admission',
          localHarnessPrincipal(project.id),
        );
    };
    try {
      const response = await select('m-cancel-gap', proposed.outcome.proposalDigest);
      expect(response.status).toBe(409);
      expect((await response.json()).code ?? 'RUN_SETTLED').toBe('RUN_SETTLED');
    } finally {
      d.record = record;
    }
    const work = workFor(proposed.sourceMessageId);
    // Cancelled before the task: nothing at all. Cancelled before the Work: the task that was
    // already admitted stays, and no Work session exists.
    expect(work.tasks).toHaveLength(gap === 'task-input' ? 0 : 1);
    expect(work.sessions).toEqual([]);
    const read = await api<MessageResult>(`${messages()}/m-cancel-gap`);
    expect(read.outcome.status).toBe('unresolved');
  });

test('R-14: a message whose decision was never recorded reads as unresolved on every route, settled or not', async () => {
  const d = driver();
  const original = d.request.bind(d);
  d.request = (turn: Parameters<typeof original>[0]) =>
    original({
      ...turn,
      input: {
        ...turn.input,
        interaction: {
          ...turn.input.interaction!,
          decide: () => {
            throw new Error('the process died');
          },
        },
      },
    });
  expect((await request(messages(), 'POST', message('m-gap', 'ACT order the usual'))).status).toBe(500);
  d.request = original;
  const runId = lineagesOf().at(-1)!.runId;
  // Still live: the GET writes nothing, so the missing decision reads as unfinished.
  const live = await api<MessageResult>(`${messages()}/m-gap`);
  expect(live.outcome).toMatchObject({ status: 'unresolved' });
  await app.locals.harness.runs.cancel(runId, 'moved on', localHarnessPrincipal(project.id));
  await close();
  await open();
  const settled = await driver().get(project.id, runId);
  const read = await api<MessageResult>(`${messages()}/m-gap`);
  expect(read.outcome).toMatchObject({ status: 'unresolved' });
  const replay = await send('m-gap', 'ACT order the usual');
  expect(replay.answerText).toBe('I can start that.');
  expect(replay.outcome).toEqual(read.outcome);
  expect(await driver().get(project.id, runId)).toEqual(settled);
  expect(workFor(replay.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  expect(dispatches).toHaveLength(1);
});

test('R-03: a projection that failed is repaired from the turn itself, not from the files and settings as they stand now', async () => {
  const contents = 'Flour 18.40 a sack';
  await fs.writeFile(path.join(project.folder, 'prices.md'), contents);
  const body = message('m-source', 'Compare the prices', {
    sources: [{ path: 'prices.md', sha: hash(contents)! }],
  });
  const live = store();
  const persist = live.persist.bind(live);
  let failed = false;
  live.persist = async (state: Parameters<typeof persist>[0]) => {
    const projected = state.conversations
      .find((item) => item.id === thread.id)
      ?.turns.some((turn) => turn.text === 'Compare the prices');
    if (projected && !failed) {
      failed = true;
      throw new Error('the disk was full');
    }
    return persist(state);
  };
  expect((await request(messages(), 'POST', body)).status).toBe(500);
  live.persist = persist;
  expect(turnsOf()).toEqual([]);
  // Everything a repair could wrongly read from the present is changed before it runs.
  await fs.writeFile(path.join(project.folder, 'prices.md'), 'Flour 99.00 a sack');
  await live.saveSettings({
    ...live.settings,
    services: { ...live.settings.services, 'claude-codeAccountRoute': 'claude-code:another-account' },
  });
  await close();
  await open();
  // The person narrows the control before the repair runs. A repair must not move it back.
  await narrowTo('plan');
  const repaired = await api<MessageResult>(messages(), 'POST', body);
  expect(store().state(project.id).conversations.find((c) => c.id === thread.id)!.mode).toBe(
    'plan',
  );
  expect(repaired.answerText).toBe('answer:Compare the prices');
  expect(dispatches).toHaveLength(1);
  const turns = store().state(project.id).conversations.find((item) => item.id === thread.id)!
    .turns;
  expect(turns.map((turn) => turn.sources)).toEqual([['prices.md'], ['prices.md']]);
  const run = await driver().get(project.id, repaired.runId);
  const turnStep = run.steps.find((step) => step.intent.stepId.startsWith('turn'))!;
  expect(turnStep.origin).toBeTruthy();
  expect(turns[1].origin).toEqual(turnStep.origin);
  expect(turns[1].origin!.accountRoute).toBe(accountRoute);
});

test('R-10: a lineage that runs out of budget is replaced once, and the replacement is what a retry and a restart find', async () => {
  await send('m-budget-0', 'Hello 0');
  await send('m-budget-1', 'Hello 1');
  expect(lineagesOf().map((l) => [l.generation, l.retired ?? null])).toEqual([[1, null]]);
  // The admitted budget is lowered to what this run has already used, through the Runtime's own
  // store, so 126 more messages need not be sent. The refusal that follows is the real one:
  // RunService writes the pending turn, refuses it unsent, and commits it.
  const runs = app.locals.harness.runs as unknown as {
    store: { read(id: string): Promise<HarnessRun>; write(run: HarnessRun): Promise<void> };
  };
  const exhausted = await runs.store.read(lineagesOf()[0].runId);
  exhausted.budget = { ...exhausted.budget, modelCalls: exhausted.used.modelCalls };
  await runs.store.write(exhausted);
  const next = await send('m-budget-128', 'One more');
  expect(next.answerText).toBe('answer:One more');
  expect(dispatches).toHaveLength(3);
  expect(lineagesOf().map((l) => [l.generation, l.retired ?? null])).toEqual([
    [1, 'budget'],
    [2, null],
  ]);
  expect(next.runId).toBe(lineagesOf()[1].runId);
  // The refused turn stays on the old run as evidence, never sent.
  const old = await driver().get(project.id, lineagesOf()[0].runId);
  expect(old.used.modelCalls).toBe(2);
  const refused = old.steps.find(
    (step) => (step.intent.input as { requestId?: string } | null)?.requestId === 'm-budget-128',
  )!;
  expect([refused.state, refused.attempt]).toEqual(['pending', 0]);
  await close();
  await open();
  const replay = await send('m-budget-128', 'One more');
  expect(replay.runId).toBe(next.runId);
  expect(replay.answerText).toBe('answer:One more');
  expect((await send('m-budget-0', 'Hello 0')).answerText).toBe('answer:Hello 0');
  expect(dispatches).toHaveLength(3);
  expect(lineagesOf()).toHaveLength(2);
});

test('R-16: the direct Build route cannot admit Work in the reserved home', async () => {
  const home = await api<{ projectId: string; threadId: string }>(
    '/home/conversation', 'POST', {},
  );
  const response = await request('/projects/' + home.projectId + '/ask', 'POST', {
    threadId: home.threadId,
    route: 'sample',
    mode: 'build',
    text: 'Order plates',
    sources: [],
    consent: true,
  });
  const state = store().state(home.projectId);
  expect({
    status: response.status,
    tasks: state.tasks.length,
    sessions: state.sessions.length,
    mode: state.conversations.find((item) => item.id === home.threadId)!.mode,
  }).toEqual({ status: 409, tasks: 0, sessions: 0, mode: 'auto' });
});
