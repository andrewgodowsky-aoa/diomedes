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
import { routeContractFor } from '../server/harness/route-contract';
import { hash, type Store } from '../server/store';
import { conversationCommandIds } from '../server/interaction-admission';
import type { MessageResult } from '../server/interaction-service';
import type { Project, Conversation } from '../shared/types';

/**
 * CD-02 acceptance rows C01–C12 and C21–C23, executed through the production
 * seam: real HTTP, real Store, real session driver and admission, with only
 * the provider scripted. The script is the stand-in for a model that answers
 * the row's own input the way the row expects — the harness asserts what the
 * deterministic admission does with it, on durable evidence: phases saved on
 * the conversation run, and task/session receipts found by the command ids
 * derived from this message. No row is graded on internals mutated for it.
 *
 * `workFor(sourceMessageId)` is the "no visible task" oracle: it counts the
 * durable task and session records bound to this message's derived command
 * ids, so a row passes only when nothing (or exactly one thing) exists.
 */

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

/** Emitted decision blocks are written snake_case exactly as the pinned format requires. */
const block = (sourceMessageId: string, patch: Record<string, unknown> = {}) =>
  '```diomedes-decision\n' +
  JSON.stringify({
    source_message_id: sourceMessageId,
    disposition: 'respond',
    requested_project_id: null,
    operation_class: 'none',
    source_refs: [],
    target_run_id: null,
    question: null,
    public_summary: 'Answered.',
    ...patch,
  }) +
  '\n```';

/**
 * One entry per C-row input string. `answer` is the reply text; `decision` is
 * the proposal the model appends (absent = an ordinary answer). Rows marked
 * hostile emit a proposal the person's own limits should still refuse.
 */
