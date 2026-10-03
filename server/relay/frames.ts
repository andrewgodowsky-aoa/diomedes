/**
 * The frames this computer sends a phone (relay plan steps 3 and 4), built from the desktop's own
 * records. Pure: no store, no clock, no socket. Every frame built here fits RELAY_MAX_MESSAGE_BYTES,
 * and none carries a path, a document's contents, an answer's reasoning, a setting or an account.
 * A file is named in words: its last part only. Text that names a path keeps only the path's last
 * part, so `notes/winter/menu.md` reads `menu.md` on the phone.
 */
import { taskEvidence, type TaskColumn } from '../../shared/task-evidence.js';
import type { Change, Need, Session, Task } from '../../shared/types.js';
import { WORK_ROWS_RELAY_LIMIT, WORK_ROW_TITLE_LIMIT, type WorkerRowPayer, type WorkRowsSnapshot } from '../../shared/work-rows.js';
import {
  RELAY_MAX_MESSAGE_BYTES,
  type BoardCard,
  type BoardCountsMessage,
  type ConversationRef,
  type NeedSummaryMessage,
  type ResultMessage,
  type ResultOutcome,
  type TurnStatus,
  type TurnUpdateMessage,
  type WorkRowsMessage,
} from '../../services/control-plane/src/relay/protocol.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
/** Whether a message, written as one frame, stays within the relay's cap. */
export const fitsFrame = (message: object) => bytes(JSON.stringify(message)) <= RELAY_MAX_MESSAGE_BYTES;

