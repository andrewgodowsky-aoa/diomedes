/**
 * H14's pure rules and its ledger, row by row: scope and budget checks, the
 * authority narrowing, how a child's record reads as an outcome, the Team
 * projection (including a reuse chain across lead retries), and the
 * append-only ledger's handling of a torn final line.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TEAM_LIMITS,
  assignedBudget,
  assignmentKey,
  budgetRefusal,
  childCapabilities,
  harnessBudgetOf,
  outcomeOf,
  reportedTokens,
  scopeRefusal,
  teamLeadView,
  type HandoffEvent,
  type TeamConfig,
} from '../shared/team-delegation.js';
import type { HarnessRun } from '../shared/harness.js';
import { HandoffLedger } from '../server/team/handoff-ledger.js';

const role = {
  agent: { id: 'diomedes.general', version: '1.0.0', name: 'General Assistant', ceiling: 'auto-review' },
  guidance: '',
  artifact: 'plan.markdown',
  route: 'native-fixture',
  model: null,
  accountRoute: null,
  profile: null,
};
const config: TeamConfig = {
  v: 1,
  scope: ['a.md', 'b.md'],
  worker: { ...role, budget: { turns: 4, tokens: null, wallMs: null } },
  advisor: null,
  limits: { depth: 1, concurrentWorkers: 3, workersPerRun: 6, advicePerRun: 2 },
};
const at = '2026-09-24T00:00:00.000Z';
const opened = (leadRunId: string, handoffId: string, childRunId: string, task: string, extra: Partial<HandoffEvent> = {}): HandoffEvent =>
  ({
    v: 1,
    kind: 'opened',
    at,
    handoffId,
    leadRunId,
    taskId: 'T1',
    role: 'worker',
    stepId: 'team:1',
    childRunId,
    envelopeId: `${handoffId}-e`,
    task,
    scope: ['b.md'],
    budget: { turns: 4, tokens: null, wallMs: null },
    agent: role.agent,
    route: 'native-fixture',
    model: null,
    profile: null,
    attempt: 1,
    retryOf: null,
    ...extra,
  }) as HandoffEvent;
const child = (id: string, state: HarnessRun['state'], extra: Partial<HarnessRun> = {}): HarnessRun =>
  ({
    id,
    state,
    steps: [],
    used: { units: 2, modelCalls: 2, toolCalls: 1 },
    result: state === 'completed' ? { text: `${id} answered` } : null,
    failure: null,
    cancelReason: null,
    createdAt: at,
    updatedAt: at,
    ...extra,
  }) as HarnessRun;

describe('the proposed defaults', () => {
  test('depth 1 and at most three workers at once', () => {
    expect(TEAM_LIMITS.depth).toBe(1);
    expect(TEAM_LIMITS.concurrentWorkers).toBe(3);
  });
});

describe('scope', () => {
  test.each([
    [['b.md'], ['a.md', 'b.md'], null],
    [['b.md'], null, null],
    [['c.md'], ['a.md', 'b.md'], 'c.md is outside what the lead may read, so a worker cannot be given it.'],
    [['c.md', 'd.md'], ['a.md'], 'c.md, d.md are outside what the lead may read, so a worker cannot be given them.'],
    [[], ['a.md'], 'A worker needs an explicit list of the files it may read.'],
  ])('%j inside %j → %s', (worker, lead, expected) => {
    expect(scopeRefusal(worker, lead)).toBe(expected);
  });
  test('a scope longer than the limit is refused', () => {
    const many = Array.from({ length: TEAM_LIMITS.scopeFiles + 1 }, (_, index) => `f${index}.md`);
    expect(scopeRefusal(many, null)).toBe(`A worker may be given at most ${TEAM_LIMITS.scopeFiles} files.`);
  });
});

describe('budget', () => {
  const admitted = { turns: 4, tokens: 1000, wallMs: 60_000 };
  test('the model may ask for fewer turns, never more', () => {
    expect(assignedBudget(admitted, {})).toEqual({ budget: admitted, refusal: null });
    expect(assignedBudget(admitted, { turns: 2 })).toEqual({ budget: { ...admitted, turns: 2 }, refusal: null });
    expect(assignedBudget(admitted, { turns: 5 })).toEqual({
      budget: null,
      refusal: 'This worker asked for 5 turns; its budget allows at most 4.',
    });
  });
  test('an admitted budget is held to its ceilings', () => {
    expect(budgetRefusal(admitted)).toBeNull();
    expect(budgetRefusal({ ...admitted, turns: 0 })).toBe('A worker takes between 1 and 8 turns.');
    expect(budgetRefusal({ ...admitted, tokens: TEAM_LIMITS.maxTokens + 1 })).toMatch(/token budget/);
    expect(budgetRefusal({ ...admitted, wallMs: 10 })).toMatch(/time budget/);
  });
  test('turns map to one model and one tool call each', () => {
    expect(harnessBudgetOf(admitted)).toEqual({ units: 8, modelCalls: 4, toolCalls: 4, wallMs: 60_000 });
  });
  test('reported tokens are summed from succeeded model steps only', () => {
    const run = {
      steps: [
        { intent: { kind: 'model' }, state: 'succeeded', output: { usage: { inputTokens: 500, outputTokens: 100 } } },
        { intent: { kind: 'model' }, state: 'failed', output: { usage: { inputTokens: 900 } } },
        { intent: { kind: 'tool' }, state: 'succeeded', output: { usage: { inputTokens: 900 } } },
      ],
    } as unknown as HarnessRun;
    expect(reportedTokens(run)).toBe(600);
    expect(reportedTokens({ steps: [] } as unknown as HarnessRun)).toBeNull();
  });
});

describe('authority', () => {
  test('a child holds the lead’s capabilities or fewer, never more', () => {
    expect(childCapabilities(['write-project-file'], 'auto-review')).toEqual(['write-project-file']);
    expect(childCapabilities(['write-project-file'], 'review')).toEqual([]);
    expect(childCapabilities([], 'full')).toEqual([]);
  });
});

describe('outcome of a child run', () => {
  test.each([
    ['completed', null, null, true, 'completed'],
    ['cancelled', 'the lead that handed it this task was stopped', null, true, 'stopped'],
    ['failed', null, 'invoice.md is not in the project.', true, 'failed'],
    ['failed', null, 'budget exceeded: model calls', true, 'stopped'],
    ['failed', null, 'Agent turn limit reached.', true, 'stopped'],
    ['reconcile_required', null, null, true, 'died'],
    ['running', null, null, true, 'running'],
    ['running', null, null, false, 'died'],
  ] as const)('%s (%s / %s), lead live %s → %s', (state, cancelReason, failure, leadLive, expected) => {
    expect(
      outcomeOf({ state, cancelReason, failure: failure ? { name: 'HarnessError', message: failure } : null }, leadLive),
    ).toBe(expected);
  });
});

describe('the Team projection', () => {
  test('a retried lead reuses a finished answer through a chain, and reruns a failed one as the next attempt', () => {
    const events: HandoffEvent[] = [
      opened('L1', 'L1-t1-0', 'L1-w1-0', 'Read b.md'),
      opened('L1', 'L1-t1-1', 'L1-w1-1', 'Read a.md', { scope: ['a.md'] } as Partial<HandoffEvent>),
      { v: 1, kind: 'reused', at, handoffId: 'L2-t1-0', leadRunId: 'L2', role: 'worker', stepId: 'team:1', from: 'L1-t1-0', task: 'Read b.md', scope: ['b.md'] },
      opened('L2', 'L2-t1-1', 'L2-w1-1', 'Read a.md', { scope: ['a.md'], attempt: 2, retryOf: 'L1-t1-1' } as Partial<HandoffEvent>),
      { v: 1, kind: 'reused', at, handoffId: 'L3-t1-0', leadRunId: 'L3', role: 'worker', stepId: 'team:1', from: 'L2-t1-0', task: 'Read b.md', scope: ['b.md'] },
    ];
    const children = [
      child('L1-w1-0', 'completed'),
      child('L1-w1-1', 'failed', { failure: { name: 'HarnessError', message: 'a.md is not in the project.' } }),
      child('L2-w1-1', 'completed'),
    ];
    const first = teamLeadView({ lead: { id: 'L1', taskId: 'T1', state: 'cancelled' }, config, retryOf: null, events, children, leadVerification: null });
    expect(first.workers.map((item) => [item.handoffId, item.outcome])).toEqual([
      ['L1-t1-0', 'completed'],
      ['L1-t1-1', 'failed'],
    ]);
    expect(first.workers[1].sentence).toBe('Failed before it answered. Its lead stopped; retry the lead to run it again.');
    const second = teamLeadView({
      lead: { id: 'L2', taskId: 'T1', state: 'completed' },
      config,
      retryOf: { runId: 'L1', attempt: 2 },
      events,
      children,
      leadVerification: { state: 'verified', sentence: '1 declared check passed.' },
    });
    expect(second.workers.map((item) => [item.handoffId, item.outcome, item.text, item.attempt, item.retryOf, item.reusedFrom])).toEqual([
      ['L2-t1-0', 'reused', 'L1-w1-0 answered', 1, null, 'L1-t1-0'],
      ['L2-t1-1', 'completed', 'L2-w1-1 answered', 2, 'L1-t1-1', null],
    ]);
    expect(second.workers[1].verification).toEqual({ state: 'verified', sentence: 'Through the lead’s outcome: 1 declared check passed.' });
    // A reuse of a reuse still carries the original answer.
    const third = teamLeadView({ lead: { id: 'L3', taskId: 'T1', state: 'running' }, config, retryOf: null, events, children, leadVerification: null });
    expect(third.workers[0]).toMatchObject({ outcome: 'reused', text: 'L1-w1-0 answered', reusedFrom: 'L2-t1-0' });
  });

  test('a replayed step that appended its event twice is read once', () => {
    const event = opened('L1', 'L1-t1-0', 'L1-w1-0', 'Read b.md');
    const view = teamLeadView({
      lead: { id: 'L1', taskId: 'T1', state: 'running' },
      config,
      retryOf: null,
      events: [event, event],
      children: [child('L1-w1-0', 'running')],
      leadVerification: null,
    });
    expect(view.workers).toHaveLength(1);
    expect(view.workers[0].outcome).toBe('running');
  });

  test('assignments match on role, task and scope, whatever the scope’s order', () => {
    expect(assignmentKey('worker', 'Read', ['b.md', 'a.md'])).toBe(assignmentKey('worker', 'Read', ['a.md', 'b.md']));
    expect(assignmentKey('worker', 'Read', ['a.md'])).not.toBe(assignmentKey('advisor', 'Read', ['a.md']));
  });
});

describe('the handoff ledger', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h14-ledger-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('appends in order, never rewrites, and skips a torn final line without repairing it', async () => {
    const ledger = new HandoffLedger(dir);
    await ledger.append('P1', opened('L1', 'L1-t1-0', 'L1-w1-0', 'Read b.md'));
    await ledger.append('P1', opened('L1', 'L1-t1-1', 'L1-w1-1', 'Read a.md'));
    const file = ledger.file('P1');
    const intact = await fs.readFile(file, 'utf8');
    // A process that died mid-append leaves half a line.
    await fs.appendFile(file, '{"v":1,"kind":"settled","handoff');
    const read = await ledger.read('P1');
    expect(read.events.map((event) => event.handoffId)).toEqual(['L1-t1-0', 'L1-t1-1']);
    expect(read.skipped).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe(`${intact}{"v":1,"kind":"settled","handoff`);
    expect(await ledger.forLead('P1', 'L2')).toEqual([]);
  });

  test('refuses to write an event that does not match its shape', async () => {
    const ledger = new HandoffLedger(dir);
    await expect(ledger.append('P1', { v: 1, kind: 'opened' } as unknown as HandoffEvent)).rejects.toThrow();
    expect(await ledger.read('P1')).toEqual({ events: [], skipped: 0 });
  });

  test('concurrent appends never interleave', async () => {
    const ledger = new HandoffLedger(dir);
    await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.append('P1', opened('L1', `L1-t1-${index}`, `L1-w1-${index}`, 'x'))));
    const read = await ledger.read('P1');
    expect(read.skipped).toBe(0);
    expect(new Set(read.events.map((event) => event.handoffId)).size).toBe(20);
  });
});
