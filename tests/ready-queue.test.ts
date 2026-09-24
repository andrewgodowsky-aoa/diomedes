import { describe, expect, it } from 'vitest';
import type { Change, Need, Session, Task } from '../shared/types';
import { taskEvidence } from '../client/workbench/task-evidence';
import {
  READY_QUEUE_LIMITS,
  holdReason,
  planReadyQueue,
  readyAt,
  type ReadyProjectInput,
} from '../shared/ready-queue';

// H07: the pure half of the Ready queue. Fair order across projects, the global and per-project
// limits, FIFO by Ready time within a project, pause, holds, and agreement with the Board's
// Ready column. The scheduler that acts on this plan is tested in ready-scheduler.test.ts.

const T0 = '2026-09-24T08:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    name: `Task ${id}`,
    description: '',
    from: null,
    owner: 'diomedes',
    state: 'todo',
    reason: null,
    needId: null,
    sessionIds: [],
    changeIds: [],
    createdBy: 'you',
    createdAt: T0,
    moves: [],
    ...over,
  } as Task;
}
function session(taskId: string, state: Session['state'], ended = T0): Session {
  return {
    id: `s-${taskId}-${state}`,
    taskId,
    state,
    startedAt: T0,
    endedAt: ['working', 'queued', 'waiting'].includes(state) ? null : ended,
    sample: true,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'Sample worker', model: null, worker: 1, branch: null, context: null, events: 0 },
  } as unknown as Session;
}

function project(id: string, over: Partial<ReadyProjectInput> = {}): ReadyProjectInput {
  return {
    id,
    autoStart: true,
    paused: null,
    running: 0,
    awaitingDecision: false,
    lastClaimAt: null,
    ready: [],
    ...over,
  };
}
const ready = (...ids: [string, number][]) =>
  ids.map(([taskId, minute]) => ({ taskId, readyAt: at(minute), createdAt: at(minute) }));
const claimed = (plan: ReturnType<typeof planReadyQueue>) =>
  plan.claims.map((claim) => `${claim.projectId}:${claim.taskId}`);

