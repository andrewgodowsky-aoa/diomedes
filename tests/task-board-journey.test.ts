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
import { routeContractFor } from '../server/harness/route-contract';
import { hash, type Store } from '../server/store';
import { conversationCommandIds } from '../server/interaction-admission';
import type { MessageResult } from '../server/interaction-service';
import { taskEvidence } from '../client/workbench/task-evidence';
import { boardMove, type BoardMoveFacts } from '../shared/board-moves';
import { readyAt } from '../shared/ready-queue';
import type { TaskExecutionView } from '../shared/task-execution';
import type { Conversation, Project, Session, Task } from '../shared/types';

// The research's first proof, through the real app over HTTP (2026-09-26, "prove one complete
// task journey"): Nectovia proposes a task in a conversation, the person chooses it, the task
// is made and its run admitted under the command ids derived for that message, the execution
// view and the Board read the same records, the service restarts in the middle of the run, and
// afterwards the task keeps its identity, nothing is started twice, the automatic queue leaves a
// stopped task alone, and the person's own Board Start runs it on to a decision for them.
//
// The conversation runs on a scripted Claude Code session (as tests/interaction-seam.test.ts
// does); Work runs on the sample route, which needs no provider. The Nectovia route itself is
// refused for Work (server/engines/nectovia.ts `NECTOVIA_WORK_REFUSED`), so it is not a route
// this journey can take yet; the execution view says so, and a test below pins that it does.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'claude-fixture';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;
let dispatches: number;

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
/** A long step keeps the first run in flight until the restart; later runs step quickly. */
async function open(stepMs = 20) {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    stepMs,
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
const records = () => store().state(project.id);

function scripted(prompt: string) {
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(prompt)?.[1];
  const text = prompt.split('\n\n[[diomedes')[0];
  if (!text.startsWith('ACT') || !issued) return `answer:${text}`;
  return (
    'I can put that on the board.\n\n```diomedes-decision\n' +
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-board-journey-'));
  dispatches = 0;
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
          return {
            providerId: 'claude-code',
            lineageId: checkpoint.lineageId,
            opaqueRef: checkpoint.nativeSessionId!,
          };
        },
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          dispatches += 1;
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
  // The first run must still be in flight when the service restarts.
  await open(60_000);
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
  project = await api<Project>('/projects', 'POST', { name: 'Supplier quotes' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['claude-code'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const state = records();
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  // Work in this project runs on the scripted sample worker.
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

const messages = () => `/projects/${project.id}/threads/${thread.id}/messages`;
const send = (commandId: string, text: string) =>
  api<MessageResult>(messages(), 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });
const select = (commandId: string, proposalDigest: string) =>
  api<MessageResult>(`${messages()}/${commandId}/select`, 'POST', {
    proposalDigest,
    projectId: project.id,
    consent: true,
  });
const execution = (taskId: string) =>
  api<TaskExecutionView>(`/projects/${project.id}/tasks/${taskId}/execution`);
const taskOf = (taskId: string) => records().tasks.find((item) => item.id === taskId)!;
const runsOf = (taskId: string) => records().sessions.filter((session) => session.taskId === taskId);
const columnOf = (task: Task) => {
  const state = records();
  return taskEvidence(task, state.sessions, state.needs, state.changes);
};
/** The facts the Board judges a move by, from the same records it projects. */
function factsOf(task: Task): BoardMoveFacts {
  const state = records();
  const evidence = taskEvidence(task, state.sessions, state.needs, state.changes);
  return {
    from: evidence.column,
    active: evidence.active,
    slotBusy: state.sessions.some((session) => ['queued', 'working', 'waiting'].includes(session.state)),
    openNeed: state.needs.some((need) => need.taskId === task.id && need.state === 'open'),
    changesWaiting: state.changes.some((change) => change.taskId === task.id && change.state === 'waiting'),
    failed: !evidence.active && evidence.session?.state === 'failed',
    autoStart: true,
  };
}
async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('an agent-proposed task keeps one identity and one run across a restart, then runs again only when the person starts it', async () => {
  // 1. Nectovia proposes in the conversation. Nothing is on the Board yet.
  const proposed = await send('m-quotes', 'ACT compare the three supplier quotes and recommend one');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  expect(records().tasks).toHaveLength(0);

  // 2. The person chooses it: one task and one run, each under the command id derived for this
  //    message, so a retry reaches the same receipts.
  const started = await select('m-quotes', proposed.outcome.proposalDigest);
  expect(started.outcome).toMatchObject({ status: 'started', projectId: project.id });
  const ids = conversationCommandIds(proposed.sourceMessageId);
  const [task] = records().tasks;
  expect(task.creationReceipt?.commandId).toBe(ids.taskCommandId);
  expect(task.owner).toBe('diomedes-with-ok');
  const [first] = runsOf(task.id);
  expect(first.receipt?.commandId).toBe(ids.workCommandId);

  // 3. The execution view reads the same records: the sample route, no Agent or model, and the
  //    one run under the conversation's own Work command. Reading it changed nothing.
  const before = JSON.stringify(records());
  const view = await execution(task.id);
  expect(JSON.stringify(records())).toBe(before);
  expect(view.route).toMatchObject({ id: 'sample', on: true, source: 'project' });
  expect(view.worker.resolved).toBeNull();
  expect(view.model).toBeNull();
  expect(view.runs.map((run) => [run.sessionId, run.commandId])).toEqual([[first.id, ids.workCommandId]]);

  // 4. While it runs the Board shows it as admitted work, and a drop back into Ready asks for a
  //    Stop, never a second start.
  expect(['Queued', 'Working', 'Review']).toContain(columnOf(taskOf(task.id)).column);
  const back = boardMove('Ready', factsOf(taskOf(task.id)));
  if (columnOf(taskOf(task.id)).column === 'Review') expect(back.kind).toBe('refused');
  else expect(back).toMatchObject({ kind: 'command', command: 'stop' });
  expect(boardMove('Working', factsOf(taskOf(task.id))).kind).toBe('refused');

  // 5. Automatic start is on, then the service restarts in the middle of the run.
  await api(`/projects/${project.id}/ready-queue`, 'PUT', { autoStart: true });
  await close();
  await open();

  // 6. The task keeps its identity. The run in flight was stopped as the service closed (after a
  //    crash, the restart settles it instead, with its own sentence), its log says so, and no
  //    second run exists.
  const after = taskOf(task.id);
  expect(after.id).toBe(task.id);
  expect(after.creationReceipt?.commandId).toBe(ids.taskCommandId);
  expect(runsOf(task.id)).toHaveLength(1);
  const stopped = runsOf(task.id)[0];
  expect(stopped.id).toBe(first.id);
  expect(stopped.state).toBe('stopped');
  expect(stopped.log.filter((line) => line.level === 'plain').at(-1)?.sentence).toMatch(
    /^Stopped\. 0 files were changed before the stop/,
  );

  // 7. Replaying every command the conversation sent finds the same receipts and dispatches
  //    nothing: no second task, no second run, no second model turn.
  const turnsBefore = dispatches;
  expect((await select('m-quotes', proposed.outcome.proposalDigest)).outcome).toEqual(started.outcome);
  expect((await send('m-quotes', 'ACT compare the three supplier quotes and recommend one')).outcome).toEqual(
    started.outcome,
  );
  expect(records().tasks).toHaveLength(1);
  expect(runsOf(task.id)).toHaveLength(1);
  expect(dispatches).toBe(turnsBefore);

  // 8. The Board shows it Ready and waiting for the person. Stop means stop: the automatic queue
  //    does not start a stopped task on its own, even with automatic start on.
  const ready = columnOf(taskOf(task.id));
  expect(ready.column).toBe('Ready');
  expect(ready.detail).toBe('Stopped; Start begins new work');
  expect(readyAt(taskOf(task.id), records().sessions, records().needs, records().changes)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(runsOf(task.id)).toHaveLength(1);
  const queue = await api<{ items: { taskId: string }[] }>(`/projects/${project.id}/ready-queue`);
  expect(queue.items.map((item) => item.taskId)).not.toContain(task.id);

  // 9. The person drags it into Working: the table asks for exactly the Board's Start, which goes
  //    through the Work start admission with its own new command.
  expect(boardMove('Working', factsOf(taskOf(task.id)))).toMatchObject({ kind: 'command', command: 'start' });
  const again = await api<Session>(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: 'board-start-1',
    taskId: task.id,
    route: 'sample',
    sources: [],
    consent: true,
  });
  expect(again.id).not.toBe(first.id);
  // A lost response retried with the same command is the same run.
  const retried = await api<Session>(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: 'board-start-1',
    taskId: task.id,
    route: 'sample',
    sources: [],
    consent: true,
  });
  expect(retried.id).toBe(again.id);
  expect(runsOf(task.id)).toHaveLength(2);

  // 10. The run reaches a decision for the person, and the Board says so from the records.
  await until(
    () => records().needs.some((need) => need.taskId === task.id && need.state === 'open'),
    'the run to ask for a decision',
  );
  expect(columnOf(taskOf(task.id))).toMatchObject({ column: 'Review', detail: 'Needs your decision' });
  expect(boardMove('Done', factsOf(taskOf(task.id)))).toEqual({
    kind: 'refused',
    reason: 'Stop the run first, or let it finish.',
  });

  // 11. The execution view lists both runs as their own records say, newest first.
  const history = await execution(task.id);
  expect(history.runs.map((run) => [run.sessionId, run.commandId, run.state])).toEqual([
    [again.id, 'board-start-1', 'waiting'],
    [first.id, ids.workCommandId, 'stopped'],
  ]);
});

test('the execution view names the Nectovia refusal instead of hiding it', async () => {
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Draft the reply',
    description: '',
    owner: 'you',
  });
  const state = records();
  state.project.ai = { engine: 'nectovia', model: null };
  await store().persist(state);
  const view = await execution(task.id);
  // No Settings switch governs the Nectovia route, so it is never reported as turned off.
  // Readiness needs a signed-in paid account: without one the view names that, not Build/Fix.
  expect(view.route).toMatchObject({ id: 'nectovia', on: true });
  expect(view.blockers.join('\n')).toContain('Sign in to use the Nectovia Agent.');
});

test('a Board Start on a route that is off is named before it is sent', async () => {
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Check the delivery terms',
    description: '',
    owner: 'you',
  });
  const state = records();
  state.project.ai = { engine: 'codex', model: null };
  await store().persist(state);
  const view = await execution(task.id);
  expect(view.route).toMatchObject({ id: 'codex', on: false, source: 'project' });
  expect(view.blockers).toContain('Turn the selected engine on in Settings before using it.');
  const refused = await request(`/projects/${project.id}/work/start`, 'POST', {
    taskId: task.id,
    route: 'codex',
    sources: [],
    consent: true,
  });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error?: string; message?: string }).error ?? '').toContain(
    'Turn the selected engine on in Settings',
  );
});

