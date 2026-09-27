/**
 * Adversarial checks for shared/board-moves.ts: every column pair crossed with
 * every combination of the six facts, then agreement between the commands the
 * table offers and the column the records actually project to once the server
 * has applied them.
 */
import { describe, expect, test } from 'vitest';
import {
  BOARD_COLUMNS,
  boardMove,
  boardMoveMenu,
  type BoardColumn,
  type BoardMoveFacts,
} from '../shared/board-moves';
import { isActiveSession, taskEvidence } from '../client/workbench/task-evidence';
import { readyAt } from '../shared/ready-queue';
import type { Change, Need, Owner, Session, Task, TaskState } from '../shared/types';

const T = (minutes: number) =>
  new Date(Date.parse('2026-09-27T10:00:00.000Z') + minutes * 60_000).toISOString();
const UNDO_UNTIL = '2026-09-27T12:00:00.000Z';
const BOOLEANS = [false, true] as const;

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    name: `Task ${id}`,
    description: '',
    from: null,
    owner: 'you',
    state: 'todo',
    reason: null,
    needId: null,
    sessionIds: [],
    changeIds: [],
    createdBy: 'you',
    createdAt: T(0),
    moves: [],
    ...over,
  } as Task;
}
function makeSession(
  id: string,
  taskId: string,
  state: Session['state'],
  startedAt: string,
  endedAt: string | null,
): Session {
  return {
    id,
    taskId,
    state,
    startedAt,
    endedAt,
    sample: true,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'Test worker', model: null, worker: 1, branch: null, context: null, events: 0 },
  } as unknown as Session;
}
const moved = (at: string, by: Owner, from: TaskState, to: TaskState): Task['moves'][number] => ({
  at,
  by,
  from,
  to,
  undoUntil: UNDO_UNTIL,
  undone: false,
});

/**
 * The command the table contract says a move should ask for, or null for a
 * refusal. Mirrors the documented rules, not the implementation.
 */
const expectedCommand = (to: BoardColumn, facts: BoardMoveFacts): string | null => {
  if (to === 'Queued' || to === 'Working')
    return !facts.active &&
      !facts.slotBusy &&
      (facts.from === 'Ready' || (facts.from === 'Blocked' && facts.failed))
      ? 'start'
      : null;
  if (to === 'Ready') {
    if (facts.active) return facts.from === 'Review' ? null : 'stop';
    return facts.openNeed || facts.changesWaiting ? null : 'reopen';
  }
  // to === 'Done'
  return facts.active || facts.openNeed || facts.changesWaiting ? null : 'done';
};

/** Runs `run` once per combination of the six boolean facts, for the given `from`. */
const eachFacts = (from: BoardColumn, run: (facts: BoardMoveFacts) => void) => {
  for (const active of BOOLEANS)
    for (const slotBusy of BOOLEANS)
      for (const openNeed of BOOLEANS)
        for (const changesWaiting of BOOLEANS)
          for (const failed of BOOLEANS)
            for (const autoStart of BOOLEANS)
              run({ from, active, slotBusy, openNeed, changesWaiting, failed, autoStart });
};

describe('the move table, exhaustively', () => {
  test('every column pair and every combination of the six facts', () => {
    for (const from of BOARD_COLUMNS)
      for (const to of BOARD_COLUMNS)
        eachFacts(from, (facts) => {
          const tag = `${from} -> ${to} ${JSON.stringify({ ...facts, from: undefined })}`;
          const move = boardMove(to, facts);
          if (to === from) {
            expect(move, tag).toEqual({ kind: 'none' });
            return;
          }
          if (to === 'Review' || to === 'Blocked') {
            // Neither column can be claimed by hand, whatever the facts say.
            expect(move.kind, tag).toBe('refused');
            return;
          }
          const command = expectedCommand(to, facts);
          if (command === null) {
            expect(move.kind, tag).toBe('refused');
            return;
          }
          expect(move.kind, tag).toBe('command');
          if (move.kind !== 'command') return;
          expect(move.command, tag).toBe(command);
          expect(move.label.length, tag).toBeGreaterThan(0);
          expect(move.pending.length, tag).toBeGreaterThan(0);
          if (command === 'start') {
            // Start keeps its own admission checks; the table adds no confirmation.
            expect(move.confirm, tag).toBeNull();
            expect(move.pending, tag).toContain('Starting');
          } else if (command === 'reopen') {
            expect(move.label, tag).toBe(from === 'Done' ? 'Reopen' : 'Move to Ready');
            // A reopen asks first exactly when automatic start is on here, since the queue may
            // then take the task again on its own; otherwise it goes straight through, as the
            // card's own Reopen button does.
            if (facts.autoStart) expect(move.confirm, tag).toContain('Automatic start');
            else expect(move.confirm, tag).toBeNull();
          } else {
            expect(typeof move.confirm, tag).toBe('string');
            expect((move.confirm ?? '').length, tag).toBeGreaterThan(0);
          }
        });
  });

  test('every refusal is a non-empty sentence ending in a full stop', () => {
    for (const from of BOARD_COLUMNS)
      for (const to of BOARD_COLUMNS)
        eachFacts(from, (facts) => {
          const move = boardMove(to, facts);
          if (move.kind !== 'refused') return;
          expect(move.reason.length, `${from} -> ${to}`).toBeGreaterThan(0);
          expect(move.reason.endsWith('.'), `${from} -> ${to}: "${move.reason}"`).toBe(true);
        });
  });

  test('the move menu never lists the current column and never lists Queued', () => {
    for (const from of BOARD_COLUMNS)
      eachFacts(from, (facts) => {
        const menu = boardMoveMenu(facts);
        const wanted = BOARD_COLUMNS.filter((column) => column !== from && column !== 'Queued');
        expect(menu.map((entry) => entry.to)).toEqual(wanted);
        expect(menu.some((entry) => entry.to === from)).toBe(false);
        expect(menu.some((entry) => entry.to === 'Queued')).toBe(false);
        for (const entry of menu) expect(entry.move).toEqual(boardMove(entry.to, facts));
      });
  });
});

