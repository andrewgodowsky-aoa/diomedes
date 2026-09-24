/**
 * Readable differences between two texts (P06).
 *
 * One model serves every place a person compares text: a waiting Change from a
 * run, two History versions of one file, and a recorded write in the Change
 * review panel. It is the general Files surface — a restaurant's procedure, a
 * report, a spreadsheet export or source code all read the same way — not a
 * code editor's diff, and nothing here knows about Git.
 *
 * The comparison is line-based (the `diff` package the store already uses),
 * with a word-level comparison inside a changed line when a removed line and an
 * added line pair up. A *hunk* is one place where the file changed: a maximal
 * run of removed and added lines between unchanged ones. Hunks are what a
 * person keeps or undoes one by one, so they are derived deterministically from
 * the two texts alone; the server recomputes them from the recorded versions
 * rather than trusting a browser's copy.
 *
 * Bounded on purpose. Texts over `maxBytes`, or whose comparison would need more
 * than `maxEditLines` line edits, say so instead of freezing the window, and a
 * text containing a NUL byte is described as not text. Pure: no file system, no
 * network, no clock.
 */
import { diffLines, diffWordsWithSpace, type Change as DiffPart } from 'diff';

export const DIFF_LIMITS = {
  /** Before plus after, in UTF-8 bytes. Larger pairs are described, not compared. */
  maxBytes: 1_000_000,
  /** The most line edits a comparison may need before it gives up. */
  maxEditLines: 5_000,
  /** Unchanged lines shown on each side of a change before the rest fold away. */
  contextLines: 3,
  /** Changed lines a view renders; beyond this the diff says how many it left out. */
  maxRenderedLines: 2_000,
  /** The most hunks a change may have and still be kept piece by piece. */
  maxSelectableHunks: 100,
  /** Lines longer than this are compared whole, not word by word. */
  maxWordDiffChars: 400,
} as const;
export type DiffLimits = { readonly [K in keyof typeof DIFF_LIMITS]: number };

export type DiffState = 'changed' | 'identical' | 'binary' | 'too-large' | 'unavailable';
export type DiffOp = 'created' | 'modified' | 'deleted';

export interface DiffWord {
  readonly text: string;
  readonly kind: 'same' | 'added' | 'removed';
}
export interface DiffLine {
  readonly kind: 'context' | 'added' | 'removed';
  /** Without its line ending. */
  readonly text: string;
  /** 1-based line number in the older text; null for an added line. */
  readonly oldNo: number | null;
  /** 1-based line number in the newer text; null for a removed line. */
  readonly newNo: number | null;
  /** Word-level parts, when this line pairs with one on the other side. */
  readonly words?: readonly DiffWord[];
}
export interface DiffHunk {
  /** 0-based position among this diff's hunks; what a partial keep names. */
  readonly index: number;
  /** First older line the hunk replaces (1-based); for a pure insertion, the line after which it goes. */
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly added: number;
  readonly removed: number;
  /** Removed lines first, then added lines, in file order. */
  readonly lines: readonly DiffLine[];
}
export type DiffSegment =
  | { readonly kind: 'context'; readonly lines: readonly DiffLine[] }
  | { readonly kind: 'hunk'; readonly hunk: number };

export interface TextDiff {
  readonly state: DiffState;
  readonly path: string;
  readonly op: DiffOp;
  /** One plain sentence: "3 lines added, 1 removed in Menu/Prices.md". */
  readonly header: string;
  /** Why there is nothing to show line by line, for every state but `changed`. */
  readonly reason: string | null;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
  /** The whole file in order: runs of unchanged lines and the hunks between them. */
  readonly segments: readonly DiffSegment[];
  /** More changed lines exist than a view renders (`maxRenderedLines`). */
  readonly truncated: boolean;
  /** Changed lines a view leaves out when truncated. */
  readonly hiddenLines: number;
  /** Whether this change can be kept hunk by hunk. */
  readonly selectable: boolean;
}

export interface DiffInput {
  readonly path: string;
  /** Null when the file did not exist before. */
  readonly before: string | null;
  /** Null when the file no longer exists after. */
  readonly after: string | null;
  /** The recorded images are exact bytes, not text. */
  readonly binary?: boolean;
  /** Recorded, but its contents were not kept. */
  readonly unavailable?: boolean;
  readonly limits?: Partial<DiffLimits>;
}

