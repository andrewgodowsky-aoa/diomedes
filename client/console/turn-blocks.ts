// A turn's text as the blocks it was written in. Pure: no React, no DOM, no
// clock. The Console renders every assistant turn from these blocks with React
// text nodes only (TurnBody.tsx), so nothing a model writes is ever parsed as
// HTML by the app.
//
// The grammar is deliberately small: paragraphs, ATX headings, lists, fenced
// code blocks and GFM pipe tables. Anything else stays the literal text it was,
// which is what the Console showed before this renderer existed. Paragraphs are
// split on blank lines and trimmed exactly as `paragraphs()` in
// diomedes-view.ts splits them, so a plain answer reads the same as it did.

export type CellAlign = 'left' | 'center' | 'right' | null;

export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
}
export interface HeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}
export interface ListItem {
  text: string;
  children: ListBlock[];
}
export interface ListBlock {
  type: 'list';
  ordered: boolean;
  start: number;
  items: ListItem[];
}
export interface CodeBlock {
  type: 'code';
  /** The first word of the info string, lower-cased: `mermaid`, `ts`, or ''. */
  lang: string;
  /** The whole info string after the fence, trimmed. */
  info: string;
  source: string;
  /** False when the text ended inside the fence. */
  closed: boolean;
  /** Index of the opening fence line in the normalised text. */
  line: number;
}
export interface TableBlock {
  type: 'table';
  header: string[];
  align: CellAlign[];
  rows: string[][];
}
export type TurnBlock = ParagraphBlock | HeadingBlock | ListBlock | CodeBlock | TableBlock;

/** What an artifact fence or table becomes in the panel. */
export type ArtifactKind = 'diagram' | 'chart' | 'image' | 'design' | 'document' | 'table';

export const KIND_LABEL: Record<ArtifactKind, string> = {
  diagram: 'Diagram',
  chart: 'Chart',
  image: 'Image',
  design: 'Design',
  document: 'Document',
  table: 'Table',
};

/** The line shown in place of an artifact while its turn is still arriving. */
export const DRAWING: Record<ArtifactKind, string> = {
  diagram: 'Drawing a diagram…',
  chart: 'Drawing a chart…',
  image: 'Drawing an image…',
  design: 'Building a design…',
  document: 'Writing a document…',
  table: 'Writing a table…',
};

/** CRLF and lone CR become LF before anything else reads the text. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * What an XML body's root element is. An SVG body may open with a BOM, an XML
 * declaration, a doctype and comments before its root; none of those make it
 * something other than SVG. 'unknown' means only the prolog (or the first
 * characters of `<svg`) has been written so far.
 */
export function svgRoot(source: string): 'svg' | 'other' | 'unknown' {
  let rest = source.replace(/^\uFEFF/, '').trimStart();
  for (let guard = 0; guard < 32; guard += 1) {
    const before = rest;
    rest = rest
      .replace(/^<\?xml[\s\S]*?\?>/i, '')
      .replace(/^<!doctype[^>]*>/i, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .trimStart();
    if (rest === before) break;
  }
  if (/^<svg[\s>/]/i.test(rest)) return 'svg';
  if (!rest || /^<[?!]/.test(rest) || '<svg'.startsWith(rest.toLowerCase())) return 'unknown';
  return 'other';
}

export function startsWithSvg(source: string): boolean {
  return svgRoot(source) === 'svg';
}

/**
 * Which fences become artifacts. Every other language, and no language at
 * all, stays a code block.
 */
export function fenceKind(lang: string, source: string): ArtifactKind | null {
  switch (lang) {
    case 'mermaid':
      return 'diagram';
    case 'chart':
      return 'chart';
    case 'svg':
      return 'image';
    case 'xml':
      return startsWithSvg(source) ? 'image' : null;
    case 'html':
      return 'design';
    case 'markdown':
    case 'md':
      return 'document';
    default:
      return null;
  }
}

/** The smallest table the panel offers: a header and at least two rows. */
export const TABLE_MIN_ROWS = 2;

/** The artifact a block becomes, or null when it stays inline text. */
export function artifactKindOf(block: TurnBlock): ArtifactKind | null {
  if (block.type === 'code') return fenceKind(block.lang, block.source);
  if (block.type === 'table') return block.rows.length >= TABLE_MIN_ROWS ? 'table' : null;
  return null;
}

// ---- line grammar -----------------------------------------------------------

const BLANK = /^[ \t]*$/;
// Any indentation opens a fence: indented code blocks are not part of this
// grammar, so a fence written under a list item is still a fence.
const FENCE_OPEN = /^([ \t]{0,12})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const DELIMITER_CELL = /^:?-+:?$/;

function fenceOpen(line: string): { indent: number; fence: string; info: string } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const fence = match[2];
  const info = match[3];
  // A backtick fence's info string may not itself hold a backtick (CommonMark).
  if (fence[0] === '`' && info.includes('`')) return null;
  return { indent: indentOf(match[1]), fence, info: info.trim() };
}

function closesFence(line: string, fence: string): boolean {
  const match = /^[ \t]{0,12}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!match && match[1][0] === fence[0] && match[1].length >= fence.length;
}