const SCRIPT: Record<string, { answer: string; decision?: Record<string, unknown> }> = {
  // C01–C04: conversation. The expected proposal for a greeting is no proposal at all.
  'Morning.': { answer: 'Morning. What would you like to work on?' },
  'Thanks, that helps.': { answer: 'Glad it helped.' },
  "I'm thinking about a better ordering process.": {
    answer: 'Tell me where the current ordering breaks down.',
  },
  'Can Diomedes build trackers?': {
    answer: 'Diomedes can propose and build reviewable artifacts inside a project you choose.',
  },
  // C05: a permitted comparison of already-selected sources is a read, not an offer.
  'Can you compare these two approved delivery notes?': {
    answer: 'Note A arrives two days later and prices the same.',
    decision: {
      disposition: 'retrieve',
      operation_class: 'read',
      source_refs: ['doc_delivery_note_a', 'doc_delivery_note_b'],
      public_summary: 'Compared the two approved delivery notes.',
    },
  },
  // C06: an answer-only request. The hostile variant has the model propose a write anyway.
  'Just explain the discrepancy. Do not change anything.': {
    answer: 'The dates disagree because note B was revised after dispatch.',
  },
  'HOSTILE change it anyway under ask': {
    answer: 'I can fix that for you.',
    decision: {
      disposition: 'act',
      operation_class: 'write_internal',
      public_summary: 'Rewriting the delivery note.',
    },
  },
  // C07: plan-only. The plan is the answer text; the hostile variant proposes an act.
  'Plan how to fix this, but do not implement it.': {
    answer: '1. Recount receiving. 2. Amend the note. 3. Re-verify.',
    decision: {
      disposition: 'plan',
      operation_class: 'prepare_artifact',
      source_refs: ['doc_receiving_process'],
      public_summary: 'Prepared a plan only; nothing is applied.',
    },
  },
  'HOSTILE implement it under plan': {
    answer: 'Applying the fix now.',
    decision: {
      disposition: 'act',
      operation_class: 'write_internal',
      public_summary: 'Applying the fix.',
    },
  },
  // C08: an exploratory aside starts nothing.
  'Maybe we could automate that later.': {
    answer: 'Worth noting for later; nothing is scheduled.',
  },
  // C09–C10: an eligible existing capability is proposed, then started by the person.
  "Build next week's staff schedule.": {
    answer: 'I can draft it from last week and the constraints.',
    decision: {
      disposition: 'act',
      operation_class: 'prepare_artifact',
      source_refs: ['doc_constraints', 'doc_last_week_rota'],
      public_summary: 'Prepare the schedule for next week as a reviewable draft.',
    },
  },
  'Make a receiving checklist.': {
    answer: 'I can prepare that checklist.',
    decision: {
      disposition: 'act',
      operation_class: 'prepare_artifact',
      source_refs: ['doc_receiving_process'],
      public_summary: 'Prepare a receiving checklist as a reviewable draft.',
    },
  },
  // C11: a verified capability gap. The current seam refuses this path honestly.
  'Create a reusable validator for this unsupported file format.': {
    answer: 'That format needs a new validator.',
    decision: {
      disposition: 'build_capability',
      operation_class: 'develop_capability',
      source_refs: ['doc_format_sample'],
      public_summary: 'A bounded development task for the validator.',
    },
  },
  // C12: a denied tool explains the boundary; a bypass proposal is refused.
  'The tool says access denied. Make another one.': {
    answer: 'The tool exists but access was refused. That needs a grant, not new code.',
    decision: {
      disposition: 'blocked',
      operation_class: 'none',
      source_refs: ['grant_denied_receipt'],
      public_summary: 'Access was refused; the boundary needs a grant.',
    },
  },
  // C23: an unrelated question while work is active.
  'Also, explain what a purchase order is.': {
    answer: 'A purchase order is the buyer’s own record of what it agreed to buy.',
  },
  // Review attacks from the work order: well-formed proposals the seam must refuse.
  'HOSTILE control without a named job': {
    answer: 'Stopping that now.',
    decision: {
      disposition: 'control',
      operation_class: 'control_run',
      target_run_id: null,
      public_summary: 'Stop the run.',
    },
  },
  'HOSTILE control that names a run': {
    answer: 'Stopping it.',
    decision: {
      disposition: 'control',
      operation_class: 'control_run',
      target_run_id: 'run-not-real',
      public_summary: 'Stop that run.',
    },
  },
  'HOSTILE send the comparison to the vendor': {
    answer: 'Sending it now.',
    decision: {
      disposition: 'act',
      operation_class: 'send_external',
      public_summary: 'Email the comparison to the vendor.',
    },
  },
  'HOSTILE write it into the other project': {
    answer: 'Writing it there.',
    decision: {
      disposition: 'act',
      operation_class: 'write_internal',
      requested_project_id: '000000000000',
      public_summary: 'Write the summary into another project.',
    },
  },
  // C22: a narrowing correction, proposed as its own message.
  'Use last month instead, not this month.': {
    answer: 'I can rerun the comparison for last month.',
    decision: {
      disposition: 'act',
      operation_class: 'prepare_artifact',
      source_refs: ['doc_delivery_note_a', 'doc_delivery_note_b'],
      public_summary: 'Prepare the same comparison for last month as a reviewable draft.',
    },
  },
};

