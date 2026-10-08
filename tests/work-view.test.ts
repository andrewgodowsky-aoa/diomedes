import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Need, Project, ProjectState, Session, Task } from '../shared/types';
import {
  NECTOVIA_PAID_LINE,
  NECTOVIA_PAID_TITLE,
  ROUTINES_FREE_VERSION,
  TEAM_PAID_LINE,
  VIEW_LABELS,
  shownView,
  workBoard,
} from '../client/console/work-view';
import { Ledger } from '../client/console/Ledger';
import { ViewSwitch } from '../client/console/ViewSwitch';
import { TeamView } from '../client/console/TeamView';
import { NECTOVIA_LOCKED } from '../client/console/ask-row';
import { PAID_ABILITIES } from '../shared/access';
import { AGENT_NAME } from '../shared/agent-name';
import type { AccountPlanView } from '../shared/accounts';

/**
 * The Work view (round 2 reskin, slice 3, boards BD1 to BD3): the two views' names, the free
 * version keeping Work, and the board beside a thread reading the same records as the Board.
 */
const now = new Date('2026-10-06T15:00:00');
const earlier = new Date('2026-10-06T09:40:00').toISOString();
const yesterday = new Date('2026-10-05T09:40:00').toISOString();

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
    createdAt: earlier,
    moves: [],
    ...over,
  };
}

function session(id: string, taskId: string, state: Session['state']): Session {
  return {
    id,
    taskId,
    state,
    startedAt: earlier,
    endedAt: null,
    sample: false,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'Codex', model: 's-model', worker: 1, branch: null, context: null, events: 1, version: '1.0', verified: true },
  };
}

function need(id: string, taskId: string, sessionId: string): Need {
  return {
    id,
    sessionId,
    taskId,
    what: 'update two files',
    why: 'To fix the bug.',
    consequence: 'Files change.',
    files: [],
    state: 'open',
    createdAt: earlier,
    decidedAt: null,
    decidedFrom: '',
    allowForTask: false,
  };
}

const done = (at: string): Task['moves'] => [
  { at, by: 'you', from: 'working', to: 'done', undoUntil: at, undone: false },
];

const worker = (item: Task, s: Session | null) => (s ? `ran ${s.engine.model}` : item.owner === 'you' ? 'You' : 'Assistant');

describe('the two views', () => {
  it('reads Nectovia | Work, and a saved Architect opens Work', () => {
    expect([VIEW_LABELS.conversation, VIEW_LABELS.architect]).toEqual(['Nectovia', 'Work']);
    expect(shownView('architect', false)).toBe('architect');
    expect(shownView(undefined, false)).toBe('architect');
    expect(shownView('conversation', false)).toBe('conversation');
  });

  it('keeps the free version in Work without touching the saved choice', () => {
    expect(shownView('conversation', true)).toBe('architect');
    expect(shownView('architect', true)).toBe('architect');
  });

  it('calls Automations Routines wherever a person reads them', () => {
    expect(PAID_ABILITIES).toContain('Routines');
    expect(PAID_ABILITIES).not.toContain('Automations');
    expect(ROUTINES_FREE_VERSION).toMatch(/^Routines are part of a paid plan/);
  });

  it('keeps the copy free of dashes, italics and exclamation marks', () => {
    for (const line of [NECTOVIA_PAID_TITLE, NECTOVIA_PAID_LINE, TEAM_PAID_LINE, ROUTINES_FREE_VERSION])
      expect(line).not.toMatch(/[–—!]| - /);
  });
});