function headingOf(line: string): HeadingBlock | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  let text = (match[2] ?? '').replace(/[ \t]+#+$/, '');
  if (/^#+$/.test(text)) text = '';
  return { type: 'heading', level: match[1].length as HeadingBlock['level'], text: text.trim() };
}

function indentOf(spaces: string): number {
  let width = 0;
  for (const char of spaces) width += char === '\t' ? 4 - (width % 4) : 1;
  return width;
}

interface ItemLine {
  indent: number;
  ordered: boolean;
  number: number;
  text: string;
}

function itemOf(line: string): ItemLine | null {
  const match = ITEM.exec(line);
  if (!match) return null;
  const marker = match[2];
  const ordered = /\d/.test(marker[0]);
  return {
    indent: indentOf(match[1]),
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 1,
    text: match[3] ?? '',
  };
}

/** Splits one pipe-table row into trimmed cells. `\|` is a literal pipe. */
export function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function delimiterOf(line: string, width: number): CellAlign[] | null {
  if (!line.includes('|') && width > 1) return null;
  const cells = splitRow(line);
  if (cells.length !== width || !cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  if (!line.includes('|') && !line.includes('-')) return null;
  return cells.map((cell) =>
    cell.startsWith(':') && cell.endsWith(':')
      ? 'center'
      : cell.endsWith(':')
        ? 'right'
        : cell.startsWith(':')
          ? 'left'
          : null,
  );
}

/** A header line and the delimiter row under it, or null. */
function tableStart(lines: readonly string[], at: number): { header: string[]; align: CellAlign[] } | null {
  const line = lines[at];
  const next = lines[at + 1];
  if (next === undefined || !line.includes('|') || BLANK.test(line)) return null;
  const header = splitRow(line);
  const align = delimiterOf(next, header.length);
  return align ? { header, align } : null;
}

/** A line that ends a paragraph or a lazy list continuation by starting a block of its own. */
function interrupts(lines: readonly string[], at: number): boolean {
  const line = lines[at];
  if (fenceOpen(line) || headingOf(line)) return true;
  if (tableStart(lines, at)) return true;
  const item = itemOf(line);
  // A list interrupts a paragraph only when it plainly starts one: any bullet
  // with text, or an ordered item numbered 1 (CommonMark's rule).
  return !!item && item.text.trim() !== '' && item.indent < 4 && (!item.ordered || item.number === 1);
}

// ---- blocks -----------------------------------------------------------------

interface Cursor {
  lines: string[];
  at: number;
}

function readFence(cursor: Cursor, open: { indent: number; fence: string; info: string }): CodeBlock {
  const start = cursor.at;
  const body: string[] = [];
  cursor.at += 1;
  let closed = false;
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at];
    if (closesFence(line, open.fence)) {
      closed = true;
      cursor.at += 1;
      break;
    }
    // Content loses up to the opening fence's own indentation (CommonMark).
    let strip = 0;
    let width = 0;
    while (strip < line.length && width < open.indent && (line[strip] === ' ' || line[strip] === '\t')) {
      width += line[strip] === '\t' ? 4 - (width % 4) : 1;
      strip += 1;
    }
    body.push(line.slice(strip));
    cursor.at += 1;
  }
  const lang = (open.info.split(/\s+/)[0] ?? '').toLowerCase();
  return { type: 'code', lang, info: open.info, source: body.join('\n'), closed, line: start };
}

function readTable(cursor: Cursor, start: { header: string[]; align: CellAlign[] }): TableBlock {
  const width = start.header.length;
  const rows: string[][] = [];
  cursor.at += 2;
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at];
    // GFM: a table ends at a blank line or at the start of another block; any
    // other line is a row, pipes or not.
    if (BLANK.test(line) || fenceOpen(line) || headingOf(line)) break;
    const item = itemOf(line);
    if (item && item.text.trim() && !line.includes('|')) break;
    const cells = splitRow(line).slice(0, width);
    while (cells.length < width) cells.push('');
    rows.push(cells);
    cursor.at += 1;
  }
  return { type: 'table', header: start.header, align: start.align, rows };
}

function readList(cursor: Cursor): ListBlock {
  const first = itemOf(cursor.lines[cursor.at])!;
  const root: ListBlock = { type: 'list', ordered: first.ordered, start: first.number, items: [] };
  const stack: { indent: number; list: ListBlock }[] = [{ indent: first.indent, list: root }];
  let last: ListItem | null = null;
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at];
    if (BLANK.test(line)) {
      // A blank line keeps the list only when more of it follows: another item,
      // or a line indented under the current one.
      let next = cursor.at + 1;
      while (next < cursor.lines.length && BLANK.test(cursor.lines[next])) next += 1;
      const ahead = cursor.lines[next];
      if (ahead === undefined) break;
      const aheadItem = itemOf(ahead);
      const indented = indentOf(/^[ \t]*/.exec(ahead)![0]) >= stack[0].indent + 2;
      if (!(aheadItem && aheadItem.indent < stack[0].indent + 4 && !fenceOpen(ahead)) && !indented) break;
      cursor.at = next;
      continue;
    }
    const item = itemOf(line);
    if (item && !fenceOpen(line)) {
      while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      if (item.indent >= top.indent + 2 && last) {
        const nested: ListBlock = { type: 'list', ordered: item.ordered, start: item.number, items: [] };
        last.children.push(nested);
        stack.push({ indent: item.indent, list: nested });
      }
      last = { text: item.text.trim(), children: [] };
      stack[stack.length - 1].list.items.push(last);
      cursor.at += 1;
      continue;
    }
    // Anything that starts a block of its own ends the list; any other line
    // continues the last item's text (a lazy continuation).
    if (interrupts(cursor.lines, cursor.at) || !last) break;
    last.text = `${last.text}\n${line.trim()}`.trim();
    cursor.at += 1;
  }
  return root;
}

