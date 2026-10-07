import { describe, expect, it } from 'vitest';
import {
  allProjectGroups,
  firstSentence,
  railGroups,
  railProject,
  showsScope,
  suggestions,
} from '../client/console/home-rail';
import { RECENT_WINDOW_MS, WEEK_WINDOW_MS } from '../client/console/activity';
import type { Conversation, Project, ProjectState, Task, WaitingItem } from '../shared/types';
import { needFixture, sessionFixture } from './workbench-fixtures';

// Slice 2 of the round 2 reskin, decisions 2, 3 and 4 (option A each): the home rail lists jobs
// for the scope, and "Nectovia suggests" shows only real proposals.
const NOW = Date.parse('2026-09-29T18:40:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function projectFixture(id: string, name: string, status: Partial<Project['status']> = {}): Project {
  return {
    id,
    name,
    folder: `C:/${id}`,
    createdAt: '',
    lastOpenedAt: '',
    plans: [],
    references: [],
    repository: { present: false },
    counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
    status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0, ...status },
  };
}

function taskFixture(patch: Partial<Task> = {}): Task {
  return {
    id: 'task',
    name: 'Ribeye for tonight',
    description: '',
    from: null,
    owner: 'you',
    state: 'todo',
    reason: null,
    needId: null,
    sessionIds: [],
    changeIds: [],
    createdBy: 'you',
    createdAt: ago(60_000),
    moves: [],
    ...patch,
  };
}

const threadFixture = (patch: Partial<Conversation> = {}): Conversation => ({
  id: 'thread',
  attachedTo: { kind: 'task', ref: 'task' },
  turns: [],
  taskId: 'task',
  mode: 'ask',
  ...patch,
});

function stateFixture(project: Project, patch: Partial<ProjectState> = {}): ProjectState {
  return {
    project,
    documents: [],
    tasks: [],
    needs: [],
    sessions: [],
    history: [],
    changes: [],
    conversations: [],
    ...patch,
  };
}

const kestrel = projectFixture('kestrel', 'Kestrel service');
const website = projectFixture('website', 'Website');

describe('the scope control', () => {
  it('is drawn only when the business has more than one project', () => {
    expect(showsScope([])).toBe(false);
    expect(showsScope([kestrel])).toBe(false);
    expect(showsScope([kestrel, website])).toBe(true);
  });

  it('reads one project for a project scope, and for All projects when there is only one', () => {
    expect(railProject([kestrel, website], 'website')).toBe('website');
    expect(railProject([kestrel, website], null)).toBeNull();
    expect(railProject([kestrel], null)).toBe('kestrel');
    expect(railProject([kestrel], 'gone')).toBeNull();
  });
});

describe('a project scope lists its jobs by name', () => {
  it('groups a running job under Working with its thread, and draws no empty group', () => {
    const state = stateFixture(kestrel, {
      tasks: [taskFixture({ name: "Saturday's schedule", state: 'working' })],
      sessions: [sessionFixture({ state: 'working', startedAt: ago(60_000) })],
      conversations: [threadFixture()],
    });
    const groups = railGroups({ projects: [kestrel, website], scopeId: 'kestrel', state, now: NOW });
    expect(groups.map((g) => g.heading)).toEqual(['Working']);
    expect(groups[0].count).toBe(1);
    expect(groups[0].rows[0]).toMatchObject({
      name: "Saturday's schedule",
      tone: 'live',
      target: { projectId: 'kestrel', taskId: 'task' },
    });
  });

  it("puts an open Need under Needs you and opens it where it is decided", () => {
    const state = stateFixture(kestrel, {
      tasks: [taskFixture({ state: 'waiting', reason: 'needs-ok' })],
      sessions: [sessionFixture({ state: 'waiting', startedAt: ago(120_000) })],
      needs: [needFixture({ id: 'need-1', createdAt: ago(60_000) })],
      conversations: [threadFixture()],
    });
    const [needs] = railGroups({ projects: [kestrel], scopeId: 'kestrel', state, now: NOW });
    expect(needs.heading).toBe("Needs you");
    expect(needs.rows[0].target).toEqual({ projectId: 'kestrel', taskId: 'task', needId: 'need-1' });
    expect(needs.rows[0].tone).toBe('attn');
  });

  it('counts Finished over the week, not the day', () => {
    const done = (id: string, at: string): Task =>
      taskFixture({ id, name: `Done ${id}`, state: 'done', moves: [{ at, from: 'todo', to: 'done', by: 'you' }] as Task['moves'] });
    const state = stateFixture(kestrel, {
      tasks: [done('a', ago(2 * RECENT_WINDOW_MS)), done('b', ago(WEEK_WINDOW_MS + 60_000))],
    });
    const groups = railGroups({ projects: [kestrel], scopeId: 'kestrel', state, now: NOW });
    expect(groups.map((g) => g.heading)).toEqual(['Finished']);
    expect(groups[0].rows.map((r) => r.name)).toEqual(['Done a']);
  });

  it('reads nothing from records of another project, or before they arrive', () => {
    const state = stateFixture(website);
    expect(railGroups({ projects: [kestrel, website], scopeId: 'kestrel', state, now: NOW })).toEqual([]);
    expect(railGroups({ projects: [kestrel, website], scopeId: 'kestrel', state: null, now: NOW })).toEqual([]);
  });
});

