/**
 * The first worksheet of an XLSX workbook, read as a bounded table for Files.
 *
 * No dependency: a workbook is a ZIP of XML parts, and Node's own `zlib`
 * inflates them. Only four parts are read — the workbook, its relationships,
 * the shared strings and the first sheet — each inflated with an output cap, so
 * a small file cannot expand into a large one in memory. Nothing is evaluated:
 * a formula shows the value the workbook saved for it, a number shows as it is
 * stored (a date is its serial number), and the preview says so.
 *
 * Read-only by construction: this module returns rows and never writes.
 */
import { inflateRawSync } from 'node:zlib';
import { TABLE_MAX_CELL, TABLE_MAX_COLUMNS, TABLE_PAGE_ROWS } from '../shared/delimited.js';

/** No single part may inflate past this; a workbook bigger than that is described, not shown. */
export const XLSX_PART_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 4096;

export interface SheetPreview {
  sheets: string[];
  sheet: string;
  rows: string[][];
  /** Rows the sheet holds in the part that was read. */
  total: number;
  columns: number;
  clipped: boolean;
}

export class WorkbookUnreadable extends Error {}

interface Entry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

function entries(bytes: Buffer): Map<string, Entry> {
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  const from = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let i = bytes.length - 22; i >= from; i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new WorkbookUnreadable('The workbook has no ZIP directory.');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES) throw new WorkbookUnreadable('The workbook has too many parts.');
  const found = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50)
      throw new WorkbookUnreadable('The workbook directory is damaged.');
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    found.set(name, {
      name,
      method: bytes.readUInt16LE(at + 10),
      compressed: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 24),
      offset: bytes.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extra + comment;
  }
  return found;
}

function part(bytes: Buffer, all: Map<string, Entry>, name: string): string | null {
  const entry = all.get(name);
  if (!entry) return null;
  const header = entry.offset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== 0x04034b50)
    throw new WorkbookUnreadable('A workbook part is damaged.');
  const start = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
  const data = bytes.subarray(start, start + entry.compressed);
  if (data.length !== entry.compressed) throw new WorkbookUnreadable('A workbook part is cut short.');
  if (entry.size > XLSX_PART_MAX_BYTES)
    throw new WorkbookUnreadable('This workbook is too large for Files to preview.');
  let out: Buffer;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: XLSX_PART_MAX_BYTES });
    } catch {
      throw new WorkbookUnreadable('This workbook is too large for Files to preview, or a part is damaged.');
    }
  } else throw new WorkbookUnreadable('The workbook uses a compression Files does not read.');
  return out.toString('utf8');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
/** All `<t>` text inside a fragment, joined: a rich string is several runs. */
const texts = (fragment: string) =>
  [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decode(match[1]!)).join('');

function column(reference: string | null, fallback: number): number {
  const letters = reference ? /^([A-Z]+)/.exec(reference)?.[1] : undefined;
  if (!letters) return fallback;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readFirstSheet(bytes: Buffer, { offset = 0, limit = TABLE_PAGE_ROWS } = {}): SheetPreview {
  const all = entries(bytes);
  const workbook = part(bytes, all, 'xl/workbook.xml');
  if (!workbook) throw new WorkbookUnreadable('This archive is not a workbook.');
  const sheetTags = [...workbook.matchAll(/<sheet\s[^>]*\/?>/g)].map((match) => match[0]);
  if (!sheetTags.length) throw new WorkbookUnreadable('The workbook lists no sheets.');
  const sheets = sheetTags.map((tag) => decode(attribute(tag, 'name') ?? 'Sheet'));
  const relation = attribute(sheetTags[0]!, 'r:id');
  const rels = part(bytes, all, 'xl/_rels/workbook.xml.rels') ?? '';
  let target: string | null = null;
  for (const match of rels.matchAll(/<Relationship\s[^>]*\/?>/g))
    if (attribute(match[0], 'Id') === relation) target = attribute(match[0], 'Target');
  const sheetPath = target
    ? target.startsWith('/')
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, '')}`
    : 'xl/worksheets/sheet1.xml';
  const sheet = part(bytes, all, sheetPath);
  if (sheet === null) throw new WorkbookUnreadable('The first sheet is missing from the workbook.');
  const shared = [...(part(bytes, all, 'xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (match) => texts(match[1]!),
  );
  const rows: string[][] = [];
  let total = 0;
  let columns = 0;
  let clipped = false;
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const cell of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]!;
      const body = cell[2] ?? '';
      const at = column(attribute(attrs, 'r'), next);
      next = at + 1;
      if (at >= TABLE_MAX_COLUMNS) {
        clipped = true;
        continue;
      }
      const type = attribute(attrs, 't');
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value =
        type === 's'
          ? (shared[Number(raw)] ?? '')
          : type === 'inlineStr'
            ? texts(body)
            : type === 'b'
              ? raw === '1'
                ? 'TRUE'
                : 'FALSE'
              : raw === undefined
                ? ''
                : decode(raw);
      if (value.length > TABLE_MAX_CELL) value = `${value.slice(0, TABLE_MAX_CELL)}…`;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    columns = Math.max(columns, cells.length);
    if (total >= offset && rows.length < limit) rows.push(cells);
    total += 1;
  }
  return { sheets, sheet: sheets[0]!, rows, total, columns, clipped };
}
