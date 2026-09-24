/**
 * CSV and TSV read as a table for Files, bounded so a large export stays a
 * page of rows rather than a frozen window.
 *
 * Quoted fields follow RFC 4180 (a doubled quote inside quotes is one quote,
 * and a quoted field may hold the delimiter or a line break). Nothing is
 * computed, typed or validated: a cell is exactly the text between its
 * delimiters, so the table says nothing the raw view does not.
 */
export interface DelimitedPage {
  /** Rows from `offset`, at most `limit` of them, each at most `maxColumns` cells. */
  rows: string[][];
  /** Rows in the whole file, counted in the same pass. */
  total: number;
  /** The widest row in the whole file. */
  columns: number;
  /** True when some row had more cells than `maxColumns`. */
  clipped: boolean;
  /** True when a quote was still open at the end of the file. */
  unterminated: boolean;
}

export const TABLE_PAGE_ROWS = 100;
export const TABLE_MAX_COLUMNS = 50;
/** A cell longer than this is shown cut, and says so with an ellipsis. */
export const TABLE_MAX_CELL = 500;

export function delimiterFor(name: string): ',' | '\t' {
  return /\.tsv$/i.test(name) ? '\t' : ',';
}

export function parseDelimited(
  text: string,
  delimiter: ',' | '\t',
  { offset = 0, limit = TABLE_PAGE_ROWS, maxColumns = TABLE_MAX_COLUMNS } = {},
): DelimitedPage {
  const rows: string[][] = [];
  let total = 0;
  let columns = 0;
  let clipped = false;
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endCell = () => {
    row.push(cell.length > TABLE_MAX_CELL ? `${cell.slice(0, TABLE_MAX_CELL)}…` : cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    columns = Math.max(columns, row.length);
    if (row.length > maxColumns) clipped = true;
    if (total >= offset && rows.length < limit) rows.push(row.slice(0, maxColumns));
    total += 1;
    row = [];
    started = false;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      started = true;
    } else if (ch === delimiter) {
      endCell();
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += ch;
      started = true;
    }
  }
  const unterminated = quoted;
  if (started || cell !== '' || row.length) endRow();
  return { rows, total, columns, clipped, unterminated };
}
