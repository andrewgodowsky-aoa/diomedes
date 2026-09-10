import { describe, expect, it } from 'vitest';
import type { Session, Task } from '../shared/types';
import { taskEvidence } from '../client/workbench/task-evidence';
import { changeFixture, needFixture } from './workbench-fixtures';

const task: Task = {
  id: 'task', name: 'Draft', description: '', from: null, owner: 'you', state: 'todo',
  reason: null, needId: null, sessionIds: [], changeIds: [], createdBy: 'you',
  createdAt: '2026-09-10T10:00:00Z', moves: [],
};
function run(state: Session['state'], patch: Partial<Session> = {}): Session {
  return { id: 'run', taskId: task.id, state, startedAt: task.createdAt,
    endedAt: null, sample: false, log: [], entryIds: [], needId: null,
    engine: { name: 'Codex', model: null, worker: 1, branch: null, context: null, events: 0 }, ...patch };
}

describe('Board execution evidence', () => {
  it('separates admission from execution despite a stale task mirror', () => {
    expect(taskEvidence(task, [run('queued')]).column).toBe('Queued');
    expect(taskEvidence({ ...task, state: 'done' }, [run('working')]).column).toBe('Working');
    expect(taskEvidence({ ...task, state: 'working' }, []).column).toBe('Blocked');
  });
  it('keeps uncertain waiting work active and blocked until its record is reviewed', () => {
    const view = taskEvidence({ ...task, state: 'waiting', reason: 'went-wrong' }, [run('waiting')]);
    expect(view).toMatchObject({ column: 'Blocked', active: true, detail: 'Check the run before retrying' });
  });
  it('uses the newest linked active run without mutating source order', () => {
    const rows = [run('done', { id: 'other', taskId: 'other' }), run('queued'),
      run('working', { id: 'new', startedAt: '2026-09-10T11:00:00Z' })];
    expect(taskEvidence(task, rows).session?.id).toBe('new');
    expect(rows[0].id).toBe('other');
  });
  it('does not turn a stopped run into resumable paused work', () => {
    expect(taskEvidence(task, [run('stopped')])).toMatchObject({
      column: 'Ready', active: false, detail: 'Stopped; Start begins new work',
    });
  });
  it('distinguishes manual completion from a runtime completion and makes neither a verification claim', () => {
    const done = { ...task, state: 'done' as const };
    expect(taskEvidence(done, [run('done')]).detail).toBe('Run finished');
    expect(taskEvidence(done, [run('done')]).detail).not.toMatch(/verif/i);
    expect(taskEvidence({ ...done, moves: [{ at: '2026-09-10T12:00:00Z', by: 'you',
      from: 'todo', to: 'done', undoUntil: '', undone: false }] },
    [run('done', { endedAt: '2026-09-10T11:00:00Z' })]).detail).toBe('Marked done by you');
    expect(taskEvidence(done, []).detail).toBe('Marked done');
  });
  it('retains real approval and artifact work instead of hiding it behind Done', () => {
    const need = needFixture();
    const change = changeFixture();
    expect(taskEvidence({ ...task, state: 'done' }, [], [need]).column).toBe('Review');
    expect(taskEvidence({ ...task, state: 'done' }, [], [], [change]).column).toBe('Review');
  });
  it('does not use another task approval as evidence', () => {
    expect(taskEvidence(task, [], [needFixture({ taskId: 'other' })]).column).toBe('Ready');
  });
  it('uses terminal runtime state while task mirrors catch up, and respects a later explicit reopen', () => {
    expect(taskEvidence({ ...task, state: 'working' }, [run('done')]).column).toBe('Done');
    expect(taskEvidence(task, [run('failed')]).column).toBe('Blocked');
    const reopened: Task = { ...task, moves: [{ at: '2026-09-10T12:00:00Z', by: 'you',
      from: 'done', to: 'todo', undoUntil: '', undone: false }] };
    expect(taskEvidence(reopened, [run('done', { endedAt: '2026-09-10T11:00:00Z' })]).column).toBe('Ready');
  });
});
