import { useEffect, useId, useRef, useState } from 'react';
import type { DocumentContent } from '../../shared/types';
import { ApiError, api, readDocument } from '../api';
import type { EditorDocument, EditorExit } from './editor-guard';
import './document-editor.css';

/**
 * Writing in one document, inside the Console.
 *
 * The Workbook could edit a document and the Console could not, so retiring the
 * Workbook would have taken editing out of the product. This carries that
 * behaviour across, and nothing else: one file, one text box, one Save.
 *
 * Every byte still arrives and leaves through the routes that already exist.
 * Reading is `GET /projects/:id/documents/read` by way of `readDocument`, and
 * saving is `POST /projects/:id/documents/write` with `{ path, text, baseSha }`,
 * the same writer `client/Workspace.tsx` used. `DocumentInfo` and
 * `DocumentContent` stay the file authority (decision 13); there is no second
 * one here, no new route, and no write that the route does not record.
 *
 * Decision 13 lists code editing among the things the pack tier owns and Core
 * does not ship. This is not that. This is a plain text and Markdown document,
 * the Workbook's own shipped scope, in the one surface that is left. There is
 * no code awareness here, no Git, no diff and no second file surface, and this
 * component is deliberately hard to grow one into.
 *
 * Presentation and one file's worth of state. The caller owns the listing, the
 * routing and what happens next; this holds nothing global.
 */

/** A write the server recorded, reported back so the caller can refresh what it shows. */
export interface SavedDocument {
  /** The file that was written: the open document, or the rescue copy when one was made. */
  path: string;
  /** The version the file now carries. Null for a rescue copy, whose route reports an entry only. */
  sha: string | null;
  /** The History entry this write recorded. */
  entryId: string;
}

export interface DocumentEditorProps {
  /** The Project the file belongs to. */
  projectId: string;
  /**
   * The file to open, from the listing the caller already holds. Before the
   * listing has it, the caller passes the path with no kind, and the editor
   * reads nothing and takes no typing until a kind arrives (DIO-87).
   */
  document: EditorDocument;
  /**
   * Why this file can be read but not changed, in words a person can act on.
   * Given, the text box opens read only and Save is not offered.
   */
  readOnlyReason?: string;
  /** Leave the editor. Never called while there is unsaved writing without the person saying so. */
  onClose(): void;
  /**
   * Where the editor puts its answer to "may the person leave now?", for the
   * caller's exit gate (`editor-guard.ts`). The function it holds lets the
   * exit through when nothing would be lost, and otherwise asks first.
   */
  exits?: { current: EditorExit | null };
  /**
   * There is, or is no longer, writing that has not been saved. Fired on every
   * change and once with `false` when the editor goes away, so a caller that
   * blocks navigation cannot be left blocking forever. `UNSAVED_WARNING` is the
   * sentence to show when a person tries to leave.
   */
  onUnsavedChange?(unsaved: boolean): void;
  /** A write landed and was recorded. The listing and History have both moved. */
  onSaved?(saved: SavedDocument): void;
  /**
   * Open another file here. Called after a rescue copy is written, so the
   * person lands on the copy their writing went into. Without it the editor
   * reloads the file it is on and says where the copy went instead.
   */
  onOpen?(path: string): void;
}

/** What a caller says to somebody trying to leave with writing that is not saved. */
export const UNSAVED_WARNING = 'Save your changes before leaving. Your writing is still here.';

/** How many names a rescue copy tries before it gives up and says so. */
const COPY_TRIES = 20;

/**
 * The name a rescue copy takes: the same folder, the same kind of file, and a
 * name the person can find again. Numbered rather than stamped with the clock,
 * because `notes (my copy 2).md` is something a person can read.
 */
export function copyName(path: string, attempt: number): string {
  const slash = path.lastIndexOf('/');
  const folder = slash < 0 ? '' : path.slice(0, slash + 1);
  const file = slash < 0 ? path : path.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const kind = dot > 0 ? file.slice(dot) : '';
  return `${folder}${stem} (my copy${attempt > 1 ? ` ${attempt}` : ''})${kind}`;
}