test('two Starts sent at once make one run, and the refused one leaves it running', async () => {
  // A double click or a repeated drag can send two Starts before either answers, each under its
  // own command. The service runs each such request under one lock (`store.locked`), so the
  // second waits for the first and meets the one-run rule: one admitted, one refused, never a
  // second worker, and the refusal does not disturb the admitted run (research: Hermes #121593).
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Check the delivery terms',
    description: '',
    owner: 'you',
  });
  const start = (commandId: string) =>
    request(`/projects/${project.id}/work/start`, 'POST', {
      protocolVersion: 1,
      commandId,
      taskId: task.id,
      route: 'sample',
      sources: [],
      consent: true,
    });
  const answers = await Promise.all([start('double-1'), start('double-2')]);
  expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
  expect(runsOf(task.id)).toHaveLength(1);
  // The admitted run still answers: its first decision goes through and the run works on.
  const need = records().needs.find((item) => item.taskId === task.id && item.state === 'open');
  expect(need, 'the sample run asks before it starts').toBeDefined();
  const decided = await request(`/projects/${project.id}/needs/${need!.id}/resolve`, 'POST', {
    resolution: 'go-ahead',
  });
  expect(decided.status, await decided.clone().text()).toBe(200);
  expect(runsOf(task.id)[0].state).toBe('working');
});

