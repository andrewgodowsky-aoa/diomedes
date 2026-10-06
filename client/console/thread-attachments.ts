import type { DocumentInfo } from '../../shared/types';

/**
 * The files attached to a thread stay on its composer until the person removes one (Andrew,
 * 2026-10-06). Every message the thread sends carries all of them, in path order, so the host reads
 * the same files in the same order before each follow-up and a provider can reuse them from its
 * cache (DIO-247 N4). Removing one changes only the messages after it; each sent message keeps
 * its own record of what it carried.
 *
 * They are kept per project and thread in this browser's storage, as the Console keeps the rest of
 * its interface memory (`stored` and `remember` in Shell.tsx). A browser that refuses storage keeps
 * them for this session only, and a damaged entry reads as none.
 */
const PREFIX = 'console.attached.';
/** Far more than any message can carry; a stored entry past it is not ours. */
const MAX_STORED_CHARS = 64_000;
const KINDS: readonly DocumentInfo['kind'][] = ['plan', 'markdown', 'text', 'drawing', 'unsupported'];

export const threadAttachmentsKey = (projectId: string, threadId: string) =>
  `${PREFIX}${encodeURIComponent(projectId)}|${encodeURIComponent(threadId)}`;

/** Each path once, in the order the host reads them: by code unit, never the order picked. */
export function inPathOrder(files: readonly DocumentInfo[]): DocumentInfo[] {
  const byPath = new Map<string, DocumentInfo>();
  for (const file of files) if (!byPath.has(file.path)) byPath.set(file.path, file);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function documentInfo(value: unknown): DocumentInfo | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (typeof file.path !== 'string' || !file.path || file.path.length > 4_000) return null;
  if (!KINDS.includes(file.kind as DocumentInfo['kind'])) return null;
  if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) return null;
  return {
    path: file.path,
    kind: file.kind as DocumentInfo['kind'],
    size: file.size,
    changedAt: typeof file.changedAt === 'string' ? file.changedAt : '',
    hasChangesWaiting: file.hasChangesWaiting === true,
    recorded: file.recorded === true,
  };
}

/** This thread's attached files, in path order. None for a thread that never had any. */
export function readThreadAttachments(projectId: string, threadId: string): DocumentInfo[] {
  try {
    const raw = localStorage.getItem(threadAttachmentsKey(projectId, threadId));
    if (raw === null || raw.length > MAX_STORED_CHARS) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return inPathOrder(value.map(documentInfo).filter((file): file is DocumentInfo => file !== null));
  } catch {
    // Storage is unavailable or the entry is damaged: the thread shows none.
    return [];
  }
}

/** Keeps this thread's attached files and returns them in path order. */
export function saveThreadAttachments(
  projectId: string,
  threadId: string,
  files: readonly DocumentInfo[],
): DocumentInfo[] {
  const ordered = inPathOrder(files);
  try {
    const key = threadAttachmentsKey(projectId, threadId);
    if (ordered.length) localStorage.setItem(key, JSON.stringify(ordered));
    else localStorage.removeItem(key);
  } catch {
    // No storage: they stay for this session only.
  }
  return ordered;
}