const encoder = new TextEncoder();
const bytes = (text: string | null) => (text === null ? 0 : encoder.encode(text).length);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function sizeWords(size: number): string {
  if (size < 1024) return plural(size, 'byte', 'bytes');
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Split text into lines without their endings; a final line ending adds no empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** True when the text holds a NUL byte, the same test the store's evidence uses for "not text". */
export const looksBinary = (text: string | null) => text !== null && text.includes('\0');

function opOf(before: string | null, after: string | null): DiffOp {
  return before === null ? 'created' : after === null ? 'deleted' : 'modified';
}

/** The plain sentence a diff opens with. */
export function diffHeader(path: string, op: DiffOp, added: number, removed: number): string {
  if (op === 'created') return `${plural(added, 'line', 'lines')} added in ${path}, a new file`;
  if (op === 'deleted') return `${plural(removed, 'line', 'lines')} removed from ${path}, which was deleted`;
  if (!added && !removed) return `No differences in ${path}`;
  if (!removed) return `${plural(added, 'line', 'lines')} added in ${path}`;
  if (!added) return `${plural(removed, 'line', 'lines')} removed in ${path}`;
  return `${plural(added, 'line', 'lines')} added, ${removed} removed in ${path}`;
}

/**
 * The line comparison every other function here shares, so a hunk the person
 * saw is the hunk the server applies. Undefined when it would exceed the edit
 * bound.
 */
function lineParts(before: string, after: string, maxEditLines: number): DiffPart[] | undefined {
  return diffLines(before, after, { maxEditLength: maxEditLines });
}

function wordsFor(removed: string, added: string, limit: number) {
  if (removed.length > limit || added.length > limit) return null;
  const parts = diffWordsWithSpace(removed, added);
  const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
  // Two unrelated lines read better as one removed and one added than as confetti.
  if (same < Math.min(removed.length, added.length) * 0.3) return null;
  const old: DiffWord[] = [];
  const next: DiffWord[] = [];
  for (const part of parts) {
    if (part.added) next.push({ text: part.value, kind: 'added' });
    else if (part.removed) old.push({ text: part.value, kind: 'removed' });
    else {
      old.push({ text: part.value, kind: 'same' });
      next.push({ text: part.value, kind: 'same' });
    }
  }
  return { old, next };
}

function empty(input: DiffInput, state: DiffState, reason: string, header?: string): TextDiff {
  const op = opOf(input.before, input.after);
  return {
    state,
    path: input.path,
    op,
    header: header ?? reason,
    reason,
    added: 0,
    removed: 0,
    hunks: [],
    segments: [],
    truncated: false,
    hiddenLines: 0,
    selectable: false,
  };
}

export function buildDiff(input: DiffInput): TextDiff {
  const limits: DiffLimits = { ...DIFF_LIMITS, ...input.limits };
  const { path } = input;
  if (input.binary || looksBinary(input.before) || looksBinary(input.after))
    return empty(input, 'binary', `${path} is not text, so no line differences are shown.`);
  if (input.unavailable || (input.before === null && input.after === null))
    return empty(
      input,
      'unavailable',
      `The contents of ${path} were not kept for this version, so there is nothing to compare.`,
    );
  const size = bytes(input.before) + bytes(input.after);
  if (size > limits.maxBytes)
    return empty(
      input,
      'too-large',
      `${path} is too large to compare here: ${sizeWords(size)} across both versions, over the ${sizeWords(limits.maxBytes)} limit.`,
    );
  const before = input.before ?? '';
  const after = input.after ?? '';
  const op = opOf(input.before, input.after);
  if (before === after && op === 'modified')
    return { ...empty(input, 'identical', `No differences in ${path}`), reason: null };
  const parts = lineParts(before, after, limits.maxEditLines);
  if (!parts)
    return empty(
      input,
      'too-large',
      `More than ${limits.maxEditLines.toLocaleString('en-US')} lines differ in ${path}, too many to compare here.`,
    );

  const segments: DiffSegment[] = [];
  const hunks: DiffHunk[] = [];
  let oldNo = 1;
  let newNo = 1;
  let open: { oldStart: number; newStart: number; removed: DiffLine[]; added: DiffLine[] } | null =
    null;
  const close = () => {
    if (!open) return;
    const pairs = Math.min(open.removed.length, open.added.length);
    const removed = [...open.removed];
    const added = [...open.added];
    for (let i = 0; i < pairs; i++) {
      const words = wordsFor(removed[i].text, added[i].text, limits.maxWordDiffChars);
      if (words) {
        removed[i] = { ...removed[i], words: words.old };
        added[i] = { ...added[i], words: words.next };
      }
    }
    const index = hunks.length;
    hunks.push({
      index,
      oldStart: open.removed.length ? open.oldStart : open.oldStart - 1,
      oldLines: removed.length,
      newStart: added.length ? open.newStart : open.newStart - 1,
      newLines: added.length,
      added: added.length,
      removed: removed.length,
      lines: [...removed, ...added],
    });
    segments.push({ kind: 'hunk', hunk: index });
    open = null;
  };
  for (const part of parts) {
    const lines = splitLines(part.value);
    if (!part.added && !part.removed) {
      close();
      const context: DiffLine[] = lines.map((text, i) => ({
        kind: 'context',
        text,
        oldNo: oldNo + i,
        newNo: newNo + i,
      }));
      oldNo += lines.length;
      newNo += lines.length;
      const last = segments.at(-1);
      if (last?.kind === 'context')
        segments[segments.length - 1] = { kind: 'context', lines: [...last.lines, ...context] };
      else if (context.length) segments.push({ kind: 'context', lines: context });
      continue;
    }
    open ??= { oldStart: oldNo, newStart: newNo, removed: [], added: [] };
    if (part.removed) {
      for (const text of lines) open.removed.push({ kind: 'removed', text, oldNo: oldNo++, newNo: null });
    } else {
      for (const text of lines) open.added.push({ kind: 'added', text, oldNo: null, newNo: newNo++ });
    }
  }
  close();
  const added = hunks.reduce((n, h) => n + h.added, 0);
  const removed = hunks.reduce((n, h) => n + h.removed, 0);
  if (!hunks.length)
    return {
      ...empty(input, op === 'modified' ? 'identical' : 'changed', diffHeader(path, op, 0, 0)),
      reason: null,
    };
  const changedLines = added + removed;
  const truncated = changedLines > limits.maxRenderedLines;
  return {
    state: 'changed',
    path,
    op,
    header: diffHeader(path, op, added, removed),
    reason: null,
    added,
    removed,
    hunks,
    segments,
    truncated,
    hiddenLines: truncated ? changedLines - limits.maxRenderedLines : 0,
    selectable:
      op === 'modified' &&
      hunks.length >= 2 &&
      hunks.length <= limits.maxSelectableHunks &&
      !truncated,
  };
}

/**
 * The text that results from keeping some hunks and undoing the rest: every
 * unchanged line, the newer side of each kept hunk and the older side of each
 * undone one. Keeping every hunk gives `after`; keeping none gives `before`.
 * Throws when the two texts are past the comparison bound, because a partial
 * keep must never apply a comparison the person was not shown.
 */
export function applyHunkSelection(
  before: string,
  after: string,
  keep: readonly number[],
  limits: Partial<DiffLimits> = {},
): string {
  const parts = lineParts(before, after, limits.maxEditLines ?? DIFF_LIMITS.maxEditLines);
  if (!parts) throw new Error('This change is too large to keep piece by piece.');
  const kept = new Set(keep);
  let out = '';
  let hunk = -1;
  let inHunk = false;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      inHunk = false;
      out += part.value;
      continue;
    }
    if (!inHunk) {
      hunk += 1;
      inHunk = true;
    }
    if (part.added && kept.has(hunk)) out += part.value;
    if (part.removed && !kept.has(hunk)) out += part.value;
  }
  return out;
}