test('a person’s reopen is recorded even when the task already reads To do', async () => {
  // A Stop leaves the task at To do by Diomedes' own move, and Stop means stop: the queue leaves
  // it alone. The person's reopen of that same state must still be recorded, or the request is
  // accepted and changes nothing (H07: not restarted "unless the person reopens it").
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Check the delivery terms',
    description: '',
    owner: 'you',
  });
  const run = await api<Session>(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: 'reopen-start-1',
    taskId: task.id,
    route: 'sample',
    sources: [],
    consent: true,
  });
  await api(`/projects/${project.id}/work/${run.id}/stop`, 'POST', {});
  const stopped = taskOf(task.id);
  expect(stopped.state).toBe('todo');
  expect(stopped.moves.at(-1)?.by).toBe('diomedes');
  expect(readyAt(stopped, records().sessions, records().needs, records().changes)).toBeNull();

  await api(`/projects/${project.id}/tasks/${task.id}`, 'PUT', { state: 'todo' });
  const reopened = taskOf(task.id);
  expect(reopened.moves.at(-1)).toMatchObject({ by: 'you', from: 'todo', to: 'todo' });
  expect(readyAt(reopened, records().sessions, records().needs, records().changes)).toBe(reopened.moves.at(-1)!.at);
  const said = () =>
    records().history.filter((entry) => entry.sentence === 'You moved Check the delivery terms to To do');
  expect(said()).toHaveLength(1);
  // A retried reopen, as after a lost response, adds nothing: the first one already counts.
  const moves = taskOf(task.id).moves.length;
  await api(`/projects/${project.id}/tasks/${task.id}`, 'PUT', { state: 'todo' });
  expect(taskOf(task.id).moves).toHaveLength(moves);
  expect(said()).toHaveLength(1);
  // Automatic start is off here, so nothing started.
  expect(runsOf(task.id)).toHaveLength(1);
});

test('a task that does not exist has no execution view', async () => {
  expect((await request(`/projects/${project.id}/tasks/T999/execution`)).status).toBe(404);
});
