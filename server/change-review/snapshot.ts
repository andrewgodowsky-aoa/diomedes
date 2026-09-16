/**
 * The folder-comparison source: walk the project folder, hash what is there,
 * and compare two walks to say what changed between them.
 *
 * It observes the same boundary the document walk does — dot-entries,
 * symlinks and the skipped build folders are never opened — so it can never
 * execute, follow or read anything Diomedes itself is not allowed to see. What
 * it cannot see it reports as coverage, never as silence.
 *
 * This is the honest "changed while the task ran" evidence: it proves a file
 * differs between two moments, not who changed it. Recorded writes carry the
 * stronger attribution; observed changes say exactly that they were observed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { absent, projectFile } from '../paths.js';
import { SKIPPED_FOLDERS } from '../store.js';
import {
  canonicalJson,
  EMPTY_TEXT_EVIDENCE,
  type BaselineFile,
  type ChangeEvidenceRef,
  type ChangeEntry,
  type CoverageNote,
  type ReviewBaseline,
} from '../../shared/change-manifest.js';

const WALK_FILE_CAP = 10_000;
/** How many file bytes classify a file as binary — the boundary Git's own `buffer_is_binary` uses. */
export const BINARY_PROBE_BYTES = 8192;
/** Hashing concurrency: this many files hash at once; every file streams. */
const HASH_BATCH = 32;

export interface FolderSnapshot {
  readonly capturedAt: string;
  readonly files: readonly BaselineFile[];
  /**
   * Regular files the walk saw, including any it did not hash once
   * `files` reached `WALK_FILE_CAP`. `filesSeen > files.length` means the
   * listing is partial — callers must declare that, not hide it.
   */
  readonly filesSeen: number;
  readonly listingDigest: string;
  /** Entries the walk saw but did not inspect, each with its reason. */
  readonly skipped: readonly CoverageNote[];
  readonly blocked: readonly CoverageNote[];
  readonly unavailable: readonly CoverageNote[];
}

export interface FileInspection {
  readonly sha: string;
  readonly size: number;
  readonly binary: boolean;
}

export function listingDigest(files: readonly BaselineFile[]): string {
  const hash = createHash('sha256');
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered) hash.update(`${file.path}\0${file.size}\0${file.sha}\n`);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Read the first `BINARY_PROBE_BYTES` of a file and report whether a NUL byte
 * appears. Deterministic and bounded — the same signal Git applies before it
 * refuses a line diff. Never derived from the filename.
 */
export function probeBinary(head: Buffer): boolean {
  return head.includes(0);
}