/** A side-by-side row: the older line on the left, the newer on the right. */
export interface SideBySideRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

/** Pair a hunk's removed and added lines row by row for a side-by-side view. */
export function sideBySide(hunk: DiffHunk): SideBySideRow[] {
  const removed = hunk.lines.filter((l) => l.kind === 'removed');
  const added = hunk.lines.filter((l) => l.kind === 'added');
  const rows: SideBySideRow[] = [];
  for (let i = 0; i < Math.max(removed.length, added.length); i++)
    rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
  return rows;
}

/** "lines 12–14" / "line 12" / "after line 11", in the newer text when it has lines, else the older. */
export function hunkPlace(hunk: DiffHunk): string {
  const [start, count] = hunk.newLines ? [hunk.newStart, hunk.newLines] : [hunk.oldStart, hunk.oldLines];
  if (!hunk.newLines && !hunk.oldLines) return 'in this file';
  if (count === 1) return `line ${start}`;
  return `lines ${start}–${start + count - 1}`;
}

/**
 * How a view folds a run of unchanged lines: the first and last few stay
 * visible next to a change, and the middle becomes one "N unchanged lines" row.
 * A run at the start of the file keeps only its end, at the end only its start.
 */
export function foldContext(
  lines: readonly DiffLine[],
  position: 'first' | 'middle' | 'last' | 'only',
  context: number = DIFF_LIMITS.contextLines,
): { head: readonly DiffLine[]; hidden: readonly DiffLine[]; tail: readonly DiffLine[] } {
  if (position === 'only') return { head: [], hidden: lines, tail: [] };
  const head = position === 'first' ? 0 : context;
  const tail = position === 'last' ? 0 : context;
  if (lines.length <= head + tail + 1) return { head: lines, hidden: [], tail: [] };
  return {
    head: lines.slice(0, head),
    hidden: lines.slice(head, lines.length - tail),
    tail: lines.slice(lines.length - tail),
  };
}
