import type { Change, Need, Session, Task } from './types.js';
import { taskEvidence, type TaskEvidence } from './task-evidence.js';

/**
 * The one needs-you rule (Andrew, 2026-09-28): what waits on the person in one
 * project. The server's status count, the home, the ledger, the activity
 * overview and the Board's points all read it, so they cannot disagree. It is
 * the pillar's "a real decision or exception needs you", and nothing more:
 *
 * - an open Need: an approval only the person can give;
 * - a Review task: a phase to approve, changes or a task record to review;
 * - a failed run, or one that went wrong: to look at before it is retried.
 *
 * A run waiting on its engine and a task record with no run behind it wait on
 * no one. An Inbox proposal is left out until Andrew decides whether accepting
 * one counts. Automation attention is added by the client, which reads it from
 * the automations host; the server's count leaves it out.
 *
 * A projection over the records, like `taskEvidence`: nothing is stored.
 */

export type NeedsYouKind = 'approval' | 'review' | 'failed';

export interface NeedsYouItem {
  /** `need:<id>` or `task:<id>`, the ids the activity overview gives its rows. */
  id: string;
  kind: NeedsYouKind;
  /** The task's name, or the Need's own words when it has no task. */
  label: string;
  detail: string;
  taskId?: string;
  needId?: string;
  sessionId?: string;
  /** ISO time the item is dated by, or '' when no record carries one. */
  at: string;
}

export interface NeedsYouRecords {
  tasks: readonly Task[];
  sessions: readonly Session[];
  needs: readonly Need[];
  changes: readonly Change[];
}

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

const byNewest = (a: NeedsYouItem, b: NeedsYouItem): number => {
  const left = parse(a.at);
  const right = parse(b.at);
  if (left === right) return a.label.localeCompare(b.label);
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
};

/** Everything waiting on the person in one project, newest first. */
export function needsYou(records: NeedsYouRecords): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const open = records.needs.filter((need) => need.state === 'open');
  const decided = new Set(open.map((need) => need.taskId));

  for (const need of open) {
    const task = records.tasks.find((item) => item.id === need.taskId) ?? null;
    items.push({
      id: `need:${need.id}`,
      kind: 'approval',
      label: task ? task.name : need.what,
      detail: task ? need.what : need.why || need.what,
      ...(task ? { taskId: task.id } : {}),
      needId: need.id,
      ...(need.sessionId ? { sessionId: need.sessionId } : {}),
      at: need.createdAt ?? '',
    });
  }

  for (const task of records.tasks) {
    if (task.deletedAt) continue;
    // The open Need already stands for its task: one decision is one item.
    if (decided.has(task.id)) continue;
    const evidence = taskEvidence(task, records.sessions, records.needs, records.changes);
    if (!evidence.wait) continue;
    items.push({
      id: `task:${task.id}`,
      kind: evidence.wait,
      label: task.name,
      detail: evidence.detail,
      taskId: task.id,
      ...(evidence.session ? { sessionId: evidence.session.id } : {}),
      at: latest([evidence.session?.endedAt, evidence.session?.startedAt]),
    });
  }

  return items.sort(byNewest);
}

export type EvidenceTone = 'live' | 'attn' | 'fail' | 'done' | '';

/**
 * One colour per state for every point that marks a task: amber waits on you,
 * red failed, the accent runs, grey is done, and nothing else takes a colour.
 * The Board, the ledger and the plan bars all read it.
 */
export function evidenceTone(evidence: Pick<TaskEvidence, 'column' | 'wait'>): EvidenceTone {
  if (evidence.wait === 'review') return 'attn';
  if (evidence.wait === 'failed') return 'fail';
  if (evidence.column === 'Working') return 'live';
  if (evidence.column === 'Done') return 'done';
  return '';
}