/**
 * The blocks of one turn, in order. An unclosed fence runs to the end of the
 * text (a finished turn that ended inside a fence ended the fence too); the
 * `closed` flag keeps the difference for the streaming gate.
 */
export function parseBlocks(input: string): TurnBlock[] {
  const cursor: Cursor = { lines: normalizeNewlines(input).split('\n'), at: 0 };
  const blocks: TurnBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at];
    if (BLANK.test(line)) {
      flush();
      cursor.at += 1;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      flush();
      blocks.push(readFence(cursor, open));
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      flush();
      blocks.push(heading);
      cursor.at += 1;
      continue;
    }
    const table = tableStart(cursor.lines, cursor.at);
    if (table) {
      flush();
      blocks.push(readTable(cursor, table));
      continue;
    }
    const item = itemOf(line);
    if (item && item.indent < 4 && (paragraph.length === 0 || interrupts(cursor.lines, cursor.at))) {
      flush();
      blocks.push(readList(cursor));
      continue;
    }
    paragraph.push(line);
    cursor.at += 1;
  }
  flush();
  return blocks;
}

// ---- inline -----------------------------------------------------------------

export type Span =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string };

const STRONG = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;

function strongSpans(text: string, out: Span[]) {
  let last = 0;
  for (const match of text.matchAll(STRONG)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) });
    out.push({ type: 'strong', text: match[1] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
}

/**
 * Inline code spans and bold runs, as text. Nothing else is interpreted: a
 * link, an image or a tag stays the characters that were written.
 */
export function inlineSpans(text: string): Span[] {
  const out: Span[] = [];
  let plain = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '`') {
      plain += text[index];
      index += 1;
      continue;
    }
    let run = 1;
    while (text[index + run] === '`') run += 1;
    const fence = '`'.repeat(run);
    let close = -1;
    for (let at = text.indexOf(fence, index + run); at >= 0; at = text.indexOf(fence, at + 1)) {
      // The closing run must be exactly as long as the opening one.
      if (text[at - 1] !== '`' && text[at + run] !== '`') {
        close = at;
        break;
      }
    }
    if (close < 0) {
      plain += fence;
      index += run;
      continue;
    }
    if (plain) strongSpans(plain, out);
    plain = '';
    let code = text.slice(index + run, close).replace(/\n/g, ' ');
    if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim())
      code = code.slice(1, -1);
    out.push({ type: 'code', text: code });
    index = close + run;
  }
  if (plain) strongSpans(plain, out);
  return out;
}

/** The words a line would read as with its bold markers taken off. */
export function plainText(text: string): string {
  return inlineSpans(text)
    .map((span) => span.text)
    .join('');
}

// ---- streaming --------------------------------------------------------------

export interface PreviewCut {
  /** The part of the live text that may be shown now. */
  text: string;
  /** The artifact whose fence is still open at the end, shown as a placeholder line. */
  pending: ArtifactKind | null;
}

/**
 * Live text is never where an artifact is drawn: artifacts render only from
 * the durable turn. While a turn is still arriving this holds back everything
 * from an opening artifact fence until the turn is saved, and it holds back a
 * last, unfinished line that could still become a fence, so the fence never
 * flashes as a paragraph first. The same rule `previewGate` in
 * server/interaction-turn.ts applies to the decision block.
 */
export function gatePreview(input: string): PreviewCut {
  const text = normalizeNewlines(input);
  const lines = text.split('\n');
  // The last line has no newline yet. If it could still become a fence (a run
  // of backticks or tildes that may grow, or a fence whose language is still
  // being written), it waits for its newline.
  if (/^[ \t]{0,12}(`+|~+|`{3,}[^`]*|~{3,}.*)$/.test(lines[lines.length - 1])) lines.pop();
  const shown = lines.join('\n');
  const blocks = parseBlocks(shown);
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'code' && !last.closed) {
    // An xml fence is an image only once its root element says so; until then
    // it is held back without a placeholder, and it streams as code once it
    // plainly is not SVG.
    const root = last.lang === 'xml' ? svgRoot(last.source) : null;
    const kind = root ? (root === 'svg' ? 'image' : null) : fenceKind(last.lang, last.source);
    if (kind || root === 'unknown') return { text: lines.slice(0, last.line).join('\n'), pending: kind };
  }
  return { text: shown, pending: null };
}
