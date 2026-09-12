import { describe, expect, it } from 'vitest';
import { projectActivity, RECENT_WINDOW_MS } from '../client/console/activity';
import type { Conversation, Project, ProjectState, Task } from '../shared/types';
import { changeFixture, historyFixture, needFixture, sessionFixture } from './workbench-fixtures';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const project: Project = {
  id: 'project', name: 'Project', folder: 'C:/owned', createdAt: '', lastOpenedAt: '',
  plans: [], references: [], repository: { present: false }, leftOff: null,
  counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
  status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 },
};

function taskFixture(patch: Partial<Task> = {}): Task {
  return {
    id: 'task', name: 'Draft the notice', description: '', from: null, owner: 'you', state: 'todo',
    reason: null, needId: null, sessionIds: [], changeIds: [], createdBy: 'you',
    createdAt: ago(3 * RECENT_WINDOW_MS), moves: [], ...patch,
  };
}

function threadFixture(patch: Partial<Conversation> = {}): Conversation {
  return { id: 'thread', attachedTo: { kind: 'task', ref: 'task' }, turns: [], taskId: 'task', mode: 'ask', ...patch };
}

function stateFixture(patch: Partial<ProjectState> = {}): ProjectState {
  return {
    project, documents: [], tasks: [], needs: [], sessions: [], history: [], changes: [],
    conversations: [], ...patch,
  };
}

const labels = (rows: { label: string }[]) => rows.map((row) => row.label);

describe('projectActivity groups the project by what a person has to do', () => {
  it('lists a queued run under Working and nowhere else', () => {
    const activity = projectActivity(
      stateFixture({
        tasks: [taskFixture({ state: 'working' })],
        sessions: [sessionFixture({ state: 'queued', startedAt: ago(60_000) })],
        conversations: [threadFixture()],
      }),
      NOW,
    );
    expect(labels(activity.working)).toEqual(['Draft the notice']);
    expect(activity.working[0].detail).toBe('Waiting to start');
    expect(activity.working[0].threadId).toBe('thread');
    expect(activity.working[0].sessionId).toBe('session');
    expect(activity.needsYou).toEqual([]);
    expect(activity.readyForReview).toEqual([]);
    expect(activity.finishedRecently).toEqual([]);
  });

  it('lists an open Need under Needs you, once, with the task it belongs to', () => {
    const activity = projectActivity(
      stateFixture({
        tasks: [taskFixture({ state: 'waiting', reason: 'needs-ok' })],
        sessions: [sessionFixture({ state: 'waiting', startedAt: ago(120_000) })],
        needs: [needFixture({ what: 'change the opening hours', createdAt: ago(90_000) })],
        conversations: [threadFixture()],
      }),
      NOW,
    );
    expect(activity.needsYou).toHaveLength(1);
    expect(activity.needsYou[0].id).toBe('need:need');
    expect(activity.needsYou[0].label).toBe('Draft the notice');
    expect(activity.needsYou[0].detail).toBe('change the opening hours');
    expect(activity.needsYou[0].taskId).toBe('task');
    // The Need row is the decision; the task must not repeat it under review.
    expect(activity.readyForReview).toEqual([]);
    expect(activity.working).toEqual([]);
  });

  it('lists a waiting run with changes under Ready for review', () => {
    const activity = projectActivity(
      stateFixture({
        tasks: [taskFixture({ state: 'waiting', reason: 'changes-ready' })],
        sessions: [sessionFixture({ state: 'waiting', startedAt: ago(300_000) })],
        changes: [changeFixture({ state: 'waiting' })],
      }),
      NOW,
    );
    expect(labels(activity.readyForReview)).toEqual(['Draft the notice']);
    expect(activity.readyForReview[0].detail).toBe('Changes to review');
    expect(activity.working).toEqual([]);
    expect(activity.needsYou).toEqual([]);
  });

  it('lists a task finished inside the window under Finished recently', () => {
    const at = ago(RECENT_WINDOW_MS / 2);
    const activity = projectActivity(
      stateFixture({
        tasks: [
          taskFixture({
            state: 'done',
            moves: [{ at, by: 'you', from: 'working', to: 'done', undoUntil: at, undone: false }],
          }),
        ],
        sessions: [sessionFixture({ state: 'done', startedAt: ago(RECENT_WINDOW_MS), endedAt: at })],
        history: [historyFixture({ time: at, sentence: 'Diomedes finished the notice' })],
      }),
      NOW,
    );
    expect(labels(activity.finishedRecently)).toEqual(['Draft the notice']);
    expect(activity.finishedRecently[0].at).toBe(at);
  });

  it('drops a task finished before the window, and never prunes the record', () => {
    const at = ago(RECENT_WINDOW_MS * 3);
    const state = stateFixture({
      tasks: [
        taskFixture({
          state: 'done',
          moves: [{ at, by: 'you', from: 'working', to: 'done', undoUntil: at, undone: false }],
        }),
      ],
      sessions: [sessionFixture({ state: 'done', startedAt: at, endedAt: at })],
      history: [historyFixture({ time: at })],
    });
    const activity = projectActivity(state, NOW);
    expect(activity.finishedRecently).toEqual([]);
    expect(activity.working).toEqual([]);
    expect(state.history).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);
  });

  it('does not invent Working for a task record with no run behind it', () => {
    const activity = projectActivity(
      stateFixture({ tasks: [taskFixture({ state: 'working' })], sessions: [] }),
      NOW,
    );
    expect(activity.working).toEqual([]);
    expect(labels(activity.needsYou)).toEqual(['Draft the notice']);
    expect(activity.needsYou[0].detail).toBe('No active run recorded');
  });

  it('puts a task that went wrong under Needs you rather than dropping it', () => {
    const activity = projectActivity(
      stateFixture({
        tasks: [taskFixture({ state: 'waiting', reason: 'went-wrong' })],
        sessions: [sessionFixture({ state: 'waiting', startedAt: ago(400_000) })],
      }),
      NOW,
    );
    expect(labels(activity.needsYou)).toEqual(['Draft the notice']);
    expect(activity.needsYou[0].detail).toBe('Check the run before retrying');
  });

  it('caps Finished recently at ten rows, newest first', () => {
    const tasks = Array.from({ length: 14 }, (_, index) => {
      const at = new Date(NOW - (index + 1) * 60_000).toISOString();
      return taskFixture({
        id: `task-${index}`,
        name: `Task ${index}`,
        state: 'done',
        moves: [{ at, by: 'you', from: 'working', to: 'done', undoUntil: at, undone: false }],
      });
    });
    const activity = projectActivity(stateFixture({ tasks }), NOW);
    expect(activity.finishedRecently).toHaveLength(10);
    expect(activity.finishedRecently[0].label).toBe('Task 0');
    expect(activity.finishedRecently[9].label).toBe('Task 9');
  });

  it('returns four empty sections for an empty project', () => {
    expect(projectActivity(stateFixture(), NOW)).toEqual({
      working: [], needsYou: [], readyForReview: [], finishedRecently: [],
    });
  });
});
