/**
 * What a file dropped or pasted into the Files pane is, decided by its bytes.
 *
 * Drop and paste are the same import as Files > Import files (FIL-02), reached
 * from the pane instead of a folder browser, so the same rules hold: the bytes
 * go through `Store.writeRecorded`, the destination is `Imports/<name>`, and
 * one batch is one History entry attributed to the person. Two things differ,
 * because a drop has no source path to re-check and may carry a picture:
 *
 * - **The bytes decide the kind, never the name or the declared type.** A name
 *   whose extension disagrees with its bytes is refused, so a PNG renamed
 *   `.pdf`, a PDF renamed `.txt` or an executable renamed `.png` never lands.
 * - **A name that is taken gets the next free `name (2).ext`** rather than
 *   refusing the batch, and the result says which name each file got.
 *
 * SVG is not a picture here. It is a document that can carry script, so it is
 * accepted only as drawing text that passes svg-check (`shared/svg-check.ts`)
 * — the same check a proposed `.svg` passes — and it is previewed through the
 * existing sandboxed drawing frame, never as an `<img>`.
 *
 * Nothing in this module reads a file system or calls a provider; the server
 * and the Console share it so the pane can refuse a drop before uploading it.
 */
import { IMPORT_EXTENSIONS, IMPORT_MAX_BYTES } from './file-imports.js';

/** Files per drop or paste, as for Import files. */
export const DROP_MAX_FILES = 8;
/** A text file: the Import files limit. */
export const DROP_MAX_TEXT_BYTES = IMPORT_MAX_BYTES;
/** A picture, PDF or workbook. */
export const DROP_MAX_BINARY_BYTES = 10 * 1024 * 1024;
/** One drop, all files together. */
export const DROP_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** A picture larger than this is refused before any window decodes it. */
export const DROP_MAX_PIXELS = 40 * 1024 * 1024;

export type SniffedKind =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'pdf'
  | 'xlsx'
  | 'svg'
  | 'text';

/** The kinds Files can show as a picture in an `<img>`. SVG is deliberately absent. */
export const IMAGE_KINDS: readonly SniffedKind[] = ['png', 'jpeg', 'gif', 'webp'];
export const BINARY_KINDS: readonly SniffedKind[] = [...IMAGE_KINDS, 'pdf', 'xlsx'];

/** The response type each binary kind is served with. Nothing else is served as bytes. */
export const BINARY_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The extensions each sniffed kind may be named with. */
const EXTENSIONS: Readonly<Record<SniffedKind, readonly string[]>> = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  gif: ['.gif'],
  webp: ['.webp'],
  pdf: ['.pdf'],
  xlsx: ['.xlsx'],
  svg: ['.svg'],
  text: IMPORT_EXTENSIONS,
};

export const DROP_EXTENSIONS: readonly string[] = Object.values(EXTENSIONS).flat();

const extension = (name: string) => {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
};

/** The kind a name claims, before any byte is read. Null when drops do not take it. */
export function claimedKind(name: string): SniffedKind | null {
  const ext = extension(name);
  for (const [kind, list] of Object.entries(EXTENSIONS) as [SniffedKind, readonly string[]][])
    if (list.includes(ext)) return kind;
  return null;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((value, i) => bytes[at + i] === value);
const ascii = (bytes: Uint8Array, from: number, to: number) => {
  let out = '';
  for (let i = from; i < Math.min(to, bytes.length); i++) out += String.fromCharCode(bytes[i]!);
  return out;
};

/**
 * The first markup a text file leads with, after a BOM, whitespace and any
 * comments: an SVG or other XML/HTML document. Read from the bytes, as
 * `server/theme-assets.ts` does, so an SVG wearing `.png` or `.txt` is caught.
 */
function leadingMarkup(bytes: Uint8Array): 'svg' | 'markup' | null {
  const from = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  let head = ascii(bytes, from, from + 1024).toLowerCase().trimStart();
  while (head.startsWith('<!--')) {
    const closed = head.indexOf('-->');
    if (closed < 0) return 'markup';
    head = head.slice(closed + 3).trimStart();
  }
  if (head.startsWith('<?xml')) {
    const end = head.indexOf('?>');
    const rest = end < 0 ? '' : head.slice(end + 2).trimStart();
    return /^(<!--[\s\S]*?-->\s*)*(<!doctype svg|<svg)/.test(rest) ? 'svg' : 'markup';
  }
  if (head.startsWith('<svg') || head.startsWith('<!doctype svg')) return 'svg';
  return head.startsWith('<') ? 'markup' : null;
}

/** Valid UTF-8 without control bytes: the text rule Import files uses. */
export function plainText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
}

