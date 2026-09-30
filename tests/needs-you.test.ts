import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evidenceTone, needsYou, type NeedsYouItem, type NeedsYouRecords } from '../shared/needs-you';
import { taskEvidence } from '../shared/task-evidence';
import type { Session, Task, TaskWorkflow } from '../shared/types';
import { Store } from '../server/store';
import { changeFixture, needFixture, sessionFixture } from './workbench-fixtures';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, name: `Task ${id}`, description: '', from: null, owner: 'you', state: 'todo', reason: null,
    needId: null, sessionIds: [], changeIds: [], createdBy: 'you', createdAt: '2026-09-28T08:00:00Z',
    moves: [], ...patch,
  };
}
const run = (taskId: string, state: Session['state'], patch: Partial<Session> = {}): Session =>
  sessionFixture({ id: `run-${taskId}`, taskId, state, ...patch });
const records = (patch: Partial<NeedsYouRecords>): NeedsYouRecords => ({
  tasks: [], sessions: [], needs: [], changes: [], ...patch,
});
const kinds = (items: NeedsYouItem[]) => items.map((item) => `${item.id} ${item.kind}`).sort();
const workflow = (patch: Partial<TaskWorkflow>): TaskWorkflow =>
  ({ revision: 1, phase: 'plan', continuation: 'stop-on-phase-change', inbox: false, maxTurns: 8,
    handoffs: [], ...patch }) as TaskWorkflow;

describe('the one needs-you rule', () => {
  it('counts an open approval once, though its task also shows under Review', () => {
    const items = needsYou(records({
      tasks: [task('a', { state: 'waiting', reason: 'needs-ok' })],
      sessions: [run('a', 'waiting')],
      needs: [needFixture({ id: 'n1', taskId: 'a', sessionId: 'run-a', what: 'Send the quote' })],
    }));
    expect(kinds(items)).toEqual(['need:n1 approval']);
    expect(items[0]).toMatchObject({
      label: 'Task a', detail: 'Send the quote', taskId: 'a', needId: 'n1', sessionId: 'run-a',
    });
  });

  it('counts every Review task: a phase to approve, changes to review, a task record to review', () => {
    const items = needsYou(records({
      tasks: [
        task('phase', { workflow: workflow({ pendingPhase: 'build' }) }),
        task('changes', { state: 'waiting' }),
        task('record', { state: 'waiting', reason: 'needs-ok' }),
      ],
      changes: [changeFixture({ taskId: 'changes' })],
    }));
    expect(kinds(items)).toEqual(['task:changes review', 'task:phase review', 'task:record review']);
    expect(items.find((item) => item.taskId === 'phase')?.detail).toBe('Approve the next phase to continue');
  });

  it('counts a run that failed or went wrong as a failure, whatever else its record says', () => {
    const items = needsYou(records({
      tasks: [
        task('failed'),
        task('checking', { state: 'waiting', reason: 'went-wrong' }),
        task('stopped', { state: 'waiting', reason: 'went-wrong' }),
        task('record', { state: 'waiting', reason: 'went-wrong' }),
      ],
      sessions: [run('failed', 'failed'), run('checking', 'waiting'), run('stopped', 'stopped')],
    }));
    expect(kinds(items)).toEqual([
      'task:checking failed', 'task:failed failed', 'task:record failed', 'task:stopped failed',
    ]);
  });

  it('leaves out what waits on no one: a run on its engine, a stale record, a proposal, work in motion', () => {
    const items = needsYou(records({
      tasks: [
        task('engine', { state: 'working' }),
        task('stale', { state: 'working' }),
        task('unexplained', { state: 'waiting' }),
        task('proposal', { workflow: workflow({ inbox: true }) }),
        task('queued'),
        task('running'),
        task('ready'),
        task('done', { state: 'done' }),
        task('deleted', { state: 'waiting', reason: 'needs-ok', deletedAt: '2026-09-28T09:00:00Z' }),
      ],
      sessions: [
        run('engine', 'waiting'), run('queued', 'queued'), run('running', 'working'), run('done', 'done'),
      ],
    }));
    expect(items).toEqual([]);
  });

  it('lists the newest first, dating a task by its run', () => {
    const items = needsYou(records({
      tasks: [task('older'), task('newer')],
      sessions: [
        run('older', 'failed', { startedAt: '2026-09-28T08:00:00Z', endedAt: '2026-09-28T08:10:00Z' }),
        run('newer', 'failed', { startedAt: '2026-09-28T09:00:00Z', endedAt: '2026-09-28T09:05:00Z' }),
      ],
    }));
    expect(items.map((item) => [item.taskId, item.at])).toEqual([
      ['newer', '2026-09-28T09:05:00Z'],
      ['older', '2026-09-28T08:10:00Z'],
    ]);
  });
});

describe('one colour per state', () => {
  it('marks what waits on you amber, a failure red, a run live, and nothing else', () => {
    const tone = (item: Task, sessions: Session[] = []) => evidenceTone(taskEvidence(item, sessions));
    expect(tone(task('review', { state: 'waiting', reason: 'needs-ok' }))).toBe('attn');
    expect(tone(task('failed'), [run('failed', 'failed')])).toBe('fail');
    expect(tone(task('wrong', { state: 'waiting', reason: 'went-wrong' }), [run('wrong', 'waiting')])).toBe('fail');
    expect(tone(task('running'), [run('running', 'working')])).toBe('live');
    expect(tone(task('done', { state: 'done' }))).toBe('done');
    // Blocked, but waiting on no one: no colour at all.
    expect(tone(task('engine', { state: 'working' }), [run('engine', 'waiting')])).toBe('');
    expect(tone(task('stale', { state: 'working' }))).toBe('');
    expect(tone(task('ready'))).toBe('');
  });
});

describe("the server counts the same rule in a project's status", () => {
  let root = '';
  afterEach(async () => {
    // Held before the first await: a hook that outlives its timeout must not remove the next test's folder.
    const closing = root;
    root = '';
    if (closing) await fs.rm(closing, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('counts work to review and a failed run, not only open Needs', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'needs-you-'));
    const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    const project = await store.createProject('Kestrel');
    await store.locked(async () => {
      const state = store.state(project.id);
      const review = store.createTask(state, { name: 'Check the catering quote', description: '', owner: 'you' });
      review.state = 'waiting';
      review.reason = 'needs-ok';
      const failed = store.createTask(state, { name: 'Order ribeye', description: '', owner: 'you' });
      state.sessions.push(run(failed.id, 'failed', { id: 'S-failed', sample: true }));
      const engine = store.createTask(state, { name: 'Draft the schedule', description: '', owner: 'you' });
      engine.state = 'working';
      state.sessions.push(run(engine.id, 'waiting', { id: 'S-engine', sample: true }));
    });
    const quiet = await store.createProject('Harbor');
    const projects = await store.projects();
    const listed = projects.find((item) => item.id === project.id);
    expect(listed?.status.needsYou).toBe(2);
    // Named for the home, newest first; a project with nothing waiting names nothing.
    expect(listed?.status.waiting?.map((item) => item.label).sort()).toEqual([
      'Check the catering quote',
      'Order ribeye',
    ]);
    expect(projects.find((item) => item.id === quiet.id)?.status.waiting).toBeUndefined();
    expect(listed?.counts.waitingForYou).toBe(0);
    expect(listed?.status.needsYou).toBe(needsYou(store.state(project.id)).length);
  });
});
