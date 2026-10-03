/**
 * The frames this computer sends a phone (relay plan steps 3 and 4), built from the desktop's own
 * records. Pure: no store, no clock, no socket. Every frame built here fits RELAY_MAX_MESSAGE_BYTES,
 * and none carries a document's contents, an answer's reasoning, a setting or an account. A file is
 * named in words: its last part only. Text that names a path keeps only the path's last part, so
 * `C:\Users\Pat\Q3 plan.docx` reads `Q3 plan.docx` and `notes/winter/menu.md` reads `menu.md` on the
 * phone. A folder written without a root keeps its words only with one separator (`notes/winter`) or
 * when every part is a short word (`and/or/not`); any other is cut to its last part (withoutPaths).
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
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** The last part of a path, in either separator: `C:\menus\winter.md` and `menus/winter.md` read `winter.md`. */
export function lastPart(value: string): string {
  return value.split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
}

// --- paths in text ------------------------------------------------------------------------

/** A character of a word where a path could be: not whitespace, a quote, a bracket, `|`, `<`, `>` or `*`. */
const WORD_CHAR = /[^\s"'`<>|()[\]{}*]/;
/** A character a folder or file name holds: not whitespace, a separator, `"`, `<`, `>`, `|`, `*`, `?`, a backtick or a control character. */
const NAME_CHAR = /[^\s\\/"<>|*?`\u0000-\u001f\u007f]/;
const isSeparator = (char: string | undefined) => char === '\\' || char === '/';
/** A link with a scheme, such as `https://`. A `file://` link names a path on this computer and is read as one. */
const LINK = /([A-Za-z][A-Za-z0-9+.-]+):\/\//;
/** A date written with slashes: `10/15/2026`, `2026/10/15` or `1/2`. */
const DATE = /^\d{1,4}(?:\/\d{1,4}){1,2}[.,;:!?]*$/;
/** A file's extension ending a name, with a letter in it (`.md`, `.mp3`, not `.2`), before any closing punctuation. */
const EXTENSION = /\.(?=\d*[A-Za-z])[A-Za-z0-9]{1,8}[.,;:!?')\]}]*$/;
/** A word that ends a clause. */
const CLAUSE_END = /[.,;:!?][')\]}]*$/;
/** A word that starts a path of its own: a drive, home, `.` or `..`. */
const ROOT_WORD = /^[([{']*(?:[A-Za-z]:|~|\.\.?)$/;
/** What follows a path's last separator when the path ends in one: nothing, or closing punctuation. */
const PUNCTUATION_ONLY = /^[.,;:!?')\]}]*$/;
/** The most spaces one folder name may hold. */
const NAME_SPACES = 5;

interface Root {
  /** Where the root starts. */
  at: number;
  /** What a path of its root alone reads: `C:`, `~`, `.`, `..` or `file:`. */
  name: string;
  /** The separator a folder name with spaces must be followed by: the one the path began with. */
  style: string;
  /** Where the first name after the root starts. */
  first: number;
  /** One leading separator, which is a root only with a folder after it. */
  lone: boolean;
}

/** The roots a path may start with: a `file://` link, a drive, a UNC share, home, `./` or `../`, and one leading separator. */
const ROOTS: readonly (readonly [RegExp, boolean])[] = [
  [/file:(?=\/\/)/iy, false],
  [/[A-Za-z]:(?=[\\/])/y, false],
  [/\\\\(?=[^\s\\/"<>|*?`\u0000-\u001f\u007f])/y, false],
  [/~(?=[\\/])/y, false],
  [/\.\.?(?=[\\/])/y, false],
  [/(?=[\\/][^\s\\/"<>|*?`\u0000-\u001f\u007f])/y, true],
];

function rootAt(text: string, at: number): Root | null {
  for (const [pattern, lone] of ROOTS) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) continue;
    let first = at + match[0].length;
    const style = match[0] === '\\\\' ? '\\' : text[first];
    while (isSeparator(text[first])) first += 1;
    return { at, name: match[0], style, first, lone };
  }
  return null;
}

/** Where a path starts in a word: any root at its start, or a drive after anything but a letter or digit inside it (`path=C:\menus`). */
function rootIn(text: string, start: number, end: number): Root | null {
  const first = rootAt(text, start);
  if (first) return first;
  for (let at = start + 1; at + 2 < end; at += 1)
    if (/[A-Za-z]/.test(text[at]) && text[at + 1] === ':' && isSeparator(text[at + 2]) && !/[A-Za-z0-9]/.test(text[at - 1])) return rootAt(text, at);
  return null;
}

/** Where the word that starts at `at` ends. */
function wordEnd(text: string, at: number): number {
  let end = at;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  return end;
}

/**
 * Where a folder name with spaces in it ends: the separator after it, or -1 when its words aren't
 * one name. `start` is where the name starts and `end` the space after its first word.
 */
function spacedName(text: string, start: number, end: number, style: string): number {
  const words = [text.slice(start, end)];
  let at = end;
  while (text[at] === ' ') {
    if (words.length > NAME_SPACES) return -1;
    let next = at + 1;
    while (next < text.length && NAME_CHAR.test(text[next])) next += 1;
    if (next === at + 1) return -1;
    words.push(text.slice(at + 1, next));
    at = next;
  }
  if (text[at] !== style) return -1;
  const last = words[words.length - 1];
  if (words.slice(0, -1).some((word) => CLAUSE_END.test(word) || EXTENSION.test(word))) return -1;
  if (ROOT_WORD.test(last)) return -1;
  const lastStart = at - last.length;
  const following = text.slice(lastStart, wordEnd(text, lastStart));
  return DATE.test(following) || LINK.test(following) ? -1 : at;
}

/**
 * A rooted path from its root: what it reads as and where it ends. Null for one leading separator
 * with no folder after it (`/5`, `\n`), which the rules for other words decide.
 */
function rootedRun(text: string, root: Root): { text: string; end: number } | null {
  let last = root.first - 1;
  let folder = root.name;
  let folders = 0;
  for (let at = root.first; ; at = last + 1) {
    let end = at;
    while (end < text.length && NAME_CHAR.test(text[end])) end += 1;
    if (end === at) break;
    const separator = isSeparator(text[end]) ? end : text[end] === ' ' ? spacedName(text, at, end, root.style) : -1;
    if (separator < 0) break;
    folder = text.slice(at, separator);
    folders += 1;
    last = separator;
    while (isSeparator(text[last + 1])) last += 1;
  }
  if (root.lone && folders === 0) return null;
  let end = last + 1;
  while (end < text.length && NAME_CHAR.test(text[end])) end += 1;
  const tail = text.slice(last + 1, end);
  return { text: PUNCTUATION_ONLY.test(tail) ? folder + tail : tail, end };
}

/** Words of up to three lowercase letters between separators: `and/or/not`, `km/h`. */
const SHORT_WORDS = /^[a-z]{1,3}(?:[\\/][a-z]{1,3})+[.,;:!?')\]}]*$/;

/**
 * A word with no root, rewritten to its last part when that part has a file's extension or the
 * word runs through two or more folders (`clients/acme/payroll` reads `payroll`). One separator
 * (`notes/winter`, `and/or`) and short words (`and/or/not`) stay as written.
 */
function plainWord(word: string): string {
  if (!/[\\/]/.test(word) || DATE.test(word)) return word;
  const part = lastPart(word);
  if (EXTENSION.test(part)) return part;
  const separators = word.match(/[\\/]+/g)?.length ?? 0;
  return separators >= 2 && !SHORT_WORDS.test(word) ? part || 'a folder' : word;
}

/**
 * Text with every path in it reduced to the path's last part: `C:\Program Files\Acme Corp\Q3
 * plan.docx` reads `Q3 plan.docx` and `notes/winter/menu.md` reads `menu.md`.
 *
 * A rooted path starts a word: a drive (`C:\` or `C:/`), a UNC share (`\\server\share`), home
 * (`~/`), `./` or `../`, a `file://` link, or one leading `/` or `\` with at least one folder after
 * it, so `/5` and `\n` aren't paths. A drive also starts one inside a word after anything but a
 * letter or digit (`path=C:\menus`). The path runs through its last separator, and that whole run
 * reads as its last part: what follows the last separator stays as written, so a last part with
 * spaces (`Q3 plan.docx`) comes out whole, and a path ending in a separator reads as its last
 * folder's name. Where the run's last separator is:
 * 1. A name without spaces followed by a separator of either kind always continues the path.
 * 2. Words with single spaces between them continue it as one folder name only when all of these
 *    hold: the separator after them is the kind the path began with; there are at most five
 *    spaces; no word but the last ends a clause (`.`, `,`, `;`, `:`, `!`, `?`) or has a file's
 *    extension; and the last word doesn't start something else (a drive, `~`, `.`, `..`, a date
 *    or a link). `C:\a.md and D:\b.md` is two paths, and `/Users/pat/Docs, then` ends at `Docs`.
 * 3. Anything else ends the path: a line break, a tab, two spaces, a quote, `<`, `>`, `|`, `*`,
 *    `?` or a backtick.
 *
 * Any other word with a separator is rewritten to its last part when that part has a file's
 * extension (`menus/winter.md` reads `winter.md`) or the word runs through two or more folders
 * (`clients/acme/payroll` reads `payroll`). Links with a scheme (`https://…`), dates
 * (`10/15/2026`), a lone `/`, a folder with one separator (`notes/winter`, `and/or`) and short
 * words (`and/or/not`) stay as written.
 */
export function withoutPaths(text: string): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    if (!WORD_CHAR.test(text[at])) {
      out += text[at];
      at += 1;
      continue;
    }
    const end = wordEnd(text, at);
    const word = text.slice(at, end);
    const link = LINK.exec(word);
    if (link && link[1].toLowerCase() !== 'file') {
      out += word;
      at = end;
      continue;
    }
    const root = rootIn(text, at, end);
    const run = root ? rootedRun(text, root) : null;
    if (root && run) {
      out += text.slice(at, root.at) + run.text;
      at = run.end;
    } else {
      out += plainWord(word);
      at = end;
    }
  }
  return out;
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