/**
 * What these bytes are. Signatures first, then text; null for anything else,
 * including an executable, an archive that is not a workbook, or binary data.
 */
export function sniffBytes(bytes: Uint8Array): SniffedKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // A workbook is a ZIP whose local headers name its parts in the clear. Any
    // other archive (a .docx, a .jar, a renamed installer) is not one.
    const names = ascii(bytes, 0, Math.min(bytes.length, 256 * 1024));
    return names.includes('[Content_Types].xml') && names.includes('xl/') ? 'xlsx' : null;
  }
  const text = plainText(bytes);
  if (text === null) return null;
  const markup = leadingMarkup(bytes);
  if (markup === 'svg') return 'svg';
  return 'text';
}

/** Width and height from a GIF's logical screen descriptor. */
export function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
}

/** The refusal for a name and its bytes, or null when they agree and are accepted. */
export function dropProblem(name: string, bytes: Uint8Array): string | null {
  const claimed = claimedKind(name);
  if (!claimed)
    return `${name} is not a file type Files takes. Drop text, Markdown, CSV, TSV, JSON, a PNG, JPEG, GIF or WebP picture, an SVG drawing, a PDF or an XLSX workbook.`;
  if (bytes.length === 0) return `${name} is empty.`;
  const limit = BINARY_KINDS.includes(claimed) ? DROP_MAX_BINARY_BYTES : DROP_MAX_TEXT_BYTES;
  if (bytes.length > limit)
    return `${name} is larger than the ${limit / (1024 * 1024)} MB limit for this kind of file.`;
  const sniffed = sniffBytes(bytes);
  if (sniffed === null)
    return claimed === 'text' || claimed === 'svg'
      ? `${name} is not UTF-8 text. Files did not add it.`
      : `${name} does not contain what its name says. Files did not add it.`;
  if (sniffed !== claimed)
    return `${name} is named as ${describe(claimed)} but contains ${describe(sniffed)}. Rename it to match what it is.`;
  return null;
}

function describe(kind: SniffedKind): string {
  return kind === 'text'
    ? 'text'
    : kind === 'svg'
      ? 'an SVG drawing'
      : kind === 'xlsx'
        ? 'an XLSX workbook'
        : kind === 'pdf'
          ? 'a PDF'
          : `a ${kind.toUpperCase()} picture`;
}

/**
 * A file name a person's drop may carry: the last segment only, no folder, and
 * nothing a project path refuses. Returns null when nothing usable is left.
 */
export function dropName(input: string): string | null {
  const last = input.replaceAll('\\', '/').split('/').pop() ?? '';
  const name = last.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/[. ]+$/, '').trim();
  if (!name || name === '.' || name === '..' || name.startsWith('.') || name.length > 180)
    return null;
  return name;
}

/**
 * The first free name in `Imports/` for this file: the name itself, then
 * `name (2).ext`, `name (3).ext`… Compared without case, as Windows does.
 */
export function uniqueImportPath(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((path) => path.toLowerCase()));
  const at = name.lastIndexOf('.');
  const stem = at > 0 ? name.slice(0, at) : name;
  const ext = at > 0 ? name.slice(at) : '';
  for (let n = 1; ; n++) {
    const candidate = `Imports/${n === 1 ? name : `${stem} (${n})${ext}`}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** The name a pasted picture or text gets: dated, so two pastes never share one. */
export function pastedName(kind: 'png' | 'jpeg' | 'gif' | 'webp' | 'text', at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const ext = kind === 'text' ? 'txt' : kind === 'jpeg' ? 'jpg' : kind;
  return `Pasted ${kind === 'text' ? 'text' : 'image'} ${stamp}.${ext}`;
}

/** What Files can show for a path, from its name. The bytes still decide on read. */
export type PreviewKind = 'image' | 'pdf' | 'table' | 'xlsx' | null;
export function previewKindForName(name: string): PreviewKind {
  const claimed = claimedKind(name);
  if (claimed && IMAGE_KINDS.includes(claimed)) return 'image';
  if (claimed === 'pdf') return 'pdf';
  if (claimed === 'xlsx') return 'xlsx';
  if (/\.(csv|tsv)$/i.test(name)) return 'table';
  return null;
}

/** A PDF's header version and whether it declares encryption, read without rendering it. */
export function pdfFacts(bytes: Uint8Array): { version: string | null; encrypted: boolean } {
  const head = ascii(bytes, 0, 16);
  const version = /^%PDF-(\d\.\d)/.exec(head)?.[1] ?? null;
  const tail = ascii(bytes, Math.max(0, bytes.length - 4096), bytes.length);
  return { version, encrypted: /\/Encrypt\b/.test(tail) };
}