/**
 * Where unsaved writing waits out a closed window.
 *
 * This is the Workbook's own key and the Workbook's own shape, on purpose:
 * writing somebody left in the Workbook before it was retired is recovered
 * here rather than lost with it. It is a backup of what has not been saved,
 * never a source of file truth. Nothing in it becomes a file except by the
 * person pressing Save and the write route recording it.
 */
const draftKey = (projectId: string, path: string) => `diomedes.draft.${projectId}.${path}`;

interface Draft {
  /** The text the writing started from. */
  text: string;
  /** The version that text was read at. */
  sha: string;
  /** What the person had written and not saved. */
  draft: string;
}

export function readDraft(projectId: string, path: string): Draft | null {
  try {
    const saved = localStorage.getItem(draftKey(projectId, path));
    if (!saved) return null;
    const candidate: unknown = JSON.parse(saved);
    if (
      candidate &&
      typeof candidate === 'object' &&
      'draft' in candidate &&
      typeof candidate.draft === 'string' &&
      'text' in candidate &&
      typeof candidate.text === 'string' &&
      'sha' in candidate &&
      typeof candidate.sha === 'string'
    )
      return { text: candidate.text, sha: candidate.sha, draft: candidate.draft };
    return null;
  } catch {
    return null;
  }
}

/**
 * Only a message the server wrote is shown. Anything else is a failure with no
 * sentence fit to read: `api` parses every response as JSON, so a proxy that
 * answers with a page throws about a stray character, and telling somebody that
 * helps nobody.
 */
function plainFailure(cause: unknown, fallback: string): string {
  return cause instanceof ApiError && cause.message ? cause.message : fallback;
}

/**
 * State belongs to one file. Keyed on the Project and the path, so a caller
 * that swaps the document prop gets a fresh editor rather than one file's
 * writing sitting in another file's box.
 */
export function DocumentEditor(props: DocumentEditorProps) {
  return <OneDocument key={JSON.stringify([props.projectId, props.document.path])} {...props} />;
}