describe('the board beside a thread', () => {
  const tasks = [
    task('waiting', { state: 'working', owner: 'diomedes' }),
    task('working', { state: 'working' }),
    task('next', { owner: 'you' }),
    task('today', { state: 'done', moves: done(earlier) }),
    task('older', { state: 'done', moves: done(yesterday) }),
    task('gone', { deletedAt: earlier }),
  ];
  const sessions = [session('s1', 'waiting', 'waiting'), session('s2', 'working', 'working')];
  const records = { tasks, sessions, needs: [need('n1', 'waiting', 's1')], changes: [] };

  it('sorts tasks into Needs your input, Working, Up next and Finished today', () => {
    const board = workBoard(records, worker, now);
    expect(board.needs.map((card) => card.taskId)).toEqual(['waiting']);
    expect(board.needs[0]).toMatchObject({ needId: 'n1', meta: 'ran s-model', tone: 'attn' });
    expect(board.working.map((card) => card.taskId)).toEqual(['working']);
    expect(board.next.map((card) => card.taskId)).toEqual(['next']);
    expect(board.next[0].meta).toBe('You');
    expect(board.finished.map((card) => card.taskId)).toEqual(['today']);
    expect(board.finished[0].at).toMatch(/^9:40\s?AM$/);
    expect(board.open).toBe(3);
  });

  it('draws the board in the aside, with a way to the full board', () => {
    const project = { id: 'p1', name: 'Kestrel', folder: 'x', createdAt: earlier, lastOpenedAt: earlier, plans: [] } as unknown as Project;
    const state = { project, documents: [], history: [], conversations: [], ...records } as unknown as ProjectState;
    const html = renderToStaticMarkup(
      createElement(Ledger, {
        project,
        state,
        task: null,
        taskWorker: '',
        kind: 'build',
        running: false,
        latest: null,
        openNeeds: records.needs,
        onBoard: () => undefined,
        onTeam: () => undefined,
        onReviewNeed: () => undefined,
      }),
    );
    expect(html).toContain('>Board</h2>');
    expect(html).toContain('Open full board');
    for (const heading of ['Needs your input', 'Working', 'Up next', 'Finished today']) expect(html).toContain(heading);
    expect(html).toContain('Kestrel, 3 open');
  });
});

describe('the free version', () => {
  const free: AccountPlanView = { agent: 'free', plansUrl: 'https://example.test/plans', notice: true };
  const project = { id: 'p1', name: 'Kestrel', folder: 'x', createdAt: earlier, lastOpenedAt: earlier, plans: [] } as unknown as Project;
  const state = { project, documents: [], history: [], conversations: [], tasks: [], sessions: [], needs: [], changes: [] } as unknown as ProjectState;

  it('locks the Nectovia tab, keeps Work pressed and opens the paid plan notice', () => {
    const html = renderToStaticMarkup(
      createElement(ViewSwitch, { view: 'architect', free, notice: true, onChoose: () => undefined, onCloseNotice: () => undefined }),
    );
    expect(html).toContain('aria-label="View"');
    expect(html).toMatch(/class="view-tab locked"[^>]*aria-pressed="false"[^>]*>Nectovia<svg/);
    expect(html).toMatch(/class="view-tab on"[^>]*aria-pressed="true"[^>]*>Work</);
    expect(html).toContain(NECTOVIA_PAID_TITLE);
    expect(html).toContain(NECTOVIA_PAID_LINE.replace("'", '&#x27;'));
    for (const choice of ['Sign up for a plan', 'Remind me later', 'Don&#x27;t remind me again']) expect(html).toContain(choice);
    expect(html).toContain('href="https://example.test/plans"');
  });

  it('draws no lock and no notice on a plan', () => {
    const html = renderToStaticMarkup(
      createElement(ViewSwitch, { view: 'conversation', free: null, notice: true, onChoose: () => undefined, onCloseNotice: () => undefined }),
    );
    expect(html).not.toContain('<svg');
    expect(html).not.toContain(NECTOVIA_PAID_TITLE);
    expect(html).toMatch(/class="view-tab on"[^>]*aria-pressed="true"[^>]*>Nectovia</);
  });

  const team = (plan: AccountPlanView | null) =>
    renderToStaticMarkup(
      createElement(TeamView, {
        project,
        state,
        members: [],
        mail: [],
        runs: [],
        usage: [],
        busy: false,
        onMessage: async () => undefined,
        onStop: async () => undefined,
        onWake: async () => undefined,
        onOpenThread: () => undefined,
        free: plan,
      }),
    );

  it('puts the person in the lead seat and locks Nectovia\'s, with the one line while the notice is due', () => {
    const html = team(free);
    expect(html).toContain('aria-label="Who leads"');
    expect(html).toMatch(/You<span class="seat-role">Lead<\/span>/);
    expect(html).toContain(`<span class="seat-name">${AGENT_NAME}</span>`);
    expect(html).toContain('Can lead this team');
    expect(html).toContain(TEAM_PAID_LINE);
    expect(team({ ...free, notice: false })).not.toContain(TEAM_PAID_LINE);
  });

  it('shows a paid team as before', () => {
    const html = team(null);
    expect(html).not.toContain('Who leads');
    expect(html).not.toContain(TEAM_PAID_LINE);
  });

  it('reuses the ask row line for the locked engine, unchanged', () => {
    expect(NECTOVIA_LOCKED).toBe('Buy credits or upgrade your plan to use Nectovia');
  });
});
