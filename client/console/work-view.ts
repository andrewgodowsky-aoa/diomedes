import type { ConsoleView, Need, ProjectState, Session, Task } from '../../shared/types';
import { evidenceTone, needsYou } from '../../shared/needs-you';
import { taskEvidence } from '../workbench/task-evidence';
import { AGENT_NAME } from '../../shared/agent-name';

/**
 * The two views of a project (round 2 reskin, slice 3, boards BD1 to BD3). The top switch reads
 * "Nectovia | Work". Work replaced Architect: the stored value keeps its old name, `architect`, so
 * every saved setting opens Work without a migration, and the server's settings check is unchanged.
 */
export const VIEW_LABELS: Readonly<Record<ConsoleView, string>> = Object.freeze({
  conversation: AGENT_NAME,
  architect: 'Work',
});

/** The notice behind the Nectovia tab on the free version (board BD1, copy-rename.txt). */
export const NECTOVIA_PAID_TITLE = 'Nectovia comes with a paid plan';
export const NECTOVIA_PAID_LINE =
  'It suggests jobs for your business and leads a team of helpers. Work stays on every plan, with your own engines.';

/** The team view on the free version: the person leads, and Nectovia's seat waits for a plan (board BD2). */
export const TEAM_PAID_LINE = 'Nectovia can lead the team and call models like Jev on a paid plan.';
export const TEAM_YOU = 'You';
export const TEAM_LEAD = 'Lead';
export const TEAM_NECTOVIA_SEAT = 'Can lead this team';

/** Automations are called Routines wherever a person reads them; ids and API paths keep the old name. */
export const ROUTINES = 'Routines';
export const ROUTINES_PAID = 'Paid plans';
export const ROUTINES_FREE_VERSION = "Routines are part of a paid plan, and you're on the free version.";

/**
 * The view a project shows. A free person can't use the Nectovia view on their own subscription
 * (Andrew, 2026-10-03), so the free version always shows Work. The stored choice is left alone:
 * once a plan arrives, the view the person picked comes back.
 */
export function shownView(saved: ConsoleView | undefined, free: boolean): ConsoleView {
  if (free) return 'architect';
  return saved ?? 'architect';
}

export interface BoardCard {
  id: string;
  title: string;
  /** Who has it, as the attribution line names it. */
  meta: string;
  status: string;
  tone: string;
  taskId?: string;
  needId?: string;
}

export interface FinishedCard {
  id: string;
  taskId: string;
  title: string;
  /** The clock time it finished, or '' when no record dates it. */
  at: string;
}

export interface WorkBoard {
  needs: BoardCard[];
  working: BoardCard[];
  next: BoardCard[];
  finished: FinishedCard[];
  /** Open tasks, the same count the Ledger used to head with. */
  open: number;
}

type BoardRecords = Pick<ProjectState, 'tasks' | 'sessions' | 'needs' | 'changes'>;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "9:40 AM": the board's clock, in the computer's own time. */
export function clockTime(at: Date): string {
  return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** When a finished task last moved to done, or null when no move records it. */
function finishedAt(task: Task): Date | null {
  const move = [...task.moves].reverse().find((item) => !item.undone && item.to === 'done');
  if (!move) return null;
  const at = new Date(move.at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The board beside a thread in Work (board BD1): what needs the person, what is working, what is
 * up next and what finished today. It reads the same records as the Board screen and the one
 * needs-you rule, so the counts agree with every other place that shows them.
 */
export function workBoard(
  records: BoardRecords,
  worker: (task: Task, session: Session | null) => string,
  now = new Date(),
): WorkBoard {
  const waiting = needsYou(records);
  const byTask = new Map(records.tasks.map((task) => [task.id, task]));
  const waitingTasks = new Set(waiting.map((item) => item.taskId).filter((id): id is string => !!id));
  const needs: BoardCard[] = waiting.map((item) => {
    const task = item.taskId ? byTask.get(item.taskId) : undefined;
    const evidence = task ? taskEvidence(task, records.sessions, records.needs, records.changes) : null;
    return {
      id: item.id,
      title: item.label,
      meta: task ? worker(task, evidence?.session ?? null) : '',
      status: item.detail,
      tone: item.kind === 'failed' ? 'fail' : 'attn',
      ...(item.taskId ? { taskId: item.taskId } : {}),
      ...(item.needId ? { needId: item.needId } : {}),
    };
  });
  const working: BoardCard[] = [];
  const next: BoardCard[] = [];
  const finished: (FinishedCard & { ms: number })[] = [];
  let open = 0;
  for (const task of records.tasks) {
    if (task.deletedAt) continue;
    const evidence = taskEvidence(task, records.sessions, records.needs, records.changes);
    if (evidence.column === 'Done') {
      const at = finishedAt(task);
      if (at && sameDay(at, now))
        finished.push({ id: task.id, taskId: task.id, title: task.name, at: clockTime(at), ms: at.getTime() });
      continue;
    }
    open += 1;
    if (waitingTasks.has(task.id)) continue;
    const card: BoardCard = {
      id: task.id,
      taskId: task.id,
      title: task.name,
      meta: worker(task, evidence.session),
      status: evidence.detail,
      tone: evidenceTone(evidence),
    };
    if (evidence.column === 'Working' || evidence.column === 'Queued') working.push(card);
    else next.push(card);
  }
  finished.sort((a, b) => b.ms - a.ms);
  return { needs, working, next, finished: finished.map(({ ms: _ms, ...card }) => card), open };
}

/** The open Need a board card stands for, when it has one. */
export function cardNeed(card: BoardCard, needs: readonly Need[]): Need | undefined {
  return card.needId ? needs.find((need) => need.id === card.needId) : undefined;
}