function OneDocument({
  projectId,
  document: file,
  readOnlyReason,
  onClose,
  exits,
  onUnsavedChange,
  onSaved,
  onOpen,
}: DocumentEditorProps) {
  const path = file.path;
  const slash = path.lastIndexOf('/');
  const name = slash < 0 ? path : path.slice(slash + 1);
  /**
   * The kind, settled once. A file waits with no kind until the caller's
   * listing has one, and nothing is read or typed until then. After that it
   * never changes under this editor, so writing already in the box is never
   * turned read only by a later listing (DIO-87).
   */
  const [kind, setKind] = useState(file.kind);
  if (kind === undefined && file.kind !== undefined) setKind(file.kind);
  const resolved = kind !== undefined;
  const problem = !resolved && 'problem' in file ? file.problem : undefined;
  /** `unsupported` is what the read route refuses; it answers as if the file were gone. */
  const supported = resolved && kind !== 'unsupported';

  /** The version this writing started from. Advances on every save it lands. */
  const [base, setBase] = useState<{ text: string; sha: string } | null>(null);
  const [buffer, setBuffer] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [backupWarning, setBackupWarning] = useState<string | null>(null);
  const [outside, setOutside] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [theirs, setTheirs] = useState<{ text: string; sha: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** Where the person was going when they were asked. Null means the editor's own Close. */
  const going = useRef<(() => void) | null>(null);
  const [said, setSaid] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });

  const area = useRef<HTMLTextAreaElement>(null);
  const conflictBox = useRef<HTMLDivElement>(null);
  const leavingBox = useRef<HTMLDivElement>(null);
  /** A ref, not the busy state: two Ctrl+S presses can land before a render. */
  const writing = useRef(false);
  const acting = useRef(false);
  const landed = useRef(false);
  const unsaved = useRef(onUnsavedChange);
  unsaved.current = onUnsavedChange;
  /** What is in the box right now, readable from inside a save that is still in flight. */
  const latest = useRef(buffer);
  latest.current = buffer;

  const loading = (!resolved && !problem) || (supported && !base && !failure);
  const readOnly = (resolved && !supported) || !!readOnlyReason;
  const dirty = !!base && buffer !== base.text;
  const areaId = useId();
  const conflictId = useId();
  const leavingId = useId();

  function announce(text: string) {
    setSaid((prev) => ({ text, seq: prev.seq + 1 }));
  }

  function forgetBackup() {
    try {
      localStorage.removeItem(draftKey(projectId, path));
    } catch {
      // A browser that will not forget the backup is not worth a sentence: the
      // backup is only ever offered back when it differs from the saved file.
    }
  }

  // Reading. The route records the first read of a file, which is the Console's
  // own settled behaviour and the reason this editor does not copy the
  // Workbook's habit of opening only files something had already recorded.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    const controller = new AbortController();
    setFailure(null);
    readDocument(projectId, path, controller.signal)
      .then((doc) => {
        if (alive) open(doc);
      })
      .catch((cause: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setFailure(plainFailure(cause, 'This file could not be opened just now.'));
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, supported, attempt]);

  /**
   * What the person meets when the file arrives. Writing they never saved wins
   * over the file every time: it is the only copy of those words. When it
   * started from a version the file has since moved past, that is a conflict
   * already, and saying so now is kinder than letting them press Save first.
   */
  function open(doc: DocumentContent) {
    setOutside(!!doc.outsideChange);
    // A file that cannot be written has nothing to do with writing that was
    // never saved. The backup stays where it is, for when the file can be
    // changed again.
    const backup = readOnlyReason ? null : readDraft(projectId, path);
    if (backup && backup.draft !== backup.text && backup.draft === doc.text) {
      // The file already says exactly what they wrote. Nothing to recover, and
      // nothing to warn anybody about.
      forgetBackup();
      setBase({ text: doc.text, sha: doc.sha });
      setBuffer(doc.text);
      announce('The writing you had not saved is already in this file.');
      return;
    }
    if (backup && backup.draft !== backup.text) {
      setBase({ text: backup.text, sha: backup.sha });
      setBuffer(backup.draft);
      if (backup.sha === doc.sha) {
        announce('We brought back writing you had not saved.');
        return;
      }
      setTheirs({ text: doc.text, sha: doc.sha });
      setConflict(true);
      announce(
        'We brought back writing you had not saved. Someone else changed this file in the meantime.',
      );
      return;
    }
    setBase({ text: doc.text, sha: doc.sha });
    setBuffer(doc.text);
  }

  // The editor is a destination somebody chose, and the control they chose it
  // with is usually gone by now, so the keyboard lands in the text box once the
  // file is there. A panel that opens later takes the focus off it, below.
  useEffect(() => {
    if (!base || landed.current) return;
    landed.current = true;
    area.current?.focus();
  }, [base]);

  useEffect(() => {
    if (conflict) conflictBox.current?.focus();
  }, [conflict]);

  useEffect(() => {
    if (leaving) leavingBox.current?.focus();
  }, [leaving]);

  // Writing that has not been saved, kept somewhere it survives the window
  // closing. Written on every keystroke and removed the moment the file and the
  // box agree again.
  useEffect(() => {
    if (!base) return;
    try {
      const key = draftKey(projectId, path);
      if (buffer !== base.text)
        localStorage.setItem(
          key,
          JSON.stringify({ path, text: base.text, sha: base.sha, draft: buffer }),
        );
      else localStorage.removeItem(key);
      setBackupWarning(null);
    } catch {
      setBackupWarning(
        'This computer would not keep a spare copy of your unsaved writing. Save before you close Nectovia.',
      );
    }
  }, [base, buffer, path, projectId]);

  // The caller owns routing, so it is told and it decides. Told once more on the
  // way out, or a caller that blocks navigation would block it forever.
  useEffect(() => {
    unsaved.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => unsaved.current?.(false), []);

  /**
   * The exit gate (DIO-85). Writing that is not saved survives leaving only if
   * the backup holds it, so the backup is written now, on the way out, rather
   * than trusted from the last keystroke. If it holds, the person goes, and the
   * writing is offered back when the file opens again. If it will not, nobody
   * leaves without saying so: the same question the Close button asks.
   */
  function requestLeave(then: () => void) {
    if (kept()) then();
    else ask(then);
  }
  /** True when leaving loses nothing: no unsaved writing, or the backup holds it now. */
  function kept(): boolean {
    if (!dirty || !base) return true;
    try {
      localStorage.setItem(
        draftKey(projectId, path),
        JSON.stringify({ path, text: base.text, sha: base.sha, draft: buffer }),
      );
      return true;
    } catch {
      setBackupWarning(
        'This computer would not keep a spare copy of your unsaved writing. Save before you close Nectovia.',
      );
      return false;
    }
  }
  const leaveNow = useRef({ requestLeave, kept });
  leaveNow.current = { requestLeave, kept };
  useEffect(() => {
    if (!exits) return;
    const exit: EditorExit = (then) => leaveNow.current.requestLeave(then);
    exits.current = exit;
    return () => {
      if (exits.current === exit) exits.current = null;
    };
  }, [exits]);

  // Closing the window is an exit too. Writing the backup holds comes back when
  // the file opens again; writing it will not hold makes the browser ask first,
  // the way the Workbook did (and the desktop shell, desktop/main.mjs).
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => {
      if (!leaveNow.current.kept()) event.preventDefault();
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  /**
   * The one write. `from` is the version this writing started from, and the
   * route refuses anything else, which is what makes somebody else's work safe.
   * The version it answers with becomes the new starting point, so a second
   * save is measured against what was just written rather than going stale.
   *
   * Typing during a save is not blocked, because dropping keystrokes to protect
   * a request would be the wrong way round. Words typed while it was in flight
   * simply stay unsaved, and the box says so.
   */
  async function write(from: string): Promise<boolean> {
    if (writing.current || !base || readOnly) return false;
    writing.current = true;
    setSaving(true);
    setTrouble(null);
    const sent = buffer;
    try {
      const result = await api<{ sha: string; entryId: string }>(
        `/projects/${encodeURIComponent(projectId)}/documents/write`,
        'POST',
        { path, text: sent, baseSha: from },
      );
      setBase({ text: sent, sha: result.sha });
      setConflict(false);
      setTheirs(null);
      setOutside(false);
      announce('Saved.');
      onSaved?.({ path, sha: result.sha, entryId: result.entryId });
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // The file moved under this writing. Nothing of theirs was written over,
        // nothing of this person's was lost, and they choose what happens next.
        setTheirs(null);
        // Already refused once: the panel is on screen, so its arrival announces
        // nothing and the newer version they were reading has just gone stale.
        if (conflict) announce('The file changed again. See what it says now before you choose.');
        setConflict(true);
        return false;
      }
      setTrouble(plainFailure(cause, 'Your writing was not saved.'));
      return false;
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  function save() {
    if (!resolved) return;
    if (!supported) {
      announce('This kind of file cannot be changed here.');
      return;
    }
    if (readOnlyReason) {
      announce(readOnlyReason);
      return;
    }
    if (conflict) {
      // Saving again would only be refused again, and it would take the newer
      // version off the screen. The choices are already here.
      conflictBox.current?.focus();
      announce('This file changed while you were writing. Choose what to do with your writing.');
      return;
    }
    if (!base) return;
    if (!dirty) {
      // Saving text that has not changed would record a change that did not
      // happen. The file has one history and it stays honest.
      announce('There is nothing new to save.');
      return;
    }
    void write(base.sha);
  }

  /** Read the file as it stands now, so the choice is made with both versions in view. */
  async function showTheirs() {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setTrouble(null);
    try {
      const doc = await readDocument(projectId, path);
      setTheirs({ text: doc.text, sha: doc.sha });
      announce('What the file says now is shown under the choices.');
    } catch (cause) {
      setTrouble(plainFailure(cause, 'The newer version could not be read just now.'));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  /**
   * The rescue: the person's writing, kept as a file of its own, through the
   * recorded creator the Workbook used. A name already taken comes back as a
   * refusal, which here means try the next name, not that anything went wrong.
   */
  async function saveCopy() {
    if (acting.current || !base) return;
    acting.current = true;
    setBusy(true);
    setTrouble(null);
    const mine = buffer;
    try {
      let written: { path: string; entryId: string } | null = null;
      for (let n = 1; n <= COPY_TRIES && !written; n += 1) {
        const candidate = copyName(path, n);
        try {
          const entry = await api<{ id: string }>(
            `/projects/${encodeURIComponent(projectId)}/documents/create`,
            'POST',
            { path: candidate, text: mine },
          );
          written = { path: candidate, entryId: entry.id };
        } catch (cause) {
          if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
        }
      }
      if (!written) {
        setTrouble(
          'There are already too many copies of this file. Rename some of them and try again.',
        );
        return;
      }
      onSaved?.({ path: written.path, sha: null, entryId: written.entryId });
      forgetBackup();
      setConflict(false);
      setTheirs(null);
      if (onOpen) {
        announce(`Your writing is saved as ${written.path}.`);
        onOpen(written.path);
        return;
      }
      // Nowhere to send them, so this file starts again from what it says now.
      // Safe only because their words are on disk in the copy.
      landed.current = false;
      setBase(null);
      setBuffer('');
      setAttempt((n) => n + 1);
      announce(`Your writing is saved as ${written.path}. This file now shows the newer version.`);
    } catch (cause) {
      setTrouble(plainFailure(cause, 'Your writing could not be saved as a separate file.'));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  async function copyMine() {
    if (acting.current) return;
    acting.current = true;
    setTrouble(null);
    try {
      await navigator.clipboard.writeText(buffer);
      announce('Your writing was copied. Paste it somewhere safe.');
    } catch {
      setTrouble('Your writing could not be copied. Select it in the box below and copy it there.');
    } finally {
      acting.current = false;
    }
  }

  function keepWriting() {
    going.current = null;
    setConflict(false);
    setTheirs(null);
    setLeaving(false);
    area.current?.focus();
  }

  /** Put the question, remembering where the person was going. */
  function ask(then: (() => void) | null) {
    going.current = then;
    setLeaving(true);
    announce(UNSAVED_WARNING);
  }

  /** Go where the person was going: the exit they asked for, or out through Close. */
  function leave() {
    const then = going.current;
    going.current = null;
    setLeaving(false);
    if (then) then();
    else onClose();
  }

  function close() {
    if (!dirty) {
      onClose();
      return;
    }
    ask(null);
  }

  async function saveAndClose() {
    if (!base) return;
    const sent = buffer;
    if (!(await write(base.sha))) {
      // Whatever stopped the save is on screen now, and it is not something to
      // close over, or to go anywhere else over.
      going.current = null;
      setLeaving(false);
      return;
    }
    // Words typed while the save was in flight are not in what was saved, so
    // closing on them would be the loss this panel exists to prevent.
    if (latest.current === sent) {
      leave();
      return;
    }
    going.current = null;
    setLeaving(false);
    area.current?.focus();
    announce('Saved. You wrote more while that was saving, and those words are not saved yet.');
  }

  function throwAway() {
    if (base) setBuffer(base.text);
    forgetBackup();
    leave();
  }

  /**
   * Ctrl+S, on the editor and nowhere else. It is a handler on this element, so
   * it cannot fire while the person is somewhere else in the app, and it does
   * nothing at all when there is no file open or nothing new to save.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && (conflict || leaving)) {
      event.preventDefault();
      event.stopPropagation();
      keepWriting();
      return;
    }
    if (event.altKey || event.shiftKey) return;
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    event.stopPropagation();
    save();
  }

  const state = !resolved
    ? problem
      ? 'Not open'
      : 'Opening'
    : !supported
    ? 'Cannot be changed'
    : failure
      ? 'Not open'
      : loading
        ? 'Opening'
        : readOnly
          ? 'Read only'
          : saving
            ? 'Saving'
            : dirty
              ? 'Not saved yet'
              : 'All saved';

  return (
    <section
      className="docedit"
      aria-label={readOnly ? name : `Writing in ${name}`}
      aria-busy={loading || saving || busy}
      onKeyDown={onKeyDown}
    >
      <div className="de-head">
        <button type="button" className="de-close" onClick={close}>
          Close
        </button>
        <span className="de-path mono lc" title={path}>
          {path}
        </span>
      </div>

      <div className="de-bar">
        <span className="de-state">{state}</span>
        {!readOnly && (
          <button
            type="button"
            className="de-act de-strong"
            disabled={!base || !dirty || saving}
            onClick={save}
          >
            Save changes
          </button>
        )}
      </div>

      {resolved && !supported && (
        <p className="de-note">
          This kind of file cannot be opened here. Open it in the program that made it.
        </p>
      )}
      {readOnlyReason && <p className="de-note">{readOnlyReason}</p>}
      {outside && (
        <p className="de-note">
          This file was changed outside Nectovia. You are looking at the newest version.
        </p>
      )}
      {backupWarning && <p className="de-note de-warn">{backupWarning}</p>}
      {loading && <p className="de-note">Opening this file...</p>}
      {problem && (
        <p className="de-trouble" role="alert">
          {problem}
        </p>
      )}

      {failure && (
        <div className="de-trouble" role="alert">
          <p>{failure}</p>
          <button
            type="button"
            className="de-act"
            onClick={() => {
              setFailure(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}

      {trouble && (
        <p className="de-trouble" role="alert">
          {trouble} Your writing is still here.
        </p>
      )}

      {conflict && (
        <div
          className="de-panel"
          role="alert"
          tabIndex={-1}
          ref={conflictBox}
          aria-labelledby={conflictId}
        >
          <h3 id={conflictId}>Someone else changed this file while you were writing</h3>
          <p>
            Your writing is still in the box below, and none of it has been written over. Choose
            what to do with it.
          </p>
          <div className="de-acts">
            {!theirs && (
              <button
                type="button"
                className="de-act"
                disabled={busy}
                onClick={() => void showTheirs()}
              >
                See what the file says now
              </button>
            )}
            {/* The accent sits on the choice that keeps everybody's work, never
                on the one that writes over somebody else's. */}
            <button
              type="button"
              className="de-act de-strong"
              disabled={busy || saving}
              onClick={() => void saveCopy()}
            >
              Save my writing as a separate file
            </button>
            <button
              type="button"
              className="de-act"
              disabled={busy}
              onClick={() => void copyMine()}
            >
              Copy my writing
            </button>
            {theirs && (
              <button
                type="button"
                className="de-act"
                disabled={busy || saving}
                onClick={() => void write(theirs.sha)}
              >
                Replace it with my writing
              </button>
            )}
            <button type="button" className="de-act" onClick={keepWriting}>
              Keep writing
            </button>
          </div>
          {theirs && (
            <>
              <p className="de-note">Nectovia keeps a record of the version you replace.</p>
              <div
                className="de-theirs"
                tabIndex={0}
                role="group"
                aria-label="What the file says now"
              >
                <pre>{theirs.text || 'This file is empty now.'}</pre>
              </div>
            </>
          )}
        </div>
      )}

      {leaving && (
        <div
          className="de-panel"
          role="alert"
          tabIndex={-1}
          ref={leavingBox}
          aria-labelledby={leavingId}
        >
          <h3 id={leavingId}>You have writing that is not saved</h3>
          <p>Closing now would lose it. Save it first, or throw it away on purpose.</p>
          <div className="de-acts">
            <button
              type="button"
              className="de-act de-strong"
              disabled={saving}
              onClick={() => void saveAndClose()}
            >
              Save and close
            </button>
            <button type="button" className="de-act" onClick={keepWriting}>
              Keep writing
            </button>
            <button type="button" className="de-act" onClick={throwAway}>
              Throw my writing away
            </button>
          </div>
        </div>
      )}

      {base && (
        <>
          <label className="de-label" htmlFor={areaId}>
            The text in this file
          </label>
          <textarea
            id={areaId}
            ref={area}
            className="de-area"
            value={buffer}
            readOnly={readOnly}
            spellCheck
            placeholder={readOnly ? 'This file is empty.' : 'This file is empty. Start writing.'}
            onChange={(event) => setBuffer(event.target.value)}
          />
        </>
      )}

      {/* One polite region for everything this editor has to say, so saving,
          recovery and the rest arrive in a place the reader is already on. */}
      <p className="de-said" role="status">
        <span key={said.seq}>{said.text}</span>
      </p>
    </section>
  );
}
