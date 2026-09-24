/**
 * Durable identity for a project file or generated artifact: the SHA-256 of its
 * exact bytes, its project-relative path, and the History version that recorded
 * those bytes.
 *
 * History is already content-addressed — every recorded write keeps its before
 * and after images in the project's object store under their SHA-256 — so an
 * identity is a *projection* of History, not a second record. A reference
 * carries `{ path, sha }`; everything else is looked up here from the entries a
 * person can already read. Rename is not followed: a moved file is a new path,
 * and its old references still resolve to the bytes History kept.
 *
 * Pure: no file system and no network. The server answers "are those bytes
 * still here" (`GET /projects/:id/documents/version`); this module answers
 * "which version were they".
 */
import type { FileRecord, HistoryEntry } from './types.js';

export interface FileIdentity {
  path: string;
  sha: string;
  /** The History version (`v0007`) that recorded these bytes, when one did. */
  versionId: string | null;
  entryId: string | null;
}

export interface FileVersion extends FileIdentity {
  versionId: string;
  entryId: string;
  time: string;
  actor: HistoryEntry['actor'];
  sentence: string;
}

type Recorded = { entry: HistoryEntry; file: FileRecord };

function records(history: readonly HistoryEntry[], path: string): Recorded[] {
  const out: Recorded[] = [];
  for (const entry of history)
    for (const file of entry.files)
      if (file.path === path && file.recorded && file.after !== null) out.push({ entry, file });
  return out;
}

/**
 * Every distinct version History holds for this path, newest first. A version
 * is named by the first entry that recorded its bytes; re-recording the same
 * bytes later (an observed read, a restore) does not make a new version.
 */
export function versionsOf(history: readonly HistoryEntry[], path: string): FileVersion[] {
  const seen = new Map<string, FileVersion>();
  for (const { entry, file } of records(history, path))
    if (!seen.has(file.after!))
      seen.set(file.after!, {
        path,
        sha: file.after!,
        versionId: entry.versionId,
        entryId: entry.id,
        time: entry.time,
        actor: entry.actor,
        sentence: entry.sentence,
      });
  return [...seen.values()].reverse();
}

/** The identity of exactly these bytes at this path, from the entry that first recorded them. */
export function identityOf(
  history: readonly HistoryEntry[],
  path: string,
  sha: string,
): FileIdentity {
  const version = versionsOf(history, path).find((item) => item.sha === sha);
  return { path, sha, versionId: version?.versionId ?? null, entryId: version?.entryId ?? null };
}

/**
 * The version a reference made at `at` pointed to: the last bytes History
 * recorded for the path at or before that moment. Every source a Thread sends
 * is read through `Store.readDocument`, which records the bytes it read before
 * returning them, so for a message's sources this is the version sent. Null
 * when History had recorded nothing for the path by then.
 */
export function versionAt(
  history: readonly HistoryEntry[],
  path: string,
  at: string,
): FileIdentity | null {
  const limit = Date.parse(at);
  let found: Recorded | null = null;
  for (const item of records(history, path))
    if (Date.parse(item.entry.time) <= limit) found = item;
  return found ? identityOf(history, path, found.file.after!) : null;
}

/** The short form a chip or a heading prints: `v0007 · 1a2b3c4d`. */
export function identityLabel(identity: Pick<FileIdentity, 'sha' | 'versionId'>): string {
  const short = identity.sha.slice(0, 8);
  return identity.versionId ? `${identity.versionId} · ${short}` : short;
}

export const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/**
 * The exact version a sent message's source named: the sha the turn recorded
 * when it has one, else the version History recorded at or before the turn.
 */
export function turnReference(
  turn: { at: string; sourceVersions?: readonly { path: string; sha: string }[] },
  path: string,
  history: readonly HistoryEntry[],
): FileIdentity | null {
  const exact = turn.sourceVersions?.find((item) => item.path === path);
  return exact ? identityOf(history, path, exact.sha) : versionAt(history, path, turn.at);
}
