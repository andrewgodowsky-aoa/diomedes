/**
 * NC-TS TS00 (DIO-227), TS-008: the NC-UM package the overlay retains, read in place. Test-only.
 * A ZIP reader small enough to audit: stored and deflated members, no ZIP64, no extraction.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number }

export function zipEntries(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_557); at--)
    if (zip.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error('no end of central directory');
  const count = zip.readUInt16LE(end + 10);
  const entries: ZipEntry[] = [];
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged central directory');
    const nameLength = zip.readUInt16LE(at + 28);
    entries.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

export function zipRead(zip: Buffer, entry: ZipEntry): Buffer {
  if (zip.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error(`damaged local header for ${entry.name}`);
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  const bytes = entry.method === 0 ? Buffer.from(data) : entry.method === 8 ? inflateRawSync(data) : null;
  if (!bytes || bytes.length !== entry.size) throw new Error(`cannot read ${entry.name}`);
  return bytes;
}

/** The overlay's baseline/RETENTION.json. */
export interface RetentionRecord { path: string; bytes: number; sha256: string; prior_file_count: number }

/** The retained archive counts only byte for byte, with every member a plain relative path. */
export function verifyRetained(zip: Buffer, record: RetentionRecord) {
  const problems: string[] = [];
  if (zip.length !== record.bytes) problems.push(`${zip.length} bytes; recorded ${record.bytes}`);
  if (createHash('sha256').update(zip).digest('hex') !== record.sha256) problems.push('SHA-256 differs from the recorded value');
  let files: string[] = [];
  try { files = zipEntries(zip).map(entry => entry.name).filter(name => !name.endsWith('/')); }
  catch (error) { problems.push(`unreadable archive: ${error instanceof Error ? error.message : String(error)}`); }
  if (files.length !== record.prior_file_count) problems.push(`${files.length} files; recorded ${record.prior_file_count}`);
  for (const name of files)
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) problems.push(`unsafe member ${name}`);
  return { ok: problems.length === 0, problems, files };
}

export interface PriorCase { id: string; suite: string; status: string }

/** The three NC-UM acceptance suites: NC-MEM-LC (M and L), unified (U) and cloud bot (BOT). */
export const PRIOR_SUITES = [
  { path: 'baseline/NC-MEM-LC-2026-10-06.1/eval/acceptance.json', list: 'cases' },
  { path: 'evaluation/unified-acceptance.json', list: 'scenarios' },
  { path: 'evaluation/cloud-bot-acceptance.json', list: 'scenarios' },
] as const;

export function priorCases(zip: Buffer): PriorCase[] {
  const entries = zipEntries(zip);
  const cases: PriorCase[] = [];
  for (const suite of PRIOR_SUITES) {
    const found = entries.filter(entry => entry.name === suite.path || entry.name.endsWith(`/${suite.path}`));
    if (found.length !== 1) throw new Error(`expected one ${suite.path}; found ${found.length}`);
    const parsed = JSON.parse(zipRead(zip, found[0]).toString('utf8')) as Record<string, unknown>;
    const list = parsed[suite.list];
    if (!Array.isArray(list)) throw new Error(`${suite.path} has no ${suite.list} list`);
    for (const item of list as Array<{ id?: unknown; status?: unknown }>)
      cases.push({ id: String(item.id), suite: suite.path, status: String(item.status) });
  }
  return cases;
}

/** Prior acceptance closes only on its own evidence; an overlay record that names a prior case is refused. */
export function overlayNamesPrior(prior: readonly PriorCase[], overlay: ReadonlyArray<{ id: string }>): string[] {
  const ids = new Set(prior.map(item => item.id));
  return overlay.filter(item => ids.has(item.id)).map(item => item.id);
}
