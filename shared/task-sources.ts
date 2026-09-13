import type { DocumentInfo } from './types.js';

/**
 * The documents a Board-started task carries to the model.
 * An explicitly selected sourceDocument takes precedence over name matching,
 * including plans, and must still be visible and within the text size limit.
 *
 * The Board's Start used to send `sources: []`, which the server reads as
 * "new files only": the model was told the task and given nothing to read,
 * so a task that named an existing document could only answer that it had
 * not been shown one (journey A, 2026-09-12). The person did name the
 * documents, in the task itself; this picks exactly those.
 *
 * A document is selected when its project path, or its file name, appears in
 * the task's name or description (case-insensitive, whole token: `brief.md`
 * does not match `weekly-brief.md`). Only text and Markdown kinds qualify, in
 * the order the task mentions them, up to the server's limits of eight
 * documents and 128 KB of text. A task that names nothing sends nothing, and
 * the confirmation says so.
 */
export const TASK_SOURCE_LIMITS = { files: 8, bytes: 128_000 } as const;

/** Validate an explicit selection against the same visible listing as Files. */
export function taskDocumentProblem(
  path: string,
  documents: readonly DocumentInfo[],
): string | null {
  const document = documents.find((item) => item.path === path);
  if (!document)
    return 'The selected document is no longer listed in this project. Choose another document.';
  if (!['markdown', 'text', 'plan'].includes(document.kind))
    return 'Select a supported text document.';
  if (document.size > TASK_SOURCE_LIMITS.bytes) return 'Select a document no larger than 128 KB.';
  return null;
}

export function selectTaskSources(
  task: { name: string; description?: string | null; sourceDocument?: string },
  documents: readonly DocumentInfo[],
): string[] {
  if (task.sourceDocument !== undefined) {
    const problem = taskDocumentProblem(task.sourceDocument, documents);
    if (problem) throw new Error(problem);
    return [task.sourceDocument];
  }
  const text = `${task.name}\n${task.description ?? ''}`.toLowerCase();
  if (!text.trim()) return [];
  const candidates = documents.filter((d) => d.kind === 'markdown' || d.kind === 'text');
  const found: { path: string; at: number; size: number }[] = [];
  for (const document of candidates) {
    const path = document.path.replaceAll('\\', '/').toLowerCase();
    const name = path.slice(path.lastIndexOf('/') + 1);
    const at = Math.min(
      ...[path, name].map((needle) => wholeTokenIndex(text, needle)).filter((index) => index >= 0),
    );
    if (Number.isFinite(at)) found.push({ path: document.path, at, size: document.size });
  }
  found.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  const selected: string[] = [];
  let bytes = 0;
  for (const item of found) {
    if (selected.length >= TASK_SOURCE_LIMITS.files) break;
    if (bytes + item.size > TASK_SOURCE_LIMITS.bytes) continue;
    bytes += item.size;
    selected.push(item.path);
  }
  return selected;
}

/** Index of `needle` in `text` where neither neighbour is a path or word character. */
function wholeTokenIndex(text: string, needle: string): number {
  if (!needle) return -1;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) return -1;
    const before = index === 0 ? '' : text[index - 1];
    const after = text[index + needle.length] ?? '';
    const boundary = (ch: string) => ch === '' || !/[\w./\\-]/.test(ch);
    // A final full stop is prose punctuation, but `.bak` and `/child` are
    // still part of a different file name or path.
    const sentenceEnd = after === '.' && boundary(text[index + needle.length + 1] ?? '');
    if (boundary(before) && (boundary(after) || sentenceEnd)) return index;
    from = index + 1;
  }
}