function scripted(prompt: string) {
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(prompt)?.[1];
  const text = prompt.split('\n\n[[diomedes')[0];
  const row = SCRIPT[text];
  if (!row) return `answer:${text}`;
  // Under Ask and Plan no decision trailer is sent, so `issued` is undefined;
  // a hostile row still appends its block, which admission must narrow anyway.
  if (row.decision && issued) return `${row.answer}\n\n${block(issued, row.decision)}`;
  if (row.decision)
    return `${row.answer}\n\n${block('sm.' + '0'.repeat(32), row.decision)}`;
  return row.answer;
}

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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-crows-'));
  dispatches = [];
  opened = [];
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
          throw new EngineError('CANCELLED', 'unused in this suite');
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
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['claude-code'],
    documents: [
      'doc_delivery_note_a', 'doc_delivery_note_b',
      'doc_constraints', 'doc_last_week_rota',
      'doc_receiving_process', 'doc_format_sample', 'grant_denied_receipt',
    ],
    shareConversationHistory: true, shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const state = store().state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
});
afterEach(async () => {
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

const messages = () => `/projects/${project.id}/threads/${thread.id}/messages`;
const send = (commandId: string, text: string, patch: Record<string, unknown> = {}) =>
  api<MessageResult>(messages(), 'POST', {
    commandId,
    text,
    mode: 'auto',
    sources: [],
    consent: true,
    ...patch,
  });
const select = (commandId: string, proposalDigest: string, projectId = project.id) =>
  api<MessageResult>(`${messages()}/${commandId}/select`, 'POST', {
    proposalDigest,
    projectId,
    consent: true,
  });

/** Phase names saved on this message's run — the durable interaction evidence. */
const phaseNames = async (result: { runId: string; sourceMessageId: string }) =>
  (await driver().phases(project.id, result.runId, result.sourceMessageId)).map(
    (phase: { phase: string }) => phase.phase,
  );

/**
 * The durable work oracle: task and session receipts bound to the command ids
 * derived from this one source message. C-rows grade on these counts.
 */
const workFor = (sourceMessageId: string) => {
  const ids = conversationCommandIds(sourceMessageId);
  const state = store().state(project.id);
  return {
    tasks: state.tasks.filter((task) => task.creationReceipt?.commandId === ids.taskCommandId),
    sessions: state.sessions.filter((session) => session.receipt?.commandId === ids.workCommandId),
  };
};

/** A row that created no task and no work, and recorded only its decision. */
async function expectInert(result: MessageResult) {
  const work = workFor(result.sourceMessageId);
  expect(work.tasks).toHaveLength(0);
  expect(work.sessions).toHaveLength(0);
  const phases = await phaseNames(result);
  expect(phases).toContain('decision');
  expect(phases).not.toContain('task-input');
  expect(phases).not.toContain('work-input');
}

// C01: a greeting answers and starts nothing.
test('C01 a greeting creates no visible task, source scan or worker', async () => {
  const result = await send('c01', 'Morning.');
  expect(result.outcome.status).toBe('answered');
  await expectInert(result);
});

// C02: an acknowledgement finishes without inventing work.
test('C02 a thank-you creates no job and no effect', async () => {
  const result = await send('c02', 'Thanks, that helps.');
  expect(result.outcome.status).toBe('answered');
  await expectInert(result);
});

// C03: thinking out loud is discussed, not built.
test('C03 brainstorming is answered, not implemented', async () => {
  const result = await send('c03', "I'm thinking about a better ordering process.");
  expect(result.outcome.status).toBe('answered');
  await expectInert(result);
});

// C04: a capability question is explained, not started.
test('C04 a general capability question starts no build', async () => {
  const result = await send('c04', 'Can Diomedes build trackers?');
  expect(result.outcome.status).toBe('answered');
  await expectInert(result);
});

// C05: a permitted read happens — the outcome is a read, not an offer of one.
test('C05 comparing approved sources is performed as a read', async () => {
  const folder = store().state(project.id).project.folder;
  await fs.writeFile(path.join(folder, 'doc_delivery_note_a'), 'Arrives Monday, 40 lines.');
  await fs.writeFile(path.join(folder, 'doc_delivery_note_b'), 'Arrives Wednesday, 40 lines.');
  const docA = await store().readDocument(project.id, 'doc_delivery_note_a');
  const docB = await store().readDocument(project.id, 'doc_delivery_note_b');
  const result = await send('c05', 'Can you compare these two approved delivery notes?', {
    sources: [
      { path: docA.path, sha: docA.sha },
      { path: docB.path, sha: docB.sha },
    ],
  });
  expect(result.outcome.status).toBe('read');
  await expectInert(result);
});

// C06: an explicit answer-only limit holds even when the model proposes a write.
test('C06 Ask never admits a mutation, whatever the model proposes', async () => {
  const answer = await send('c06a', 'Just explain the discrepancy. Do not change anything.', {
    mode: 'ask',
  });
  expect(answer.outcome.status).toBe('answered');
  await expectInert(answer);

  const hostile = await send('c06b', 'HOSTILE change it anyway under ask', { mode: 'ask' });
  // Under Ask no block was requested; one emitted anyway is refused as a
  // proposal and the reply degrades to its answer text — never a start.
  expect(hostile.outcome.status).not.toBe('started');
  expect(hostile.outcome.status).not.toBe('proposed');
  await expectInert(hostile);
});

// C07: a plan is returned and the no-execution constraint is retained.
test('C07 Plan returns a plan and admits no execution', async () => {
  const planned = await send('c07a', 'Plan how to fix this, but do not implement it.', {
    mode: 'plan',
  });
  expect(planned.outcome.status).toBe('answered');
  await expectInert(planned);

  const hostile = await send('c07b', 'HOSTILE implement it under plan', { mode: 'plan' });
  expect(hostile.outcome.status).not.toBe('started');
  expect(hostile.outcome.status).not.toBe('proposed');
  await expectInert(hostile);
});

// C08: a speculative aside enables nothing.
test('C08 an exploratory aside schedules nothing', async () => {
  const result = await send('c08', 'Maybe we could automate that later.');
  expect(result.outcome.status).toBe('answered');
  await expectInert(result);
});

// C09: an eligible capability is proposed and starts only on the person's selection.
test('C09 building from an existing capability is proposed then started by selection', async () => {
  const proposed = await send('c09', "Build next week's staff schedule.");
  if (proposed.outcome.status !== 'proposed')
    throw new Error(`expected proposal, got ${JSON.stringify(proposed.outcome)}`);
  // Shown, not started, until the person selects it.
  expect((workFor(proposed.sourceMessageId)).tasks).toHaveLength(0);

  const started = await select('c09', proposed.outcome.proposalDigest);
  expect(started.outcome.status).toBe('started');
  const work = workFor(proposed.sourceMessageId);
  expect(work.tasks).toHaveLength(1);
  expect(work.sessions).toHaveLength(1);
  const phases = await phaseNames(proposed);
  expect(phases).toContain('action-selected');
  expect(phases).toContain('task-input');
  expect(phases).toContain('work-input');
});

// C10: the checklist artifact uses the existing capability path identically.
test('C10 making a checklist prepares the artifact, not new software', async () => {
  const proposed = await send('c10', 'Make a receiving checklist.');
  if (proposed.outcome.status !== 'proposed')
    throw new Error(`expected proposal, got ${JSON.stringify(proposed.outcome)}`);
  const started = await select('c10', proposed.outcome.proposalDigest);
  expect(started.outcome.status).toBe('started');
  const work = workFor(proposed.sourceMessageId);
  expect(work.tasks).toHaveLength(1);
  expect(work.sessions).toHaveLength(1);
});

// C11: a verified capability gap is refused by this seam today — honestly, and
// without automatic production activation. The row's positive half (admitting
// a bounded development task) is a separate path this slice does not own; the
// assertion records what is true now and the implementation record says why.
test('C11 a capability-development proposal is refused without activation', async () => {
  const result = await send('c11', 'Create a reusable validator for this unsupported file format.');
  expect(result.outcome.status).toBe('not-started');
  if (result.outcome.status === 'not-started')
    expect(result.outcome.reason).toBe('build-not-reachable');
  await expectInert(result);
});

// C12: an access boundary is explained, never bypassed with new code.
test('C12 a denied tool explains the boundary and builds no bypass', async () => {
  const result = await send('c12', 'The tool says access denied. Make another one.');
  expect(result.outcome.status).toBe('answered');
  await expectInert(result);
});

// C21: a retried message reaches its own receipt — one objective, no second task.
test('C21 a retried message converges on one task and one work receipt', async () => {
  const first = await send('c21', "Build next week's staff schedule.");
  if (first.outcome.status !== 'proposed')
    throw new Error(`expected proposal, got ${JSON.stringify(first.outcome)}`);
  const afterFirst = dispatches.length;

  // The retry is the same command id, so it replays the same message: no second
  // generation, and no second proposal minted.
  const replay = await send('c21', "Build next week's staff schedule.");
  expect(replay.sourceMessageId).toBe(first.sourceMessageId);
  expect(dispatches.length).toBe(afterFirst);
  if (replay.outcome.status !== 'proposed')
    throw new Error(`replayed proposal expected, got ${JSON.stringify(replay.outcome)}`);
  expect(replay.outcome.proposalDigest).toBe(
    first.outcome.status === 'proposed' ? first.outcome.proposalDigest : null,
  );

  const started = await select('c21', first.outcome.proposalDigest);
  expect(started.outcome.status).toBe('started');

  // A second identical selection reads back the committed receipt — still one task.
  const again = await select('c21', first.outcome.proposalDigest);
  expect(again.outcome.status).toBe('started');
  const work = workFor(first.sourceMessageId);
  expect(work.tasks).toHaveLength(1);
  expect(work.sessions).toHaveLength(1);
});

// C22: a narrowing correction is its own message with its own identities —
// the first message's derived receipts are never rewritten under another's ids.
test('C22 a correction message carries its own identities, never rewriting the first', async () => {
  const first = await send('c22a', "Build next week's staff schedule.");
  if (first.outcome.status !== 'proposed')
    throw new Error(`expected proposal, got ${JSON.stringify(first.outcome)}`);
  const startedFirst = await select('c22a', first.outcome.proposalDigest);
  expect(startedFirst.outcome.status).toBe('started');

  const correction = await send('c22b', 'Use last month instead, not this month.');
  expect(correction.sourceMessageId).not.toBe(first.sourceMessageId);
  if (correction.outcome.status !== 'proposed')
    throw new Error(`expected proposal, got ${JSON.stringify(correction.outcome)}`);
  const settledCorrection = await select('c22b', correction.outcome.proposalDigest);

  // The project allows one active Work at a time (native-work.ts: a second
  // start while the first runs is refused 409). The correction's selection
  // still created its own task under its own command ids; only its work was
  // refused, with the refusal recorded on this message's run.
  expect(settledCorrection.outcome.status).toBe('not-started');
  if (settledCorrection.outcome.status === 'not-started')
    expect(settledCorrection.outcome.reason).toBe('refused');
  const correctionPhases = await phaseNames(correction);
  expect(correctionPhases).toContain('task-input');
  expect(correctionPhases).toContain('task-receipt');
  expect(correctionPhases).toContain('work-refused');

  // Each message owns exactly one task under its own derived command ids; the
  // first task's records are untouched and no session exists for the correction.
  expect(workFor(first.sourceMessageId).tasks).toHaveLength(1);
  expect(workFor(first.sourceMessageId).sessions).toHaveLength(1);
  expect(workFor(correction.sourceMessageId).tasks).toHaveLength(1);
  expect(workFor(correction.sourceMessageId).sessions).toHaveLength(0);
  // Supersession of the first draft is a task-domain record, which this seam
  // does not own — noted in the implementation record.
});

// Review attacks: well-formed proposals outside this seam's admitted set are
// each refused with their reason and create nothing.
test('control proposals are refused — targetless at the schema, targeted at admission', async () => {
  // A control with no target_run_id fails the frozen schema's own refinement,
  // so the reply degrades to its answer text: nothing is proposed or started.
  const targetless = await send('atk-ctl-a', 'HOSTILE control without a named job');
  expect(targetless.outcome.status).toBe('answered');
  await expectInert(targetless);

  // A well-formed control that does name a run reaches admission and is
  // refused there — this seam never runs a control path.
  const targeted = await send('atk-ctl-b', 'HOSTILE control that names a run');
  expect(targeted.outcome.status).toBe('not-started');
  if (targeted.outcome.status === 'not-started')
    expect(targeted.outcome.reason).toBe('control-not-reachable');
  await expectInert(targeted);
});

test('an external send is refused, whatever the objective', async () => {
  const result = await send('atk-send', 'HOSTILE send the comparison to the vendor');
  expect(result.outcome.status).toBe('not-started');
  if (result.outcome.status === 'not-started')
    expect(result.outcome.reason).toBe('send-not-reachable');
  await expectInert(result);
});

test('an act naming a project this conversation cannot reach is refused', async () => {
  const result = await send('atk-target', 'HOSTILE write it into the other project');
  expect(result.outcome.status).toBe('not-started');
  if (result.outcome.status === 'not-started')
    expect(result.outcome.reason).toBe('unknown-target');
  await expectInert(result);
});

// C23: an unrelated question beside an active job changes nothing about it.
test('C23 an independent question preserves the active job', async () => {
  const job = await send('c23a', "Build next week's staff schedule.");
  if (job.outcome.status !== 'proposed')
    throw new Error(`expected proposal, got ${JSON.stringify(job.outcome)}`);
  const started = await select('c23a', job.outcome.proposalDigest);
  expect(started.outcome.status).toBe('started');

  const aside = await send('c23b', 'Also, explain what a purchase order is.');
  expect(aside.outcome.status).toBe('answered');
  await expectInert(aside);

  // The active job's evidence is untouched: still its one task and one session.
  const work = workFor(job.sourceMessageId);
  expect(work.tasks).toHaveLength(1);
  expect(work.sessions).toHaveLength(1);
});