export async function probeFileHead(absolute: string): Promise<Buffer> {
  const handle = await fs.open(absolute, 'r');
  try {
    const head = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(head, 0, BINARY_PROBE_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Stream a file's SHA-256 while classifying it — the first 8 KB tell whether
 * content is binary; the whole stream feeds the digest. Arbitrarily large
 * files hash in constant memory; nothing is buffered whole.
 */
export async function inspectFile(absolute: string): Promise<FileInspection> {
  const hash = createHash('sha256');
  let probed = 0;
  let binary = false;
  let size = 0;
  const handle = await fs.open(absolute, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (probed < BINARY_PROBE_BYTES && !binary) {
        const need = BINARY_PROBE_BYTES - probed;
        binary = probeBinary(buffer.subarray(0, need));
        probed += Math.min(need, buffer.length);
      }
      hash.update(buffer);
    }
  } finally {
    await handle.close();
  }
  return { sha: `sha256:${hash.digest('hex')}`, size, binary };
}

export interface CaptureFolderOptions {
  /**
   * Called for each inspected file during the walk — the retention hook a
   * baseline uses to keep small text before-content for later diffs. The
   * callback decides what to keep and enforces its own budget.
   */
  readonly retain?: (file: {
    readonly path: string;
    readonly absolute: string;
    readonly sha: string;
    readonly size: number;
    readonly binary: boolean;
  }) => Promise<void>;
  /** Override the file cap — tests use small values; production leaves the default. */
  readonly fileCap?: number;
}

/**
 * Walk `root` under the same rules as `Store.walkDocuments` — dot-entries,
 * symlinks and `SKIPPED_FOLDERS` are skipped — but also hash file bytes, so two
 * snapshots compare by content, not by timestamp. Everything the walk chose
 * not to inspect is named in `skipped`/`blocked`/`unavailable`, and a walk that
 * hit the file cap still counts what it saw in `filesSeen`.
 */
export async function captureFolder(
  root: string,
  capturedAt: string,
  options: CaptureFolderOptions = {},
): Promise<FolderSnapshot> {
  const fileCap = options.fileCap ?? WALK_FILE_CAP;
  const files: BaselineFile[] = [];
  let filesSeen = 0;
  const skipped: CoverageNote[] = [];
  const blocked: CoverageNote[] = [];
  const unavailable: CoverageNote[] = [];

  const walk = async (folder: string, prefix = ''): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) {
      unavailable.push({
        path: prefix || '.',
        reason: absent(error) ? 'The folder was removed.' : 'The folder could not be read.',
      });
      return;
    }
    const pendingFiles: { relative: string; absolute: string }[] = [];
    const subdirs: { relative: string; absolute: string }[] = [];
    for (const item of dirents) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'A link is never followed.' });
        continue;
      }
      if (item.name.startsWith('.')) {
        skipped.push({ path: relative, reason: 'Hidden entries are not inspected.' });
        continue;
      }
      if (item.isDirectory() && SKIPPED_FOLDERS.has(item.name)) {
        skipped.push({ path: relative, reason: 'A generated or dependency folder.' });
        continue;
      }
      let absolute: string;
      try {
        absolute = (await projectFile(root, relative)).absolute;
      } catch {
        blocked.push({ path: relative, reason: 'The path guard refused this name.' });
        continue;
      }
      if (item.isDirectory()) subdirs.push({ relative, absolute });
      else if (item.isFile()) {
        filesSeen += 1;
        if (files.length + pendingFiles.length < fileCap)
          pendingFiles.push({ relative, absolute });
      } else skipped.push({ path: relative, reason: 'Not a regular file or folder.' });
    }
    for (let index = 0; index < pendingFiles.length; index += HASH_BATCH) {
      const batch = pendingFiles.slice(index, index + HASH_BATCH);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const stat = await fs.stat(file.absolute);
            if (!stat.isFile()) return { file, inspected: null };
            return { file, inspected: await inspectFile(file.absolute) };
          } catch (error) {
            if (absent(error)) return { file, inspected: null };
            return { file, inspected: null, failed: true };
          }
        }),
      );
      for (const result of results) {
        if (files.length >= fileCap) break;
        if (result.inspected === null) {
          unavailable.push({
            path: result.file.relative,
            reason: result.failed
              ? 'The file could not be read.'
              : 'The file was removed during the walk.',
          });
          continue;
        }
        const inspected = result.inspected;
        files.push({
          path: result.file.relative,
          sha: inspected.sha,
          size: inspected.size,
          binary: inspected.binary,
        });
        await options.retain?.({
          path: result.file.relative,
          absolute: result.file.absolute,
          sha: inspected.sha,
          size: inspected.size,
          binary: inspected.binary,
        });
      }
    }
    for (const sub of subdirs) await walk(sub.absolute, sub.relative);
  };

  await walk(root);
  return {
    capturedAt,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    filesSeen,
    listingDigest: listingDigest(files),
    skipped,
    blocked,
    unavailable,
  };
}

/**
 * The run-start record: a folder snapshot plus the History length it was taken
 * at, so recorded writes can be scoped to entries after this point.
 */
export function baselineFrom(
  snapshot: FolderSnapshot,
  historyLength: number,
  git: ReviewBaseline['git'] = null,
): ReviewBaseline {
  return {
    capturedAt: snapshot.capturedAt,
    files: snapshot.files,
    listingDigest: snapshot.listingDigest,
    historyLength,
    git,
  };
}

