/**
 * The production WorkRowsSource (server/work-rows.ts, plan section 4.8): each payer, each row
 * kind, the verification mapping and the never-list (no file paths, answer text or mail).
 * The store and the harness are in-memory fakes over the real record shapes; nothing here
 * runs a model, and reading rows calls none (A38).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import {
  labelForRoute,
  payerForRoute,
  ProductionWorkRows,
  rowTitle,
  type WorkRowsHarness,
} from '../server/work-rows.js';
import type { Store } from '../server/store.js';
import type { HarnessRun } from '../shared/harness.js';
import type { HandoffView, TeamLeadView } from '../shared/team-delegation.js';
import { manualTaskWorkflow } from '../shared/task-workflow.js';
import type { HistoryEntry, ProjectState, Session, Task, TeamMember } from '../shared/types.js';
import { WORK_ROW_TITLE_LIMIT, type WorkRowsSource } from '../shared/work-rows.js';

const AT = '2026-10-03T10:00:00.000Z';
const PATH = 'Private/payroll notes.md';
const ANSWER = 'Here is the full answer the worker wrote back.';
const MAIL = 'From Astra: the supplier wants the contract by Friday.';

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    taskId: 'T-plain',
    state: 'done',
    startedAt: `2026-10-03T09:0${id.length % 10}:00.000Z`,
    endedAt: null,
    sample: false,
    log: [{ time: AT, sentence: ANSWER, level: 'plain' }],
    entryIds: [],
    needId: null,
    rawReply: ANSWER,
    engine: { name: 'codex', model: 'gpt-6-luna', worker: 1, branch: null, context: 10, events: 1 },
    ...over,
  }) as Session;
const task = (id: string, name: string, over: Partial<Task> = {}): Task =>
  ({ id, name, description: `${MAIL} ${PATH}`, state: 'todo', moves: [], createdAt: AT, ...over }) as Task;
const member = (slotId: string, name: string, engine: TeamMember['engine'], status: TeamMember['status'] = 'idle'): TeamMember => ({
  slotId,
  name,
  role: 'member',
  engine,
  model: null,
  status,
  threadId: null,
  createdAt: AT,
  lastSeenAt: null,
});
const child = (handoffId: string, route: string | null, outcome: HandoffView['outcome'], verified?: HandoffView['verification']): HandoffView => ({
  handoffId,
  role: 'worker',
  stepId: `step-${handoffId}`,
  task: `Edit ${PATH} and report back`,
  scope: [PATH],
  outcome,
  sentence: 'One sentence.',
  attempt: 1,
  retryOf: null,
  reusedFrom: null,
  childRunId: `R-${handoffId}`,
  agent: null,
  route,
  profile: null,
  budget: null,
  used: null,
  text: ANSWER,
  reason: null,
  models: [{ reported: 'secret-model-name', engine: route } as never],
  verification: verified ?? null,
});

class FakeStore extends EventEmitter {
  constructor(readonly project: Partial<ProjectState>) {
    super();
  }
  state(id: string) {
    if (id !== 'P1') throw new Error('This project was not found.');
    return this.project as ProjectState;
  }
  projectIds() {
    return ['P1', 'HOME'];
  }
  isHomeProject(id: string) {
    return id === 'HOME';
  }
}

function source(project: Partial<ProjectState>, harness?: WorkRowsHarness) {
  const store = new FakeStore({ sessions: [], tasks: [], history: [], team: { members: [], messages: [], runs: [] }, ...project });
  return { store, rows: new ProductionWorkRows({ store: store as unknown as Store, harness, now: () => AT }) };
}

describe('payer and label by route', () => {
  test('each payer', () => {
    expect(payerForRoute('nectovia')).toBe('nectovia-credits');
    for (const route of ['aws-bedrock', 'azure-openai', 'openrouter', 'google-vertex']) expect(payerForRoute(route)).toBe('your-key');
    for (const route of ['codex', 'claude-code', 'opencode', 'cursor', 'devin', 'oh-my-pi'])
      expect(payerForRoute(route)).toBe('your-subscription');
    for (const route of ['sample', 'native-fixture', 'probe']) expect(payerForRoute(route)).toBe('local');
    for (const route of ['mystery', null, undefined, '']) expect(payerForRoute(route)).toBe('unknown');
  });

  test('labels are the Console route names; a managed row is Nectovia and names no model or vendor', () => {
    expect(labelForRoute('codex')).toBe('ChatGPT');
    expect(labelForRoute('claude-code')).toBe('Claude Code');
    expect(labelForRoute('openrouter')).toBe('OpenRouter');
    expect(labelForRoute('nectovia')).toBe('Nectovia');
    expect(labelForRoute('native-fixture')).toBe('Sample');
    expect(labelForRoute(null)).toBe('Not reported');
  });

  test('a title is capped at the relay limit', () => {
    const long = 'Rewrite the whole fall menu with new prices and descriptions for every dish we serve on the patio';
    expect(rowTitle(long).length).toBeLessThanOrEqual(WORK_ROW_TITLE_LIMIT);
    expect(rowTitle(long).endsWith('…')).toBe(true);
    expect(rowTitle('  Plain   name ')).toBe('Plain name');
  });
});

describe('ProductionWorkRows', () => {
  test('each kind, in order: active work first with its H14 children, then the three that ended last', async () => {
    const manualCard = task('T-manual', 'Proofread the menu', { workflow: manualTaskWorkflow(), assignedTo: 'S2' });
    const run = { id: 'R-lead', state: 'running', sessionId: 'S-loop' } as HarnessRun;
    const view = {
      workers: [
        child('h1', 'nectovia', 'running'),
        child('h2', 'aws-bedrock', 'completed', { state: 'verified', sentence: 'All passed.' }),
        child('h3', 'codex', 'failed', { state: 'uncertain', sentence: 'Changed after.' }),
        child('h4', 'native-fixture', 'reused'),
        child('h5', 'mystery', 'died'),
      ],
      advice: [child('a1', 'openrouter', 'completed')],
    } as unknown as TeamLeadView;
    const harness: WorkRowsHarness = {
      runIdFor: vi.fn(async () => 'R-lead'),
      run: vi.fn(async () => run),
      teamView: vi.fn(async () => view),
    };
    const { rows } = source(
      {
        tasks: [task('T-lead', 'Plan the reopening'), task('T-member', 'Answer the team mail'), manualCard, task('T-plain', 'Try the sample')],
        team: {
          members: [member('S1', 'Astra', 'claude-code'), member('S2', 'Bram', 'codex'), member('S3', 'Cleo', 'openrouter', 'working')],
          messages: [{ id: 'M1', to: 'S1', from: 'owner', type: 'message', content: MAIL, read: false, createdAt: AT, threadId: null, runId: null, approvalId: null }],
          runs: [],
        },
        sessions: [
          session('S-old', { route: 'codex', state: 'done', endedAt: '2026-10-03T08:00:00.000Z' }),
          session('S-member', { route: 'claude-code', slotId: 'S1', taskId: 'T-member', state: 'done', endedAt: '2026-10-03T09:30:00.000Z' }),
          session('S-manual', { route: 'codex', taskId: 'T-manual', state: 'stopped', endedAt: '2026-10-03T09:40:00.000Z' }),
          session('S-sample', { sample: true, engine: { name: 'sample', model: null, worker: 1, branch: null, context: null, events: 1 }, state: 'failed', endedAt: '2026-10-03T09:50:00.000Z' }),
          session('S-loop', { route: 'nectovia', taskId: 'T-lead', state: 'working', engine: { name: 'diomedes-loop', model: 'secret-model-name', worker: 1, branch: null, context: null, events: 1 } }),
        ],
      },
      harness,
    );
    const snapshot = (await rows.snapshot('P1'))!;
    expect(snapshot).toMatchObject({ projectId: 'P1', rootRunId: 'R-lead', taskTitle: 'Plan the reopening', at: AT });
    expect(snapshot.rows.map((row) => [row.rowId, row.kind, row.label, row.title, row.state, row.verification, row.payer])).toEqual([
      ['session:S-loop', 'session', 'Nectovia', 'Plan the reopening', 'working', 'not-run', 'nectovia-credits'],
      ['h14:h1', 'h14-worker', 'Nectovia', 'Plan the reopening', 'working', 'not-run', 'nectovia-credits'],
      ['h14:h2', 'h14-worker', 'AWS Bedrock', 'Plan the reopening', 'answered', 'verified', 'your-key'],
      ['h14:h3', 'external-worker', 'ChatGPT', 'Plan the reopening', 'failed', 'unverified', 'your-subscription'],
      ['h14:h4', 'h14-worker', 'Sample', 'Plan the reopening', 'answered', 'not-run', 'local'],
      ['h14:h5', 'h14-worker', 'mystery', 'Plan the reopening', 'unknown', 'not-run', 'unknown'],
      ['session:S-sample', 'session', 'Sample', 'Try the sample', 'failed', 'not-run', 'local'],
      ['session:S-manual', 'team-member', 'ChatGPT', 'Proofread the menu', 'stopped', 'not-run', 'your-subscription'],
      ['session:S-member', 'team-member', 'Claude Code', 'Answer the team mail', 'answered', 'not-run', 'your-subscription'],
      ['member:S3', 'team-member', 'OpenRouter', 'Cleo', 'working', 'not-run', 'your-key'],
    ]);
    // The never-list: no path, answer, hand-off text, mail or model name anywhere in the output.
    const wire = JSON.stringify(snapshot);
    for (const forbidden of [PATH, 'payroll', ANSWER, MAIL, 'supplier', 'secret-model-name', 'gpt-6-luna'])
      expect(wire).not.toContain(forbidden);
    // A Session's loop run is looked up once; later reads reuse it.
    await rows.snapshot('P1');
    expect(harness.runIdFor).toHaveBeenCalledTimes(1);
  });

  test('a stop the runtime has not confirmed reads stop requested; verification comes from History', async () => {
    const declared = { digest: 'd1', checks: [{ id: 'c1', kind: 'review' }] };
    const check = (outcome: 'passed' | 'failed') => ({
      id: 'c1', kind: 'file-exists', label: 'File', outcome, sentence: 'Checked.', evidence: [], ranAt: AT, durationMs: 1,
      origin: { kind: 'application' },
    });
    const record = (sessionId: string, outcome: 'passed' | 'failed', declaredChecks = 1) => ({
      verification: {
        protocolVersion: 1, id: `V-${sessionId}`, sessionId, taskId: `T-${sessionId}`, declarationDigest: 'd1', declaredChecks,
        requestedBy: 'you', startedAt: AT, endedAt: AT, producer: null, outputs: [], bound: [], checks: [check(outcome)],
      },
    }) as unknown as HistoryEntry;
    const { rows } = source({
      tasks: [
        task('T-live', 'Stop me', { stopReceipts: [{ sessionId: 'live', acknowledged: false } as never] }),
        task('T-ok', 'Verified work', { acceptance: declared as never }),
        task('T-bad', 'Failed work', { acceptance: declared as never }),
        task('T-none', 'Unchecked work', { acceptance: declared as never }),
      ],
      sessions: [
        session('live', { taskId: 'T-live', state: 'working', route: 'codex' }),
        session('ok', { taskId: 'T-ok', state: 'done', route: 'codex', endedAt: '2026-10-03T09:10:00.000Z' }),
        session('bad', { taskId: 'T-bad', state: 'done', route: 'codex', endedAt: '2026-10-03T09:20:00.000Z' }),
        session('none', { taskId: 'T-none', state: 'done', route: 'codex', endedAt: '2026-10-03T09:30:00.000Z' }),
      ],
      history: [record('ok', 'passed'), record('bad', 'failed')],
    });
    const snapshot = (await rows.snapshot('P1'))!;
    expect(snapshot.rows.map((row) => [row.title, row.state, row.verification])).toEqual([
      ['Stop me', 'stop-requested', 'not-run'],
      ['Unchecked work', 'answered', 'not-run'],
      ['Failed work', 'answered', 'failed'],
      ['Verified work', 'answered', 'verified'],
    ]);
    expect(snapshot.rootRunId).toBeNull();
    expect(snapshot.taskTitle).toBe('Stop me');
  });

  test('projects, subscribe and an unknown project, as the relay reads them', async () => {
    const { store, rows } = source({});
    const contract: WorkRowsSource = rows;
    expect(await contract.projects()).toEqual(['P1']);
    expect(await contract.snapshot('P-unknown')).toBeNull();
    const heard: string[] = [];
    const off = contract.subscribe((projectId) => heard.push(projectId));
    store.emit('change', 'P1');
    off();
    store.emit('change', 'P1');
    expect(heard).toEqual(['P1']);
    expect((await contract.snapshot('P1'))!.rows).toEqual([]);
  });

  test('without a harness a loop Session stands alone, and an unreadable run never breaks the read', async () => {
    const project = {
      tasks: [task('T-lead', 'Plan the reopening')],
      sessions: [session('S-loop', { route: 'aws-bedrock', taskId: 'T-lead', state: 'working', engine: { name: 'diomedes-loop', model: null, worker: 1, branch: null, context: null, events: 1 } })],
    };
    expect((await source(project).rows.snapshot('P1'))!.rows).toHaveLength(1);
    const broken: WorkRowsHarness = {
      runIdFor: async () => { throw new Error('unreadable'); },
      run: async () => null,
      teamView: async () => null,
    };
    const snapshot = (await source(project, broken).rows.snapshot('P1'))!;
    expect(snapshot.rows.map((row) => [row.kind, row.payer])).toEqual([['session', 'your-key']]);
    expect(snapshot.rootRunId).toBeNull();
  });

  test('a live loop Session whose run is written after it is asked again; an ended one only once', async () => {
    const loop = { name: 'diomedes-loop', model: null, worker: 1, branch: null, context: null, events: 1 };
    const live = {
      tasks: [task('T-lead', 'Plan the reopening')],
      sessions: [session('S-loop', { route: 'aws-bedrock', taskId: 'T-lead', state: 'working', engine: loop })],
    };
    let written = false;
    const harness: WorkRowsHarness = {
      runIdFor: vi.fn(async () => (written ? 'R-lead' : null)),
      run: vi.fn(async () => ({ id: 'R-lead', state: 'running', sessionId: 'S-loop' }) as HarnessRun),
      teamView: vi.fn(async () => ({ workers: [child('h1', 'aws-bedrock', 'running')] }) as unknown as TeamLeadView),
    };
    const { rows } = source(live, harness);
    expect((await rows.snapshot('P1'))!.rootRunId).toBeNull();
    written = true;
    const later = (await rows.snapshot('P1'))!;
    expect(later.rootRunId).toBe('R-lead');
    expect(later.rows.map((row) => row.rowId)).toEqual(['session:S-loop', 'h14:h1']);
    expect(harness.runIdFor).toHaveBeenCalledTimes(2);

    const ended = { ...live, sessions: [session('S-loop', { route: 'aws-bedrock', taskId: 'T-lead', state: 'done', endedAt: AT, engine: loop })] };
    const none: WorkRowsHarness = { runIdFor: vi.fn(async () => null), run: vi.fn(async () => null), teamView: vi.fn(async () => null) };
    const quiet = source(ended, none).rows;
    await quiet.snapshot('P1');
    await quiet.snapshot('P1');
    expect(none.runIdFor).toHaveBeenCalledTimes(1);
  });
});
