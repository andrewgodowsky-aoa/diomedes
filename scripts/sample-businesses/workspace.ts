import fs from 'node:fs';
import path from 'node:path';

/** The fixed "today" every sample business is anchored to: Monday of ISO week 39. */
export const TODAY = '2026-09-21';

/**
 * One CSV record. `_row` is the spreadsheet row number: the header is row 1, so the
 * first record is row 2. Sample CSV files carry no comment lines and no multi-line
 * cells, so this is also the line number in a text editor.
 */
export type Row = Record<string, string> & { _row: number };

export function parseCsv(text: string, file = 'csv'): { header: string[]; rows: Row[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const cells = (line: string, n: number) => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (quoted) throw new Error(`${file}: line ${n} has an unclosed quote`);
    out.push(cur);
    return out;
  };
  if (!lines.length) throw new Error(`${file}: empty`);
  const header = cells(lines[0], 1);
  const rows = lines.slice(1).map((line, i) => {
    const values = cells(line, i + 2);
    if (values.length !== header.length)
      throw new Error(
        `${file}: row ${i + 2} has ${values.length} cells, the header has ${header.length}`,
      );
    const row = { _row: i + 2 } as Row;
    header.forEach((h, k) => (row[h] = values[k]));
    return row;
  });
  return { header, rows };
}

/** Whole cents from a decimal string such as "1,234.50" or "-26.00". */
export function cents(value: string | number): number {
  const s = String(value).replace(/[$,]/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`not an amount: ${value}`);
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const c = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return s.startsWith('-') ? -c : c;
}

export const fmt = (c: number) =>
  `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

/** The Monday that starts ISO week `n` of 2026. */
export function isoMonday2026(n: number): string {
  const d = new Date(Date.UTC(2025, 11, 29));
  d.setUTCDate(d.getUTCDate() + (n - 1) * 7);
  return d.toISOString().slice(0, 10);
}

export const listRows = (rows: number[]) =>
  rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.slice(0, -1).join(', ')} and ${rows.at(-1)}`;

/** Read-only access to one sample workspace folder. */
export class Workspace {
  constructor(readonly root: string) {}
  path(rel: string) {
    return path.join(this.root, ...rel.split('/'));
  }
  exists(rel: string) {
    return fs.existsSync(this.path(rel));
  }
  text(rel: string) {
    return fs.readFileSync(this.path(rel), 'utf8');
  }
  table(rel: string) {
    return parseCsv(this.text(rel), rel).rows;
  }
  /** Workspace-relative paths (`folder/file`) of every file under a folder, sorted. */
  list(rel = ''): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(this.path(dir), { withFileTypes: true })) {
        const child = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(child);
        else out.push(child);
      }
    };
    walk(rel);
    return out.sort();
  }
}

/** A problem planted in a business, recomputed from its raw files. */
export type Finding = { id: string; file: string; where: string; amount: string; problem?: string };

export type CheckResult = { findings: Finding[]; errors: string[] };
