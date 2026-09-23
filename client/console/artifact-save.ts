import { api, ApiError, readDocument } from '../api';
import {
  fileBelongsTo,
  safeFileBase,
  SAVED_FOLDER,
  savedDocument,
  savedExtension,
  type ArtifactRecord,
} from './artifacts';
import { KIND_LABEL } from './turn-blocks';

// Save to Files: only ever because a person pressed the button. A conversation
// never writes a file on its own (server/modes.ts; the Bedrock turn capability
// says "No writes"). The first save creates the file through the same route the
// editor's "save a copy" uses, so it is a new History entry; a later version of
// the same artifact writes over that file with the version it read, so History
// keeps the evidence and there is never a file per version.

export type SaveOutcome =
  | { ok: true; path: string; created: boolean; sentence: string }
  | { ok: false; sentence: string };

/** How many numbered names a save tries before it asks the person to tidy up. */
export const SAVE_TRIES = 20;

/** `Saved artifacts/Delivery check.md`, then `Saved artifacts/Delivery check 2.md`, and so on. */
export function savedPath(base: string, attempt: number, extension: string): string {
  return `${SAVED_FOLDER}/${attempt === 1 ? base : `${base} ${attempt}`}${extension}`;
}

function failure(cause: unknown): string {
  const detail = cause instanceof Error && cause.message ? cause.message : 'The service did not answer.';
  return `Not saved. ${detail}`;
}

export async function saveArtifact(projectId: string, record: ArtifactRecord): Promise<SaveOutcome> {
  const text = savedDocument(record, record.title);
  const base = safeFileBase(record.title, KIND_LABEL[record.kind]);
  const extension = savedExtension(record.kind);
  const root = `/projects/${encodeURIComponent(projectId)}/documents`;
  try {
    for (let attempt = 1; attempt <= SAVE_TRIES; attempt += 1) {
      const path = savedPath(base, attempt, extension);
      try {
        await api<{ id: string }>(`${root}/create`, 'POST', { path, text });
        return { ok: true, path, created: true, sentence: `Saved to Files as ${path}.` };
      } catch (cause) {
        // 409: a file already has this name. Anything else is a real failure.
        if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
      }
      const current = await readDocument(projectId, path);
      // Someone else's file, or another artifact's: try the next name.
      if (!fileBelongsTo(path, current.text, record)) continue;
      if (current.text === text) return { ok: true, path, created: false, sentence: `Already saved as ${path}.` };
      try {
        await api<{ sha: string; entryId: string }>(`${root}/write`, 'POST', {
          path,
          text,
          baseSha: current.sha,
        });
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 409)
          return { ok: false, sentence: `Not saved. ${path} changed while this was saving; save again.` };
        throw cause;
      }
      return { ok: true, path, created: false, sentence: `Saved this version over ${path}.` };
    }
    return {
      ok: false,
      sentence: `Not saved. ${SAVED_FOLDER} already holds ${SAVE_TRIES} files with this title; rename some of them and save again.`,
    };
  } catch (cause) {
    return { ok: false, sentence: failure(cause) };
  }
}