export interface FolderDiff {
  readonly added: readonly BaselineFile[];
  readonly modified: readonly { path: string; before: BaselineFile; after: BaselineFile }[];
  readonly deleted: readonly BaselineFile[];
  /** Byte-identical content under a new name — a move, not a delete+add. */
  readonly renames: readonly { from: string; to: string; file: BaselineFile }[];
  readonly unchanged: number;
}

/**
 * Compare two listings. A deleted path whose hash appears exactly once among
 * the added files is reported as a rename — the same rule Git applies.
 */
export function diffSnapshots(
  before: readonly BaselineFile[],
  after: readonly BaselineFile[],
): FolderDiff {
  const beforeMap = new Map(before.map((f) => [f.path, f]));
  const afterMap = new Map(after.map((f) => [f.path, f]));
  const added: BaselineFile[] = [];
  const modified: { path: string; before: BaselineFile; after: BaselineFile }[] = [];
  const deleted: BaselineFile[] = [];
  let unchanged = 0;
  for (const file of after) {
    const was = beforeMap.get(file.path);
    if (!was) added.push(file);
    else if (was.sha !== file.sha) modified.push({ path: file.path, before: was, after: file });
    else unchanged += 1;
  }
  for (const file of before) if (!afterMap.has(file.path)) deleted.push(file);
  // Pair deletes with adds on identical content, one-to-one, deterministic order.
  const renames: { from: string; to: string; file: BaselineFile }[] = [];
  const addBySha = new Map<string, BaselineFile[]>();
  for (const file of added) {
    const bucket = addBySha.get(file.sha) ?? [];
    bucket.push(file);
    addBySha.set(file.sha, bucket);
  }
  const consumedAdd = new Set<string>();
  const consumedDelete = new Set<string>();
  for (const gone of deleted) {
    const bucket = (addBySha.get(gone.sha) ?? []).filter((f) => !consumedAdd.has(f.path));
    if (bucket.length !== 1) continue;
    consumedAdd.add(bucket[0].path);
    consumedDelete.add(gone.path);
    renames.push({ from: gone.path, to: bucket[0].path, file: bucket[0] });
  }
  return {
    added: added.filter((f) => !consumedAdd.has(f.path)),
    modified,
    deleted: deleted.filter((f) => !consumedDelete.has(f.path)),
    renames,
    unchanged,
  };
}

/** Turn a folder diff into observed ChangeEntries (paths the recorded source did not claim). */
export function observedEntries(
  diff: FolderDiff,
  claimed: ReadonlySet<string>,
  evidence: readonly ChangeEvidenceRef[],
): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const push = (path: string, kind: ChangeEntry['kind'], file: BaselineFile, other: BaselineFile | null, renamedFrom: string | null = null) => {
    if (claimed.has(path)) return;
    entries.push({
      id: `observed:${path}`,
      path,
      kind,
      attribution: 'observed',
      source: 'folder',
      beforeSha: kind === 'added' ? null : (other ?? file).sha,
      afterSha: kind === 'deleted' ? null : file.sha,
      sizeBefore: kind === 'added' ? null : (other ?? file).size,
      sizeAfter: kind === 'deleted' ? null : file.size,
      addedLines: null,
      removedLines: null,
      binary: file.binary,
      modeBefore: null,
      modeAfter: null,
      renamedFrom,
      textEvidence: EMPTY_TEXT_EVIDENCE,
      changeIds: [],
      settled: null,
      historyEntryIds: [],
      fields: [],
      evidence,
    });
  };
  for (const file of diff.added) push(file.path, 'added', file, null);
  for (const item of diff.modified) push(item.path, 'modified', item.after, item.before);
  for (const file of diff.deleted) push(file.path, 'deleted', file, null);
  for (const rename of diff.renames) push(rename.to, 'renamed', rename.file, null, rename.from);
  return entries;
}
