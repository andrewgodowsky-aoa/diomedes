import type { Conversation, HistoryEntry, ProjectState, Session, Task } from '../../shared/types';
import { needsYou as waitingOnYou, type NeedsYouItem } from '../../shared/needs-you';
import { taskEvidence } from '../workbench/task-evidence';

/**
 * The project activity projection: Working, Needs you and Finished recently,
 * derived from the authoritative task, run, Need, change and History records.
 *
 * It is a projection, not a lifecycle. Nothing here is stored, nothing here
 * admits or starts work, and no row exists that the underlying records do not
 * already justify. `taskEvidence` stays the one place a task's column is
 * decided, and `needsYou` the one place what waits on the person is decided
 * (both in `shared/`, so the server counts the same thing); this module groups
 * their answers one level up and adds how long ago a finished task finished.
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
  /** A row that opens a Console screen rather than a thread or the Board. */
  view?: 'Automations';
  /** A failed run is red among the amber rows; every other row takes its section's colour. */
  tone?: 'fail';
  /** ISO time the row is dated by, or '' when no record carries one. */
  at: string;
}

export interface ProjectActivity {
  working: ActivityRow[];
  needsYou: ActivityRow[];
  /**
   * Always empty since the one needs-you rule (2026-09-28): work to review
   * waits on the person, so it lists under `needsYou`. Kept only for the
   * Shell's emptiness check; drop it with that check.
   */
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

/**
 * One needs-you item as a row. An approval opens the thread its run belongs
 * to; a task's review or failure opens the task's own thread.
 */
function waitingRow(item: NeedsYouItem, state: ProjectState): ActivityRow {
  const session = item.sessionId
    ? state.sessions.find((candidate) => candidate.id === item.sessionId)
    : undefined;
  const threadId =
    (item.kind === 'approval' ? session?.threadId : undefined) ??
    (item.taskId ? threadForTask(state.conversations, item.taskId) : undefined);
  return {
    id: item.id,
    label: item.label,
    detail: item.detail,
    ...(item.taskId ? { taskId: item.taskId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.kind === 'failed' ? { tone: 'fail' as const } : {}),
    at: item.at,
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
 * Group the project's current work under the three human headings. `now` is a
 * parameter so the window is testable and never depends on the clock at the
 * moment a component happens to render. `attention` carries the open
 * automation attention items for this project (Automations Milestone B), read
 * from the host's record; each is one row under Needs you, never a copy.
 */
export function projectActivity(
  state: ProjectState,
  now: number = Date.now(),
  attention: readonly ActivityRow[] = [],
): ProjectActivity {
  const working: ActivityRow[] = [];
  const needsYou = waitingOnYou(state).map((item) => waitingRow(item, state));
  const finishedRecently: ActivityRow[] = [];
  needsYou.push(...attention);

  for (const task of state.tasks) {
    if (task.deletedAt) continue;
    const evidence = taskEvidence(task, state.sessions, state.needs, state.changes);
    const session = evidence.session;
    // Only an actual run makes a task Working; a task record that says
    // 'working' with no session is a stale mirror and evidence says Blocked.
    // A run waiting on its engine is still a run, so it lists here.
    if (
      evidence.column === 'Queued' ||
      evidence.column === 'Working' ||
      (evidence.column === 'Blocked' && evidence.active && !evidence.wait)
    ) {
      working.push(taskRow(task, evidence.detail, session, state, session?.startedAt ?? ''));
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
  finishedRecently.sort(byNewest);
  return {
    working,
    needsYou,
    readyForReview: [],
    finishedRecently: finishedRecently.slice(0, RECENT_LIMIT),
  };
}