describe('Ready queue plan: limits and fairness', () => {
  it('uses conservative defaults: one per project, two across projects', () => {
    expect(READY_QUEUE_LIMITS).toEqual({ global: 2, perProject: 1 });
  });

  it.each([
    {
      name: 'one project: only its oldest Ready task, whatever else is waiting',
      projects: [project('A', { ready: ready(['a2', 2], ['a1', 1], ['a3', 3]) })],
      expected: ['A:a1'],
    },
    {
      name: 'three projects, global limit two: the two never served, by id',
      projects: [
        project('C', { ready: ready(['c1', 1]) }),
        project('A', { ready: ready(['a1', 5]) }),
        project('B', { ready: ready(['b1', 3]) }),
      ],
      expected: ['A:a1', 'B:b1'],
    },
    {
      name: 'least recently served goes first, not the one with the oldest task',
      projects: [
        project('A', { lastClaimAt: at(50), ready: ready(['a1', 0]) }),
        project('B', { lastClaimAt: at(10), ready: ready(['b1', 40]) }),
        project('C', { lastClaimAt: null, ready: ready(['c1', 45]) }),
      ],
      expected: ['C:c1', 'B:b1'],
    },
    {
      name: 'a busy project is skipped and does not use a global slot twice',
      projects: [
        project('A', { running: 1, ready: ready(['a1', 1]) }),
        project('B', { ready: ready(['b1', 2]) }),
        project('C', { ready: ready(['c1', 3]) }),
      ],
      expected: ['B:b1'],
    },
    {
      name: 'manual work in an automatic-off project counts toward the global limit',
      projects: [
        project('M', { autoStart: false, running: 1 }),
        project('N', { autoStart: false, running: 1 }),
        project('A', { ready: ready(['a1', 1]) }),
      ],
      expected: [],
    },
    {
      name: 'a project with automatic start off is never claimed from',
      projects: [project('A', { autoStart: false, ready: ready(['a1', 1]) })],
      expected: [],
    },
    {
      name: 'a paused project is never claimed from; the next project is',
      projects: [
        project('A', { paused: { at: T0, by: 'you', reason: 'Inventory count' }, ready: ready(['a1', 1]) }),
        project('B', { ready: ready(['b1', 2]) }),
      ],
      expected: ['B:b1'],
    },
    {
      name: 'a held task holds no place: the next one in the project starts',
      projects: [
        project('A', {
          ready: [
            { taskId: 'a1', readyAt: at(1), createdAt: at(1), hold: 'Start it yourself' },
            ...ready(['a2', 2]),
          ],
        }),
      ],
      expected: ['A:a2'],
    },
    {
      name: 'ties on Ready time fall back to creation, then id',
      projects: [
        project('A', {
          ready: [
            { taskId: 'b', readyAt: at(1), createdAt: at(0) },
            { taskId: 'a', readyAt: at(1), createdAt: at(0) },
            { taskId: 'z', readyAt: at(1), createdAt: at(-1) },
          ],
        }),
      ],
      expected: ['A:z'],
    },
  ])('$name', ({ projects, expected }) => {
    expect(claimed(planReadyQueue({ allPaused: null, projects }))).toEqual(expected);
  });

  it('a global pause claims nothing anywhere', () => {
    const plan = planReadyQueue({
      allPaused: { at: T0, by: 'you', reason: 'Closing for the night' },
      projects: [project('A', { ready: ready(['a1', 1]) }), project('B', { ready: ready(['b1', 1]) })],
    });
    expect(plan.claims).toEqual([]);
    expect(plan.items.A[0]).toMatchObject({ why: 'all-paused', position: 1 });
  });

  it('higher limits fill round by round, one per project per round', () => {
    const plan = planReadyQueue({
      allPaused: null,
      limits: { global: 5, perProject: 2 },
      projects: [
        project('A', { ready: ready(['a1', 1], ['a2', 2], ['a3', 3]) }),
        project('B', { ready: ready(['b1', 1], ['b2', 2], ['b3', 3]) }),
        project('C', { ready: ready(['c1', 1]) }),
      ],
    });
    expect(claimed(plan)).toEqual(['A:a1', 'B:b1', 'C:c1', 'A:a2', 'B:b2']);
  });

  it('is starvation-free: as slots free, every waiting project is served in turn', () => {
    // Four projects, each with plenty of work, one slot. Replaying the plan as each run ends
    // serves every project before any is served twice, whatever the Ready times.
    const lines: Record<string, string[]> = {
      A: ['a1', 'a2', 'a3'],
      B: ['b1', 'b2', 'b3'],
      C: ['c1', 'c2', 'c3'],
      D: ['d1', 'd2', 'd3'],
    };
    const last: Record<string, string | null> = { A: null, B: null, C: null, D: null };
    const served: string[] = [];
    for (let tick = 0; tick < 12; tick++) {
      const plan = planReadyQueue({
        allPaused: null,
        limits: { global: 1, perProject: 1 },
        projects: Object.entries(lines).map(([id, tasks]) =>
          project(id, {
            lastClaimAt: last[id],
            // A's work is always oldest; it still gets no more than its turn.
            ready: tasks.map((taskId, index) => ({
              taskId,
              readyAt: at(id === 'A' ? index : 100 + index),
              createdAt: at(0),
            })),
          }),
        ),
      });
      expect(plan.claims).toHaveLength(1);
      const [{ projectId, taskId }] = plan.claims;
      served.push(projectId);
      last[projectId] = at(1000 + tick);
      lines[projectId] = lines[projectId].filter((id) => id !== taskId);
    }
    expect(served).toEqual(['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'A', 'B', 'C', 'D']);
  });
});

describe('Ready queue plan: what each row says', () => {
  it('names the position and the one reason each item is not starting', () => {
    const plan = planReadyQueue({
      allPaused: null,
      projects: [
        project('A', { ready: ready(['a1', 1], ['a2', 2]) }),
        project('B', { running: 1, awaitingDecision: true, ready: ready(['b1', 1]) }),
        project('C', { running: 1, ready: ready(['c1', 1]) }),
        project('D', { ready: ready(['d1', 1]) }),
        project('E', { paused: { at: T0, by: 'you', reason: 'Stocktake' }, ready: ready(['e1', 1]) }),
        project('F', { autoStart: false, ready: ready(['f1', 1]) }),
      ],
    });
    // B and C already hold the two global slots, so A waits for a free one.
    expect(plan.claims).toEqual([]);
    expect(plan.items.A).toEqual([
      expect.objectContaining({ taskId: 'a1', position: 1, why: 'limit' }),
      expect.objectContaining({ taskId: 'a2', position: 2, why: 'in-line', detail: '#2 in line' }),
    ]);
    expect(plan.items.B[0]).toMatchObject({ why: 'awaiting-decision', position: 1 });
    expect(plan.items.C[0]).toMatchObject({ why: 'project-busy', position: 1 });
    expect(plan.items.E[0]).toMatchObject({ why: 'paused', detail: 'Queue paused · #1 in line' });
    expect(plan.items.F[0]).toMatchObject({ why: 'off', detail: 'Start explicitly to run' });
  });

  it('marks what this pass claims as starting and a held task without a place', () => {
    const plan = planReadyQueue({
      allPaused: null,
      projects: [
        project('A', {
          ready: [
            ...ready(['a1', 1], ['a2', 2]),
            { taskId: 'h', readyAt: at(0), createdAt: at(0), hold: 'Start it yourself: sending to Codex needs your confirmation' },
          ],
        }),
      ],
    });
    expect(plan.items.A.map((item) => [item.taskId, item.position, item.why])).toEqual([
      ['a1', 1, 'starting'],
      // Next after the one starting, so it waits for that run rather than for a place.
      ['a2', 2, 'project-busy'],
      ['h', null, 'held'],
    ]);
  });
});

describe('Ready queue eligibility', () => {
  const needs: Need[] = [];
  const changes: Change[] = [];

  it('a task never run is Ready from its creation', () => {
    expect(readyAt(task('t'), [])).toBe(T0);
  });

  it('a stopped, failed or finished run is not started again unless the person reopens it', () => {
    for (const state of ['stopped', 'failed', 'done'] as const) {
      expect(readyAt(task('t'), [session('t', state)])).toBeNull();
      const reopened = task('t', {
        moves: [{ at: at(5), by: 'you', from: 'done', to: 'todo', undoUntil: at(6), undone: false }],
      });
      expect(readyAt(reopened, [session('t', state)])).toBe(at(5));
    }
  });

  it('an undone reopen does not count', () => {
    const undone = task('t', {
      moves: [{ at: at(5), by: 'you', from: 'done', to: 'todo', undoUntil: at(6), undone: true }],
    });
    expect(readyAt(undone, [session('t', 'stopped')])).toBeNull();
  });

  it('active runs, open Needs, waiting changes and deleted or non-todo tasks are not Ready', () => {
    expect(readyAt(task('t'), [session('t', 'working')])).toBeNull();
    expect(readyAt(task('t'), [], [{ id: 'n', taskId: 't', state: 'open' } as unknown as Need])).toBeNull();
    expect(
      readyAt(task('t'), [], [], [{ id: 'c', taskId: 't', state: 'waiting' } as unknown as Change]),
    ).toBeNull();
    expect(readyAt(task('t', { deletedAt: T0 }), [])).toBeNull();
    expect(readyAt(task('t', { state: 'waiting', reason: 'needs-ok' }), [])).toBeNull();
    expect(readyAt(task('t', { state: 'done' }), [])).toBeNull();
  });

  it('everything the queue would start is in the Board’s Ready column', () => {
    const cases: [Task, Session[]][] = [
      [task('t'), []],
      [task('t'), [session('t', 'stopped')]],
      [task('t'), [session('t', 'failed')]],
      [task('t'), [session('t', 'done')]],
      [task('t'), [session('t', 'working')]],
      [task('t', { state: 'done' }), []],
      [
        task('t', { moves: [{ at: at(5), by: 'you', from: 'done', to: 'todo', undoUntil: at(6), undone: false }] }),
        [session('t', 'done')],
      ],
      [
        task('t', { moves: [{ at: at(5), by: 'you', from: 'done', to: 'todo', undoUntil: at(6), undone: false }] }),
        [session('t', 'stopped')],
      ],
    ];
    for (const [item, sessions] of cases)
      if (readyAt(item, sessions, needs, changes) !== null)
        expect(taskEvidence(item, sessions, needs, changes).column).toBe('Ready');
  });
});

describe('Ready queue holds', () => {
  const base = { route: 'codex' as const, routeName: 'Codex', consented: true, serviceOn: true };
  it('the sample route needs no confirmation', () => {
    expect(holdReason({ ...base, route: 'sample', routeName: 'Sample', consented: false, serviceOn: false })).toBeNull();
  });
  it('a service route waits for the person until this task has a start confirmed on it', () => {
    expect(holdReason({ ...base, consented: false })).toBe(
      'Start it yourself: sending to Codex needs your confirmation',
    );
    expect(holdReason(base)).toBeNull();
  });
  it('a route turned off in Settings holds', () => {
    expect(holdReason({ ...base, serviceOn: false })).toBe('Start it yourself: Codex is off in Settings');
  });
  it('a refusal holds, in the Work start path’s own words', () => {
    expect(holdReason({ ...base, route: 'sample', refused: 'This project already has work in progress.' })).toBe(
      'Not started automatically: This project already has work in progress.',
    );
  });
});
