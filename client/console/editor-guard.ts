import type { DocumentInfo } from '../../shared/types';

/**
 * The one way out of the document editor (DIO-85).
 *
 * The editor holds the only copy of writing that has not been saved, and the
 * draft backup that normally keeps it can fail (a full or refused browser
 * store). So nothing may take the editor off the screen by itself: opening
 * another file, a rail destination, a thread, the palette, Settings, Projects
 * and another project's tab all call `leaveEditor` with what they were going
 * to do, and the editor decides. With nothing unsaved, or with the writing
 * safely in the backup, it lets them through at once; otherwise it asks, with
 * its own "You have writing that is not saved" panel, and the navigation
 * happens only once the person has saved or chosen to throw the writing away.
 *
 * The gate is module state rather than a prop because the exits live on both
 * sides of the Console: some in `Shell`, which owns the editor, and some in
 * `App`, which unmounts `Shell` for Settings, Projects and a project switch.
 * There is one Console on screen at a time, so there is one gate.
 */
export type EditorExit = (then: () => void) => void;

let gate: EditorExit | null = null;

/** Install the gate while an editor can be open. Returns the call that removes it. */
export function guardEditorExits(exit: EditorExit): () => void {
  gate = exit;
  return () => {
    if (gate === exit) gate = null;
  };
}

/**
 * Leave the editor, then do `then`. Runs `then` straight away when no editor
 * is open; otherwise it runs once the editor has let the person go, and never
 * if they chose to keep writing.
 */
export function leaveEditor(then: () => void): void {
  const current = gate;
  if (current) current(then);
  else then();
}

/**
 * A file the editor has been asked to open before the project's listing has
 * said what kind of file it is. It has no `kind`, so nothing can mistake it
 * for one the editor may write (DIO-87).
 */
export interface UnresolvedDocument {
  path: string;
  kind?: undefined;
  /** Why the kind cannot be settled, when the listing itself could not be read. */
  problem?: string;
}

export type EditorDocument = DocumentInfo | UnresolvedDocument;

/**
 * What the editor is given for `path`: the listing's own record when it has
 * one, and otherwise an unresolved file that waits for it. The kind is never
 * guessed, because a guessed `markdown` let a person type into a file the
 * listing then said could not be saved.
 */
export function editorDocument(
  documents: readonly DocumentInfo[],
  path: string,
  failure: string | null,
): EditorDocument {
  const listed = documents.find((file) => file.path === path);
  if (listed) return listed;
  return failure ? { path, problem: failure } : { path };
}
