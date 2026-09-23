import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project, Session, Task } from '../shared/types';
import { taskEvidence } from '../client/workbench/task-evidence';
import { MAX_SEGMENTS, segmentModel } from '../client/console/segment-bar-model';
import { SegmentBar } from '../client/console/SegmentBar';
import {
  planGroups,
  planName,
  projectProgress,
  stepState,
} from '../client/console/progress-bars';

// Where a segment bar may be drawn, from which record, and how each record's
// states become segments (contract A9). The mapping is pure, so it is proved
// here directly; the browser specs prove the bar's aria values on screen.

type Status = Project['status'];
const status = (over: Partial<Status>): Pick<Project, 'status'> => ({
  status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0, ...over },
});

const AT = '2026-09-22T08:00:00.000Z';
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
    createdAt: AT,
    moves: [],
    ...over,
  } as Task;
}
function session(taskId: string, state: Session['state'], id = `s-${taskId}`): Session {
  return {
    id,
    taskId,
    state,
    startedAt: AT,
    endedAt: state === 'working' || state === 'queued' || state === 'waiting' ? null : AT,
    sample: true,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'Sample', model: null },
  } as unknown as Session;
}
const fromPlan = (plan: string, step: number) => ({ from: { plan, step } });

describe('a project counted as a bar', () => {
  it('draws no bar for a project with no tasks', () => {
    expect(projectProgress(status({}))).toBeNull();
    expect(projectProgress(status({ tasksTotal: 0, tasksDone: 0, working: 2 }))).toBeNull();
    // A record that never counted is not a count either.
    expect(projectProgress({ status: undefined } as unknown as Pick<Project, 'status'>)).toBeNull();
  });

  it('lights exactly the tasks the record says are done, in its own words', () => {
    const input = projectProgress(status({ tasksTotal: 4, tasksDone: 3 }))!;
    const model = segmentModel(input);
    // Nothing runs, so no task is shown as moving.
    expect(model.segments).toEqual(['done', 'done', 'done', 'pending']);
    expect(model.text).toBe('3 of 4 tasks done');
  });

  it('says one task in the singular', () => {
    expect(segmentModel(projectProgress(status({ tasksTotal: 1, tasksDone: 0 }))!).text).toBe('0 of 1 task done');
    expect(segmentModel(projectProgress(status({ tasksTotal: 1, tasksDone: 1 }))!).text).toBe('1 of 1 task done');
  });

  it('marks the next task as moving only while the project runs something', () => {
    const model = segmentModel(projectProgress(status({ tasksTotal: 4, tasksDone: 1, working: 1 }))!);
    expect(model.segments).toEqual(['done', 'active', 'pending', 'pending']);
  });

  it('puts the needs-you colour on the next task while the project waits on the person', () => {
    const model = segmentModel(
      projectProgress(status({ tasksTotal: 3, tasksDone: 1, working: 1, needsYou: 1 }))!,
    );
    expect(model.segments).toEqual(['done', 'blocked', 'pending']);
    expect(model.text).toBe('1 of 3 tasks done');
  });

  it('groups a project with more than twelve tasks without losing the waiting one', () => {
    const model = segmentModel(projectProgress(status({ tasksTotal: 30, tasksDone: 20, needsYou: 1 }))!);
    expect(model.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(model.segments).toContain('blocked');
    expect(model.text).toBe('20 of 30 tasks done');
  });
});

describe("a plan's tasks counted as a bar on the Board", () => {
  it('maps each Board column to the segment it draws', () => {
    expect(stepState('Done', null)).toBe('done');
    expect(stepState('Working', null)).toBe('active');
    expect(stepState('Review', null)).toBe('blocked');
    expect(stepState('Blocked', { state: 'waiting' })).toBe('blocked');
    expect(stepState('Blocked', { state: 'failed' })).toBe('failed');
    expect(stepState('Queued', { state: 'queued' })).toBe('pending');
    expect(stepState('Ready', null)).toBe('pending');
  });

  it('names a plan by its file, whatever folder it is in', () => {
    expect(planName('plans/Week 38.md')).toBe('Week 38.md');
    expect(planName('plans\\deliveries\\checklist.md')).toBe('checklist.md');
    expect(planName('menu.md')).toBe('menu.md');
  });

  it('draws nothing when no plan produced more than one task', () => {
    const tasks = [task('a'), task('b', fromPlan('plans/one.md', 1))];
    expect(planGroups(tasks, (t) => taskEvidence(t, []))).toEqual([]);
  });

  it("orders a plan's tasks by step and reads each state from the Board's own projection", () => {
    const tasks = [
      task('c', { ...fromPlan('plans/deliveries.md', 3), state: 'todo' }),
      task('a', { ...fromPlan('plans/deliveries.md', 1), state: 'done' }),
      task('d', { ...fromPlan('plans/deliveries.md', 4), state: 'todo' }),
      task('b', { ...fromPlan('plans/deliveries.md', 2), state: 'working' }),
      task('x', { ...fromPlan('plans/deliveries.md', 5), state: 'todo', deletedAt: AT }),
    ];
    const sessions = [session('b', 'working'), session('c', 'failed'), session('a', 'done')];
    const groups = planGroups(tasks, (t) => taskEvidence(t, sessions));
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('deliveries.md');
    expect(groups[0].steps.map((step) => step.label)).toEqual(['Task a', 'Task b', 'Task c', 'Task d']);
    // done, a run in progress, a failed run, and one still ahead.
    expect(groups[0].steps.map((step) => step.state)).toEqual(['done', 'active', 'failed', 'pending']);
    const model = segmentModel({ steps: groups[0].steps, noun: 'tasks done' });
    expect(model.text).toBe('1 of 4 tasks done');
  });

  it('shows a task waiting on the person in the needs-you colour', () => {
    const tasks = [
      task('a', { ...fromPlan('plans/week.md', 1), state: 'done' }),
      task('b', { ...fromPlan('plans/week.md', 2), state: 'waiting', reason: 'needs-ok' }),
    ];
    const groups = planGroups(tasks, (t) => taskEvidence(t, []));
    expect(groups[0].steps.map((step) => step.state)).toEqual(['done', 'blocked']);
  });

  it('keeps a long plan to twelve segments and still shows its failure', () => {
    const tasks = Array.from({ length: 30 }, (_, index) =>
      task(`t${index}`, {
        ...fromPlan('plans/long.md', index + 1),
        state: index < 10 ? 'done' : 'todo',
      }),
    );
    const sessions = [session('t17', 'failed')];
    const groups = planGroups(tasks, (t) => taskEvidence(t, sessions));
    const model = segmentModel({ steps: groups[0].steps, noun: 'tasks done' });
    expect(model.total).toBe(30);
    expect(model.done).toBe(10);
    expect(model.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    expect(model.segments).toContain('failed');
  });
});

describe('a decorative bar', () => {
  it('has no progressbar role, hides its track, and keeps a visible caption readable', () => {
    const html = renderToStaticMarkup(
      createElement(SegmentBar, { label: 'Linen tasks', total: 4, done: 3, noun: 'tasks done', decorative: true }),
    );
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('class="seg-track" aria-hidden="true"');
    // The caption is the only thing saying the count, so it is not hidden.
    expect(html).toContain('<span class="seg-caption">3 of 4 tasks done</span>');
  });

  it('draws the indeterminate form with nothing for assistive technology', () => {
    const html = renderToStaticMarkup(
      createElement(SegmentBar, { label: 'Working task', caption: null, decorative: true }),
    );
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuetext');
    expect(html).toContain('seg-scan');
    expect(html).not.toContain('seg-caption');
  });

  it('keeps the default bar a progressbar with its caption read once', () => {
    const html = renderToStaticMarkup(
      createElement(SegmentBar, { label: 'Linen tasks', total: 4, done: 3, noun: 'tasks done' }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('<span class="seg-caption" aria-hidden="true">3 of 4 tasks done</span>');
  });
});