describe('All projects lists only what the records hold across projects', () => {
  const waiting = (id: string, label: string): WaitingItem => ({
    id: `task:${id}`,
    kind: 'review',
    label,
    detail: 'Reply drafted',
    taskId: id,
    at: ago(60_000),
  });

  it('names waiting items with their project, counts working per project, and draws no Finished', () => {
    const groups = allProjectGroups([
      projectFixture('kestrel', 'Kestrel service', { needsYou: 4, working: 1, waiting: [waiting('t1', 'Ribeye for tonight')] }),
      projectFixture('website', 'Website', { working: 2 }),
      projectFixture('quiet', 'Quiet'),
    ]);
    expect(groups.map((g) => [g.heading, g.count])).toEqual([
      ["Needs you", 4],
      ['Working', 3],
    ]);
    expect(groups[0].rows[0]).toMatchObject({
      name: 'Ribeye for tonight',
      sub: 'Reply drafted · Kestrel service',
      target: { projectId: 'kestrel', taskId: 't1' },
    });
    expect(groups[1].rows.map((r) => [r.name, r.sub])).toEqual([
      ['Kestrel service', '1 working'],
      ['Website', '2 working'],
    ]);
  });

  it('is empty for a quiet business', () => {
    expect(allProjectGroups([kestrel, website])).toEqual([]);
  });

  it('with one project, lists that project by name from its own records', () => {
    const state = stateFixture(kestrel, {
      tasks: [taskFixture({ state: 'working' })],
      sessions: [sessionFixture({ state: 'working', startedAt: ago(60_000) })],
    });
    const groups = railGroups({ projects: [kestrel], scopeId: null, state, now: NOW });
    expect(groups[0].rows[0].name).toBe('Ribeye for tonight');
  });
});

describe('Nectovia suggests', () => {
  const origin = { projectId: 'kestrel', threadId: 'thread', turnId: 'turn' };
  const workflow = (inbox: boolean, revision = 3) =>
    ({ revision, phase: 'plan', continuation: 'stop-on-phase-change', inbox, maxTurns: 8, handoffs: [] }) as unknown as Task['workflow'];

  it('is empty when nothing was proposed', () => {
    expect(suggestions(null, new Set())).toEqual([]);
    expect(suggestions(stateFixture(kestrel, { tasks: [taskFixture()] }), new Set())).toEqual([]);
  });

  it('lists only tasks a run proposed that wait in the Inbox, newest first, two at most', () => {
    const state = stateFixture(kestrel, {
      tasks: [
        taskFixture({ id: 'a', name: 'Older', origin, workflow: workflow(true), createdAt: ago(3_000) }),
        taskFixture({
          id: 'b',
          name: 'Set up a check on both walk-ins',
          description: 'Walk-in 2 ran warm twice this month. I would alert Marco at 39F.',
          origin,
          workflow: workflow(true, 5),
          createdAt: ago(1_000),
        }),
        taskFixture({ id: 'c', name: 'Middle', origin, workflow: workflow(true), createdAt: ago(2_000) }),
        // Accepted already, made by a person, or deleted: none of these is a suggestion.
        taskFixture({ id: 'd', name: 'Accepted', origin, workflow: workflow(false) }),
        taskFixture({ id: 'e', name: 'Person made', workflow: workflow(true) }),
        taskFixture({ id: 'f', name: 'Deleted', origin, workflow: workflow(true), deletedAt: ago(0) }),
      ],
    });
    const shown = suggestions(state, new Set());
    expect(shown.map((s) => s.name)).toEqual(['Set up a check on both walk-ins', 'Middle']);
    expect(shown[0]).toEqual({
      taskId: 'b',
      projectId: 'kestrel',
      name: 'Set up a check on both walk-ins',
      line: 'Walk-in 2 ran warm twice this month.',
      revision: 5,
    });
  });

  it('leaves out what was put off on this computer, and the next one takes its place', () => {
    const state = stateFixture(kestrel, {
      tasks: [
        taskFixture({ id: 'a', name: 'A', origin, workflow: workflow(true), createdAt: ago(1_000) }),
        taskFixture({ id: 'b', name: 'B', origin, workflow: workflow(true), createdAt: ago(2_000) }),
        taskFixture({ id: 'c', name: 'C', origin, workflow: workflow(true), createdAt: ago(3_000) }),
      ],
    });
    expect(suggestions(state, new Set(['a'])).map((s) => s.name)).toEqual(['B', 'C']);
  });

  it('reads the first sentence of a description', () => {
    expect(firstSentence('')).toBe('');
    expect(firstSentence('One line with no stop')).toBe('One line with no stop');
    expect(firstSentence('First. Second.')).toBe('First.');
    expect(firstSentence('It costs $4.50 a pound. Then more.')).toBe('It costs $4.50 a pound.');
    expect(firstSentence('x'.repeat(200))).toHaveLength(160);
  });
});