describe('agreement with the Board projection', () => {
  const openNeed = (id: string, taskId: string, sessionId: string): Need =>
    ({ id, taskId, sessionId, state: 'open' }) as unknown as Need;
  const waitingChange = (id: string, taskId: string): Change =>
    ({ id, taskId, state: 'waiting' }) as unknown as Change;

  /** The facts a card would carry, derived from the same records the Board reads. */
  function factsOf(
    task: Task,
    sessions: Session[],
    needs: Need[],
    changes: Change[],
  ): BoardMoveFacts {
    const evidence = taskEvidence(task, sessions, needs, changes);
    return {
      from: evidence.column,
      active: evidence.active,
      // The one work slot is busy only when a different task's run holds it.
      slotBusy: sessions.some((s) => s.taskId !== task.id && isActiveSession(s)),
      openNeed: needs.some((n) => n.taskId === task.id && n.state === 'open'),
      changesWaiting: changes.some((c) => c.taskId === task.id && c.state === 'waiting'),
      failed: !evidence.active && evidence.session?.state === 'failed',
      autoStart: false,
    };
  }

  /**
   * PUT /api/projects/:id/tasks/:taskId as the server runs it: the active-session
   * refusal is the table's job (it never offers this while a run is live), then
   * store.moveTask records { at, by: 'you', from, to, undoUntil, undone: false }
   * — and records nothing when the task already sits in the target state, except a
   * move to todo, which is the person's reopen and recorded unless a reopen of theirs
   * already counts (no situation here has one) — then task.reason is cleared.
   */
  const applyTaskRoute = (task: Task, target: TaskState, at: string) => {
    if (task.state !== target || target === 'todo') {
      const previous = task.state;
      task.state = target;
      task.moves.push({ at, by: 'you', from: previous, to: target, undoUntil: UNDO_UNTIL, undone: false });
    }
    task.reason = null;
  };

  /**
   * The stop route (work.ts / native-work.ts): the live session becomes stopped
   * with an endedAt, the task's need and reason are cleared, and the task is moved
   * to todo by 'diomedes' — again with no move recorded when it is already there.
   */
  const applyStop = (task: Task, sessions: Session[], at: string) => {
    const session = sessions.find((s) => s.taskId === task.id && isActiveSession(s));
    if (!session) throw new Error('the table offered a stop with no live session');
    session.state = 'stopped';
    session.endedAt = at;
    session.needId = null;
    task.needId = null;
    task.reason = null;
    if (task.state !== 'todo') {
      const previous = task.state;
      task.state = 'todo';
      task.moves.push({
        at,
        by: 'diomedes',
        from: previous,
        to: 'todo',
        undoUntil: UNDO_UNTIL,
        undone: false,
      });
    }
  };

  const situations: {
    name: string;
    column: BoardColumn;
    task: Task;
    sessions: Session[];
    needs: Need[];
    changes: Change[];
  }[] = [
    {
      name: 'a Ready task that never ran',
      column: 'Ready',
      task: makeTask('T1'),
      sessions: [],
      needs: [],
      changes: [],
    },
    {
      name: 'a task whose only session is working',
      column: 'Working',
      task: makeTask('T2', {
        state: 'working',
        moves: [moved(T(1), 'diomedes', 'todo', 'working')],
      }),
      sessions: [makeSession('s2', 'T2', 'working', T(1), null)],
      needs: [],
      changes: [],
    },
    {
      name: 'a task whose only session is queued',
      column: 'Queued',
      task: makeTask('T3'),
      sessions: [makeSession('s3', 'T3', 'queued', T(1), null)],
      needs: [],
      changes: [],
    },
    {
      name: 'a waiting run with an open decision',
      column: 'Review',
      task: makeTask('T4', {
        state: 'waiting',
        reason: 'needs-ok',
        needId: 'n4',
        moves: [moved(T(1), 'diomedes', 'todo', 'working'), moved(T(3), 'diomedes', 'working', 'waiting')],
      }),
      sessions: [makeSession('s4', 'T4', 'waiting', T(1), null)],
      needs: [openNeed('n4', 'T4', 's4')],
      changes: [],
    },
    {
      name: 'a waiting run with changes to review',
      column: 'Review',
      task: makeTask('T5', {
        state: 'waiting',
        reason: 'changes-ready',
        moves: [moved(T(1), 'diomedes', 'todo', 'working'), moved(T(3), 'diomedes', 'working', 'waiting')],
      }),
      sessions: [makeSession('s5', 'T5', 'waiting', T(1), null)],
      needs: [],
      changes: [waitingChange('c5', 'T5')],
    },
    {
      name: "a task whose last session 'failed'",
      column: 'Blocked',
      task: makeTask('T6', {
        state: 'waiting',
        reason: 'went-wrong',
        moves: [moved(T(1), 'diomedes', 'todo', 'working'), moved(T(5), 'diomedes', 'working', 'waiting')],
      }),
      sessions: [makeSession('s6', 'T6', 'failed', T(1), T(5))],
      needs: [],
      changes: [],
    },
    {
      name: 'a done task',
      column: 'Done',
      task: makeTask('T7', {
        state: 'done',
        moves: [moved(T(1), 'diomedes', 'todo', 'working'), moved(T(5), 'diomedes', 'working', 'done')],
      }),
      sessions: [makeSession('s7', 'T7', 'done', T(1), T(5))],
      needs: [],
      changes: [],
    },
  ];

  test.each(situations)('$name: the commands offered land where the move sends them', (situation) => {
    const { task, sessions, needs, changes } = situation;
    expect(taskEvidence(task, sessions, needs, changes).column).toBe(situation.column);
    const facts = factsOf(task, sessions, needs, changes);
    expect(facts.from).toBe(situation.column);
    const commanded: BoardColumn[] = [];
    for (const to of BOARD_COLUMNS) {
      const move = boardMove(to, facts);
      if (to === situation.column) expect(move.kind).toBe('none');
      if (move.kind !== 'command') continue;
      if (move.command === 'start') continue; // a start is admitted by the Work route, not record edits
      commanded.push(to);
      const t = structuredClone(task);
      const s = structuredClone(sessions);
      const n = structuredClone(needs);
      const c = structuredClone(changes);
      if (move.command === 'stop') {
        applyStop(t, s, T(20));
        expect(taskEvidence(t, s, n, c).column, `${situation.name} -> ${to}`).toBe('Ready');
        // Stop means stop: the automatic queue must not start a replacement on its own.
        expect(readyAt(t, s, n, c), `${situation.name} stopped`).toBeNull();
      } else if (move.command === 'reopen') {
        applyTaskRoute(t, 'todo', T(20));
        expect(taskEvidence(t, s, n, c).column, `${situation.name} -> ${to}`).toBe('Ready');
        const ready = readyAt(t, s, n, c);
        expect(typeof ready, `${situation.name} reopened`).toBe('string');
        expect(t.reason, `${situation.name} reopened`).toBeNull();
      } else {
        applyTaskRoute(t, 'done', T(20));
        expect(taskEvidence(t, s, n, c).column, `${situation.name} -> ${to}`).toBe('Done');
      }
    }
    // A card that is waiting on the person can be commanded nowhere by a board move.
    if (situation.column === 'Review')
      expect(commanded, `${situation.name} offered a command`).toEqual([]);
  });

  test('a failed run on a task already in todo state: the offered reopen moves the card', () => {
    // Found by this suite (2026-09-27): with a failed session and task.state already
    // 'todo', the projection shows Blocked and the table offers 'Move to Ready'. The
    // task route accepted it, but store.moveTask returned early on the unchanged state
    // and recorded no reopen, so the command succeeded and changed nothing. The route
    // now records a person's move to To do even when the state is unchanged
    // (server/app.ts); tests/task-board-journey.test.ts proves that over HTTP.
    const task = makeTask('TF');
    const sessions = [makeSession('sf', 'TF', 'failed', T(1), T(5))];
    expect(taskEvidence(task, sessions).column).toBe('Blocked');
    const facts = factsOf(task, sessions, [], []);
    expect(facts.failed).toBe(true);
    const move = boardMove('Ready', facts);
    expect(move.kind).toBe('command');
    if (move.kind !== 'command') return;
    expect(move.command).toBe('reopen');
    applyTaskRoute(task, 'todo', T(10));
    expect(taskEvidence(task, sessions).column).toBe('Ready');
    expect(readyAt(task, sessions)).toBe(T(10));
  });
});
