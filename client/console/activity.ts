import type { Conversation, HistoryEntry, Need, ProjectState, Session, Task } from '../../shared/types';
import { taskEvidence } from '../workbench/task-evidence';

/**
 * The project activity projection: Working, Needs you, Ready for review and
 * Finished recently, derived from the authoritative task, run, Need, change
 * and History records.
 *
 * It is a projection, not a lifecycle. Nothing here is stored, nothing here
 * admits or starts work, and no row exists that the underlying records do not
 * already justify. `taskEvidence` stays the one place a task's column is
 * decided (`client/workbench/task-evidence.ts`); this module groups its answer
 * one level up and adds the two things a task cannot say for itself: an open
 * Need, and how long ago a finished task finished.
 *
 * "Recently" is a display parameter, never a retention rule: the window bounds
 * what is listed and prunes nothing (decision 10).
 */

export interface ActivityRow {
  id: string;
  label: string;
  detail: string;
  taskId?: string;
  threadId?: string;
  sessionId?: string;
  /** ISO time the row is dated by, or '' when no record carries one. */
  at: string;
}

export interface ProjectActivity {
  working: ActivityRow[];
  needsYou: ActivityRow[];
  readyForReview: ActivityRow[];
  finishedRecently: ActivityRow[];
}

/** The recency window for Finished recently: 24 hours. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** And at most this many rows, so a busy day cannot flood the screen. */
export const RECENT_LIMIT = 10;

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

const latest = (times: (string | null | undefined)[]): string => {
  let best: { iso: string; ms: number } | null = null;
  for (const iso of times) {
    const ms = parse(iso);
    if (ms === null) continue;
    if (!best || ms > best.ms) best = { iso: iso as string, ms };
  }
  return best ? best.iso : '';
};

const byNewest = (a: ActivityRow, b: ActivityRow): number => {
  const left = parse(a.at);
  const right = parse(b.at);
  if (left === right) return a.label.localeCompare(b.label);
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
};

const threadForTask = (conversations: readonly Conversation[], taskId: string): string | undefined =>
  conversations.find((thread) => thread.taskId === taskId)?.id;

/** The last History entry that names this task, newest first. */
const lastEntryFor = (history: readonly HistoryEntry[], taskId: string): HistoryEntry | null => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].taskId === taskId) return history[index];
  }
  return null;
};

/**
 * When a done task finished. The task's own move is the primary record; the
 * run and the History entry that recorded it stand in when a move carries no
 * time, and the latest of the three wins.
 */
function finishedAt(task: Task, session: Session | null, history: readonly HistoryEntry[]): string {
  const move = task.moves.filter((item) => !item.undone && item.to === 'done').at(-1);
  return latest([move?.at, session?.endedAt, lastEntryFor(history, task.id)?.time]);
}

function needRow(
  need: Need,
  state: ProjectState,
  session: Session | undefined,
): ActivityRow {
  const task = state.tasks.find((item) => item.id === need.taskId) ?? null;
  const threadId = session?.threadId ?? (task ? threadForTask(state.conversations, task.id) : undefined);
  return {
    id: `need:${need.id}`,
    label: task ? task.name : need.what,
    detail: task ? need.what : need.why || need.what,
    ...(task ? { taskId: task.id } : {}),
    ...(threadId ? { threadId } : {}),
    ...(need.sessionId ? { sessionId: need.sessionId } : {}),
    at: need.createdAt ?? '',
  };
}

function taskRow(
  task: Task,
  detail: string,
  session: Session | null,
  state: ProjectState,
  at: string,
): ActivityRow {
  const threadId = threadForTask(state.conversations, task.id);
  return {
    id: `task:${task.id}`,
    label: task.name,
    detail,
    taskId: task.id,
    ...(threadId ? { threadId } : {}),
    ...(session ? { sessionId: session.id } : {}),
    at,
  };
}

/**
 * Group the project's current work under the four human headings. `now` is a
 * parameter so the window is testable and never depends on the clock at the
 * moment a component happens to render.
 */
export function projectActivity(state: ProjectState, now: number = Date.now()): ProjectActivity {
  const working: ActivityRow[] = [];
  const needsYou: ActivityRow[] = [];
  const readyForReview: ActivityRow[] = [];
  const finishedRecently: ActivityRow[] = [];

  const open = state.needs.filter((need) => need.state === 'open');
  const tasksWithOpenNeed = new Set(open.map((need) => need.taskId));

  for (const need of open) {
    needsYou.push(needRow(need, state, state.sessions.find((item) => item.id === need.sessionId)));
  }

  for (const task of state.tasks) {
    if (task.deletedAt) continue;
    const evidence = taskEvidence(task, state.sessions, state.needs, state.changes);
    const session = evidence.session;
    if (evidence.column === 'Queued' || evidence.column === 'Working') {
      // Only an actual run makes a task Working; a task record that says
      // 'working' with no session is a stale mirror and evidence says Blocked.
      working.push(taskRow(task, evidence.detail, session, state, session?.startedAt ?? ''));
      continue;
    }
    if (evidence.column === 'Blocked') {
      // Including task.reason 'went-wrong': a task that went wrong is
      // precisely a thing that needs a person.
      needsYou.push(
        taskRow(task, evidence.detail, session, state, latest([session?.endedAt, session?.startedAt])),
      );
      continue;
    }
    if (evidence.column === 'Review') {
      // The open Need already has its own row; two rows for one decision
      // would say the same thing twice.
      if (tasksWithOpenNeed.has(task.id)) continue;
      readyForReview.push(
        taskRow(task, evidence.detail, session, state, latest([session?.endedAt, session?.startedAt])),
      );
      continue;
    }
    if (evidence.column === 'Done') {
      const at = finishedAt(task, session, state.history);
      const ms = parse(at);
      // An undated finish is not claimed as recent.
      if (ms === null || now - ms > RECENT_WINDOW_MS || ms > now + 60_000) continue;
      finishedRecently.push(taskRow(task, evidence.detail, session, state, at));
    }
  }

  working.sort(byNewest);
  needsYou.sort(byNewest);
  readyForReview.sort(byNewest);
  finishedRecently.sort(byNewest);
  return {
    working,
    needsYou,
    readyForReview,
    finishedRecently: finishedRecently.slice(0, RECENT_LIMIT),
  };
}