const CONTROL = /[\u0000-\u001f\u007f]/g;
const PROSE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** A run of characters between spaces, quotes and brackets: where a path could be. */
const TOKEN = /[^\s"'`<>|()[\]{}]+/g;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** The last part of a path, in either separator: `C:\menus\winter.md` and `menus/winter.md` read `winter.md`. */
export function lastPart(value: string): string {
  return value.split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
}

/** A token that reads as a path rather than words: rooted, nested, or ending in a file's extension. */
function pathLike(token: string): boolean {
  if (/^(?:[\\/~.]|[A-Za-z]:)/.test(token)) return true;
  if ((token.match(/[\\/]/g)?.length ?? 0) >= 2) return true;
  return /\.[A-Za-z0-9]{1,8}[,.;:!?]*$/.test(token);
}

/** Text with every path in it reduced to the path's last part. `and/or` and `1/2` stay as written. */
export function withoutPaths(text: string): string {
  return text.replace(TOKEN, (token) => (/[\\/]/.test(token) && pathLike(token) ? lastPart(token) || 'a folder' : token));
}

/** At most `max` UTF-16 units, never splitting a character. */
function slice(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  if (end > 0 && isHigh(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** At most `max` units, ending in an ellipsis when cut. For titles and labels, never for a Need's consequence. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${slice(text, max - 1)}…`;
}

/** One line of words for a title or a label: no control characters, no paths, at most `max` characters. */
export function words(text: string, max: number): string {
  return cut(withoutPaths(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()), max);
}

/** Person or assistant text: line breaks kept, other control characters and paths gone. */
export function prose(text: string): string {
  return withoutPaths(text.replace(/\r\n?/g, '\n').replace(PROSE_CONTROL, ''));
}

/** A file named in words, or '' when nothing is left of it. */
export function fileName(value: string): string {
  return words(lastPart(value), 80);
}

/** The longest start of `text`, within `max` units, that keeps `build(start)` within one frame. */
function longestFit(text: string, max: number, build: (start: string) => object): number {
  let low = 0;
  let high = Math.min(text.length, max);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsFrame(build(slice(text, mid)))) low = mid;
    else high = mid - 1;
  }
  return slice(text, low).length;
}

// --- a Need ---------------------------------------------------------------------------

export interface NeedSummaryInput {
  needId: string;
  projectId: string;
  taskTitle: string;
  what: string;
  why: string;
  consequence: string;
  files: readonly string[];
  expiresAt: string;
}

const NEED_FIELDS = [
  ['what', 300],
  ['why', 300],
  ['consequence', 600],
] as const;
/** The most parts one summary takes. */
export const NEED_SUMMARY_MAX_PARTS = 100;
const READ_THE_REST = ' … Open it on your computer to read the rest.';

/**
 * A Need's summary in as many parts as it takes. Each part repeats the Need's header and carries
 * the next stretch of `what`, then `why`, then `consequence`, then the file names, in that order:
 * a field that doesn't fit one part continues in the next, and the phone joins the parts in
 * order. The consequence is never cut short. Should a summary ever pass the part limit, its last
 * part says so in words instead of stopping silently.
 */
export function needSummaryParts(input: NeedSummaryInput): NeedSummaryMessage[] {
  const left = { what: prose(input.what), why: prose(input.why), consequence: prose(input.consequence) };
  const names = [...new Set(input.files.map(fileName).filter(Boolean))];
  let nextFile = 0;
  const header = {
    v: 1 as const, type: 'need.summary' as const, needId: input.needId, projectId: input.projectId,
    taskTitle: words(input.taskTitle, WORK_ROW_TITLE_LIMIT), expiresAt: input.expiresAt,
  };
  // Measured with the widest part numbers, so numbering the parts afterwards never grows a frame.
  const widest = { part: NEED_SUMMARY_MAX_PARTS, parts: NEED_SUMMARY_MAX_PARTS };
  const done = () => !left.what && !left.why && !left.consequence && nextFile >= names.length;
  const parts: Omit<NeedSummaryMessage, 'part' | 'parts'>[] = [];
  while (parts.length < NEED_SUMMARY_MAX_PARTS) {
    const part = { ...header, what: '', why: '', consequence: '', files: [] as string[] };
    let open = true;
    let took = false;
    for (const [field, max] of NEED_FIELDS) {
      if (!left[field]) continue;
      const size = longestFit(left[field], max, (start) => ({ ...part, ...widest, [field]: start }));
      if (size > 0) {
        part[field] = left[field].slice(0, size);
        left[field] = left[field].slice(size);
        took = true;
      }
      // What is left of this field, or a field that found no room, waits for the next part.
      if (left[field]) {
        open = false;
        break;
      }
    }
    while (open && nextFile < names.length && part.files.length < 10 && fitsFrame({ ...part, ...widest, files: [...part.files, names[nextFile]] })) {
      part.files.push(names[nextFile++]);
      took = true;
    }
    parts.push(part);
    if (done() || !took) break;
  }
  if (!done() && parts.length > 0) {
    // The words replace at least as many characters as they add, so the part still fits.
    const last = parts[parts.length - 1];
    const field = last.consequence ? 'consequence' : last.why ? 'why' : 'what';
    last[field] = `${slice(last[field], Math.max(0, last[field].length - READ_THE_REST.length))}${READ_THE_REST}`;
  }
  return parts.map((part, index) => ({ ...part, part: index + 1, parts: parts.length }));
}

/** The summary's parts for one of the desktop's own Needs. */
export function needSummary(need: Pick<Need, 'id' | 'what' | 'why' | 'consequence' | 'files'>, projectId: string, taskTitle: string, expiresAt: string) {
  return needSummaryParts({
    needId: need.id, projectId, taskTitle: taskTitle || 'A task', what: need.what, why: need.why,
    consequence: need.consequence, files: need.files, expiresAt,
  });
}

// --- the Board --------------------------------------------------------------------------

/** The Board's columns, in the Board's own order. */
export const BOARD_COLUMNS: readonly TaskColumn[] = ['Inbox', 'Ready', 'Queued', 'Working', 'Review', 'Blocked', 'Done'];
/** Cards that wait on the person first, finished ones last. */
const ATTENTION: readonly TaskColumn[] = ['Review', 'Blocked', 'Working', 'Queued', 'Inbox', 'Ready', 'Done'];
/** The most cards one page carries. */
export const BOARD_PAGE_CARDS = 10;

export interface BoardInput {
  projectId: string;
  tasks: readonly Task[];
  sessions: readonly Session[];
  needs: readonly Need[];
  changes: readonly Change[];
  at: string;
  /** Who is working a card, in words: the route or the Team member. */
  labelOf(session: Session): string | null;
  payerOf(session: Session | null): WorkerRowPayer;
}

/** The Board's counts and its cards, paged so each page fits one frame and holds at most ten cards. Always at least one page. */
export function boardPages(input: BoardInput): BoardCountsMessage[] {
  const live = input.tasks.filter((task) => !task.deletedAt);
  const seen = live.map((task) => ({ task, view: taskEvidence(task, input.sessions, input.needs, input.changes) }));
  const columns = BOARD_COLUMNS.map((name) => ({ name, count: seen.filter((item) => item.view.column === name).length }));
  const recent = (item: (typeof seen)[number]) => item.view.session?.startedAt ?? item.task.createdAt;
  const cards: BoardCard[] = seen
    .sort((a, b) => ATTENTION.indexOf(a.view.column) - ATTENTION.indexOf(b.view.column) || recent(b).localeCompare(recent(a)))
    .map(({ task, view }) => {
      const label = view.active && view.session ? input.labelOf(view.session) : null;
      return {
        taskId: task.id,
        title: words(task.name, WORK_ROW_TITLE_LIMIT) || 'Untitled task',
        column: view.column,
        workerLabel: label ? words(label, 40) || null : null,
        payer: input.payerOf(view.session),
      };
    });
  const frame = { v: 1 as const, type: 'board.counts' as const, projectId: input.projectId, columns, page: 10_000, pages: 10_000, at: input.at };
  const pages: BoardCard[][] = [];
  let current: BoardCard[] = [];
  for (const card of cards) {
    const candidate = [...current, card];
    if (current.length > 0 && (candidate.length > BOARD_PAGE_CARDS || !fitsFrame({ ...frame, cards: candidate }))) {
      pages.push(current);
      current = [card];
    } else current = candidate;
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);
  return pages.map((page, index) => ({ ...frame, cards: page, page: index + 1, pages: pages.length }));
}

// --- worker rows, turns and results -------------------------------------------------------

/** A project's worker rows as one frame: at most eight rows, words only, and the tail left off if it would not fit. */
export function workRowsFrame(snapshot: WorkRowsSnapshot): WorkRowsMessage {
  const rows = snapshot.rows.slice(0, WORK_ROWS_RELAY_LIMIT).map((row) => ({
    ...row,
    label: words(row.label, 40) || 'Worker',
    title: words(row.title, WORK_ROW_TITLE_LIMIT),
    ...(row.quota ? { quota: { window: words(row.quota.window, 40) || 'window', remainingPercent: row.quota.remainingPercent } } : {}),
  }));
  const message: WorkRowsMessage = {
    v: 1, type: 'work.rows', projectId: snapshot.projectId, rootRunId: snapshot.rootRunId,
    taskTitle: snapshot.taskTitle === null ? null : words(snapshot.taskTitle, WORK_ROW_TITLE_LIMIT), rows, at: snapshot.at,
  };
  while (message.rows.length > 0 && !fitsFrame(message)) message.rows = message.rows.slice(0, -1);
  return message;
}

/**
 * A turn's assistant text in frames, in order from `seq`. Every frame but the last says
 * `running`; the last carries the turn's final status. An empty answer is one frame.
 */
export function turnUpdates(conversation: ConversationRef, turnId: string, status: TurnStatus, text: string, seq: number): TurnUpdateMessage[] {
  const frames: TurnUpdateMessage[] = [];
  let left = prose(text);
  do {
    const build = (start: string): TurnUpdateMessage => ({ v: 1, type: 'turn.update', conversation, turnId, status: 'running', text: start, seq: seq + frames.length });
    const size = longestFit(left, 3_000, build);
    frames.push(build(left.slice(0, size)));
    left = left.slice(size);
    if (size === 0) break;
  } while (left);
  frames[frames.length - 1] = { ...frames[frames.length - 1], status };
  return frames;
}

/** The answer to one phone command. A refusal names its code and says why in one plain sentence. */
export function resultFrame(commandId: string, outcome: ResultOutcome, code?: string, message?: string): ResultMessage {
  return {
    v: 1, type: 'result', commandId, outcome,
    ...(code ? { code } : {}),
    ...(message ? { message: words(message, 200) } : {}),
  };
}
