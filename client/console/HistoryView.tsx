import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Change,
  Detail,
  FileRecord,
  HistoryEntry,
  Need,
  RestoreConflict,
  Session,
} from '../../shared/types';
import { formatOrigin, originForSession } from '../../shared/attribution';
import { api, ApiError } from '../api';
import { ApprovalStatus, Button, ChangeCard, Modal, date, time } from '../components';
import './history.css';

/**
 * History: everything that has happened in this project, and the way back.
 *
 * The Console had no History of its own — its rail button switched the whole
 * surface to the Workbook. This is that surface rebuilt here: the whole record
 * rather than the Ledger's last three lines, and restore with its conflict,
 * failure and undo paths intact.
 *
 * It creates no second authority over files. Putting a file back is the one
 * existing route, `POST /projects/:id/history/:entryId/restore`, which writes
 * through the same recorded writer every other change uses. That is also why a
 * restore is never a rewind: the server records it as a new entry, leaves the
 * old one where it is, and this view says so in those words.
 *
 * Presentation and three routes, all of them already shipped: `restore` above,
 * `GET /history/:entryId/changes` for the before-and-after of one entry, and
 * `POST /history/label` to save a version. It owns no project state: `entries`
 * arrive from the caller, and a restore tells the caller through `onRestored` —
 * though a Console that is already reading the `state` event will see the new
 * entry arrive on its own.
 */

/** Rows drawn before "Show older", and file rows drawn inside one entry. */
const PAGE = 40;
/** The most file names one confirmation prints before it counts the rest. */
const NAMED_IN_DIALOG = 12;
/** The most file names one row prints before it counts the rest. */
const NAMED_IN_ROW = 3;

/** The four readings of the record: everything, saved versions, and each actor. */
export type HistoryFilter = 'all' | 'saved' | 'diomedes' | 'you';

/** What the server may do when files changed after the version being put back. */
export type RestoreChoice = 'all' | 'unchanged-only' | 'copies';

/** The answer from `POST /history/:entryId/restore`. */
export interface RestoreResult {
  /** The new History entry this restore was recorded as. Undo restores that. */
  entryId: string;
  /** Files that had changed since. With a choice sent, they were handled by it. */
  conflicts: RestoreConflict[];
  /** The new entry itself, so the exact files written can be named. */
  entry?: HistoryEntry;
}

export interface HistoryViewProps {
  /** The project being read. Used only to address the routes that already exist. */
  projectId: string;
  /** Every entry, oldest first, exactly as `ProjectState.history` holds them. */
  entries: readonly HistoryEntry[];
  /** The project's sessions, so a row can name who made the change. Optional. */
  sessions?: readonly Session[];
  /** The project's needs, so an entry can show the decision that allowed it. */
  needs?: readonly Need[];
  /** True while the first read is still on its way. */
  loading?: boolean;
  /** Why the history could not be read, in plain words, or null. */
  failure?: string | null;
  /** True while the caller is busy elsewhere; restoring waits. */
  busy?: boolean;
  /**
   * How much a change spells out about itself, passed straight to `ChangeCard`.
   * The person's own setting, which is why this view does not decide it.
   */
  detail?: Detail;
  /** Called after a restore or an undo lands, with what the server answered. */
  onRestored?(result: RestoreResult): void;
  /**
   * A version was saved, so the caller can re-read the record. Without it the
   * control still works and the new entry arrives with the next state event.
   */
  onSavedVersion?(): void;
  /** Open one file where the caller keeps files. Without it, no such control. */
  onOpenFile?(path: string): void;
  /**
   * Stop the work that is running, so a restore it blocks can go ahead. Work
   * control belongs to the caller: without this, the dialog says to stop the
   * work first instead of offering a button that is not wired to anything.
   *
   * `taskId` is what the server reported on the 409 and is passed on unread by
   * anything here. A caller stops by `sessionId`: the session stop route looks
   * the session up and takes the task from it, so a task this view could not
   * name cannot leave a person stuck with a restore they are not allowed to
   * make.
   */
  onStopWork?(work: { sessionId: string; taskId: string | null }): Promise<void>;
  /** Told about a failure as well; the person is always told either way. */
  onError?(error: unknown): void;
}

/** One day of the record, in the order the rows arrived. */
export interface HistoryDay {
  key: string;
  heading: string;
  entries: HistoryEntry[];
}

/** Which rows a filter keeps. `diomedes` is everything the person did not do. */
export function matchesFilter(entry: HistoryEntry, filter: HistoryFilter): boolean {
  if (filter === 'saved') return entry.kind === 'saved-version';
  if (filter === 'you') return entry.actor === 'you';
  if (filter === 'diomedes') return entry.actor !== 'you';
  return true;
}

function dayHeading(when: Date, today: Date): string {
  if (when.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (when.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return when.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Group rows under the day they happened, keeping the order they arrive in.
 * Newest first is the caller's job, because the same grouping serves a page of
 * forty rows and a whole day of them.
 */
export function historyDays(entries: readonly HistoryEntry[], today = new Date()): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const entry of entries) {
    const when = new Date(entry.time);
    const key = when.toDateString();
    const last = days[days.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else days.push({ key, heading: dayHeading(when, today), entries: [entry] });
  }
  return days;
}

/** A saved version of the whole folder also stands for what was not there yet. */
function isWholeFolder(entry: HistoryEntry): boolean {
  return entry.kind === 'saved-version' && entry.sentence.includes('(whole folder)');
}

/** Only files the server kept a copy of can be put back. */
function restorable(entry: HistoryEntry): FileRecord[] {
  return entry.files.filter((file) => file.recorded);
}

function names(paths: readonly string[], limit: number): string {
  if (paths.length <= limit) return paths.join(', ');
  const rest = paths.length - limit;
  return `${paths.slice(0, limit).join(', ')}, and ${rest} more ${rest === 1 ? 'file' : 'files'}`;
}

function fileWord(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** The clock time, with the date as well when it falls on a different day. */
function whenText(iso: string, sameDayAs: string): string {
  return new Date(iso).toDateString() === new Date(sameDayAs).toDateString()
    ? time(iso)
    : `${date(iso)}, ${time(iso)}`;
}

/** What putting this file back does to it, said the way it will happen. */
function fileOutcome(file: FileRecord, savedVersion: boolean, cause: string): string {
  if (!file.recorded)
    return file.reason
      ? `Cannot be put back: ${file.reason.toLowerCase()}`
      : 'Cannot be put back. It was never saved to History.';
  if (savedVersion) return 'Goes back to the way it was in this version';
  if (file.op === 'created') return `Is removed, because ${cause} created it`;
  if (file.op === 'deleted') return 'Comes back';
  return `Goes back to the way it was before ${cause}`;
}

/**
 * Who changed a file, in words. The server sends either the actor of the entry
 * that last touched it or the sentence `outside Diomedes`, so anything it does
 * not recognise is printed as it arrived rather than guessed at.
 */
function actorWord(actor: string): string {
  if (actor === 'you') return 'you';
  if (actor === 'diomedes' || actor === 'diomedes-with-ok') return 'Diomedes';
  return actor;
}

/** What Diomedes is being asked to put back, and what the server said about it. */
interface Ask {
  entryId: string;
  kind: 'entry' | 'file' | 'undo';
  /** Every file this would touch, for the list the person reads before saying yes. */
  paths: string[];
  /**
   * The same files as records, when they are known, so the confirmation can say
   * what happens to each one rather than only naming it. Absent only when the
   * server answered a restore without echoing the entry it wrote.
   */
  records?: FileRecord[];
  /** Sent to the route. Absent means every saved file in that entry. */
  files?: string[];
  savedVersion: boolean;
  wholeFolder: boolean;
  /**
   * True when undoing would only remove files: the restore made copies, or it
   * brought back a version in which those files did not exist yet. Saying
   * "puts them back" there would be the opposite of what happens.
   */
  removesAll?: boolean;
  /** Files changed since; the server sends these back instead of guessing. */
  conflicts?: RestoreConflict[];
  /** Work was running, so nothing was touched. */
  inProgress?: { sessionId: string; taskId: string | null; path: string };
}

interface Note {
  tone: 'done' | 'attn' | 'fail';
  text: string;
  /** Present after a restore: the entry an undo would put back. */
  undo?: Ask;
}

function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404)
      return 'That entry is not in this project any more, so nothing was put back.';
    if (error.status === 409)
      return 'A file changed while this was running, so nothing was put back. Read the list again and try once more.';
    if (error.status === 413) return 'A file is too large to put back.';
    return `Nothing was put back. ${error.message}`;
  }
  return 'Nothing was put back. Diomedes could not reach the service on this computer.';
}

/**
 * History, as one surface: the record on the left of the reading, the entry and
 * its files one step deeper, and every restore confirmed before it touches a
 * file.
 */
export function HistoryView({
  projectId,
  entries,
  sessions = [],
  needs = [],
  loading = false,
  failure = null,
  busy = false,
  detail = 'standard',
  onRestored,
  onSavedVersion,
  onOpenFile,
  onStopWork,
  onError,
}: HistoryViewProps) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [shown, setShown] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shownFiles, setShownFiles] = useState(PAGE);
  // The before and after of the open entry, read once it is opened. Null while
  // it is on its way, and a sentence when it could not be read: an entry whose
  // diff will not load still lists its files and still restores them.
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [changesFailure, setChangesFailure] = useState<string | null>(null);
  // Saving a version: the name is asked for first, the same way the Workbook
  // asked, because an unnamed version is one nobody can find again.
  const [naming, setNaming] = useState<string | null>(null);
  // Which files in the open entry are showing their before and after. Opened
  // one at a time on purpose: an entry can hold forty files, and forty diffs
  // painted at once is not a thing anybody reads.
  const [shownDiffs, setShownDiffs] = useState<string[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<number | null>(null);
  const [undone, setUndone] = useState(0);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const hide = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const explain = useRef<HTMLParagraphElement>(null);
  const cameFrom = useRef<string | null>(null);

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  // The restore that put an entry back, so a row can say it was put back later
  // without anyone reading it as the entry having been rewound. The newest one
  // wins, because that is the one a person is looking for.
  const putBackBy = useMemo(() => {
    const map = new Map<string, HistoryEntry>();
    for (const entry of entries) if (entry.restoreOf) map.set(entry.restoreOf, entry);
    return map;
  }, [entries]);

  const ordered = useMemo(() => [...entries].reverse(), [entries]);
  const kept = useMemo(
    () => ordered.filter((entry) => matchesFilter(entry, filter)),
    [ordered, filter],
  );
  const page = useMemo(() => kept.slice(0, shown), [kept, shown]);
  const days = useMemo(() => historyDays(page), [page]);
  const rows = useMemo(() => page.map((entry) => entry.id), [page]);
  const activeId = activeRow && rows.includes(activeRow) ? activeRow : (rows[0] ?? null);
  const open = openId ? (byId.get(openId) ?? null) : null;
  // What the confirmation is asking. It changes in place when the server
  // answers that work is running or that files changed since.
  const asking = !ask ? 'none' : ask.inProgress ? 'work' : ask.conflicts?.length ? 'changed' : 'go';

  useEffect(() => {
    setShown(PAGE);
  }, [filter]);

  useEffect(() => {
    setShownFiles(PAGE);
    setShownDiffs([]);
  }, [openId]);

  // The diff for the entry being read. Abandoned if the person leaves before it
  // arrives, so a slow read cannot paint one entry's changes onto another.
  useEffect(() => {
    setChanges(null);
    setChangesFailure(null);
    if (!openId) return;
    let live = true;
    api<{ files: Change[] }>(`/projects/${projectId}/history/${openId}/changes`)
      .then((result) => {
        if (live) setChanges(result.files);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setChangesFailure(
          'Diomedes could not read what changed in this entry. The files below are still listed, and they can still be put back.',
        );
        onError?.(error);
      });
    return () => {
      live = false;
    };
  }, [openId, projectId, onError]);

  // Reading one entry is a step deeper, so the heading takes the focus. Nothing
  // happens on the first render: the view opens on the list.
  useEffect(() => {
    if (openId) heading.current?.focus();
  }, [openId]);

  // When the server answers a restore with a question, the button that was
  // pressed is replaced by the choices. Focus moves to the paragraph that says
  // what happened, so it is read out and nobody is left focused on nothing.
  useEffect(() => {
    if (asking === 'work' || asking === 'changed') explain.current?.focus();
  }, [asking]);

  // An undo takes its own button away with it, and the dialog that closed would
  // hand the focus back to a control that is no longer there. The line saying
  // what happened keeps it instead.
  useEffect(() => {
    if (undone) hide.current?.focus();
  }, [undone]);

  // Coming back lands on the row that was opened, not at the top of the page.
  useEffect(() => {
    if (openId !== null) return;
    const id = cameFrom.current;
    if (!id) return;
    cameFrom.current = null;
    setActiveRow(id);
    cells.current.get(`${id}:open`)?.focus();
  }, [openId]);

  // Older rows arrive under the button that asked for them, and the button goes
  // once there is nothing left, so the keyboard moves to the first new row.
  useEffect(() => {
    if (revealed === null) return;
    const id = kept[revealed]?.id;
    setRevealed(null);
    if (!id) return;
    setActiveRow(id);
    cells.current.get(`${id}:open`)?.focus();
  }, [revealed, kept]);

  function keep(key: string) {
    return (element: HTMLButtonElement | null) => {
      if (element) cells.current.set(key, element);
      else cells.current.delete(key);
    };
  }

  function focusCell(id: string, part: 'open' | 'verb') {
    (cells.current.get(`${id}:${part}`) ?? cells.current.get(`${id}:open`))?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key))
      return;
    const index = rows.findIndex((id) => id === activeId);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Ends clamp rather than wrap, the way the Everything panel and the file
    // tree do.
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      focusCell(rows[index], event.key === 'ArrowRight' ? 'verb' : 'open');
      return;
    }
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, index + 1)
            : Math.max(0, index - 1);
    focusCell(rows[next], 'open');
  }

  function originLabel(entry: HistoryEntry): string | null {
    const session = entry.sessionId
      ? (sessions.find((item) => item.id === entry.sessionId) ?? null)
      : null;
    const snapshot = entry.origin ?? (session ? originForSession(session) : undefined);
    return snapshot ? formatOrigin(snapshot).label : null;
  }

  /** The plain sentence for what putting this back would do, before it happens. */
  function entrySentence(ask: Ask): string {
    const count = fileWord(ask.paths.length);
    const was = ask.paths.length === 1 ? 'it was' : 'they were';
    const kept =
      'Nothing is deleted from History: this is added as a new entry, and you can undo it.';
    if (ask.kind === 'undo')
      return ask.removesAll
        ? `This removes ${count} the restore just made. The files you had before are not touched, and the undo is listed in History too.`
        : `This puts ${count} back the way ${was} just before the restore. The undo is listed in History too.`;
    if (ask.savedVersion)
      return `This puts ${count} back the way ${was} when this version was saved.${
        ask.wholeFolder ? ' Files added since then are removed.' : ''
      } ${kept}`;
    return `This puts ${count} back the way ${was} before this change. ${kept}`;
  }

  function askEntry(entry: HistoryEntry) {
    const files = restorable(entry);
    setNote(null);
    setAsk({
      entryId: entry.id,
      kind: 'entry',
      paths: files.map((file) => file.path),
      records: files,
      savedVersion: entry.kind === 'saved-version',
      wholeFolder: isWholeFolder(entry),
    });
  }

  function askFile(entry: HistoryEntry, file: FileRecord) {
    setNote(null);
    setAsk({
      entryId: entry.id,
      kind: 'file',
      paths: [file.path],
      files: [file.path],
      records: [file],
      savedVersion: entry.kind === 'saved-version',
      wholeFolder: false,
    });
  }

  async function run(request: Ask, choice?: RestoreChoice) {
    setWorking(true);
    try {
      const result = await api<RestoreResult>(
        `/projects/${encodeURIComponent(projectId)}/history/${encodeURIComponent(request.entryId)}/restore`,
        'POST',
        {
          ...(request.files ? { files: request.files } : {}),
          ...(choice ? { mode: choice } : {}),
        },
      );
      const written = result.entry?.files.length ?? request.paths.length;
      setAsk(null);
      setNote({
        tone: 'done',
        text: outcome(request, choice, written),
        undo:
          request.kind === 'undo'
            ? undefined
            : {
                entryId: result.entryId,
                kind: 'undo',
                paths: result.entry?.files.map((file) => file.path) ?? request.paths,
                records: result.entry?.files,
                savedVersion: false,
                wholeFolder: false,
                removesAll:
                  choice === 'copies' ||
                  (!!result.entry?.files.length &&
                    result.entry.files.every((file) => file.op === 'created')),
              },
      });
      if (request.kind === 'undo') setUndone((count) => count + 1);
      onRestored?.(result);
    } catch (error) {
      // 409 is the server asking a question, not a failure: either work is
      // running, or files changed since and it will not choose for anybody.
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        (error.data.conflicts || error.data.inProgress)
      )
        setAsk({
          ...request,
          conflicts: error.data.conflicts as RestoreConflict[] | undefined,
          inProgress: error.data.inProgress as Ask['inProgress'],
        });
      else {
        setAsk(null);
        setNote({ tone: 'fail', text: failureText(error) });
        onError?.(error);
      }
    } finally {
      setWorking(false);
    }
  }

  function outcome(request: Ask, choice: RestoreChoice | undefined, written: number): string {
    const count = fileWord(written);
    if (choice === 'copies')
      return `Saved ${count} beside the ones you have now. Nothing was written over, and this is listed at the top of History.`;
    if (choice === 'unchanged-only')
      return `Put back ${count}. The files that had changed were left as they are, and this is listed at the top of History.`;
    if (choice === 'all')
      return `Put back ${count}. The newer version of each one was saved to History first, and this is listed at the top of History.`;
    if (request.kind === 'undo')
      return `Undone. ${count} changed back, and the undo is listed at the top of History too.`;
    return `${count} put back. This restore is listed at the top of History as its own entry, so nothing was lost, and you can undo it.`;
  }

  async function stopAndRestore(request: Ask) {
    const work = request.inProgress;
    if (!work || !onStopWork) return;
    setWorking(true);
    try {
      await onStopWork({ sessionId: work.sessionId, taskId: work.taskId });
    } catch (error) {
      setAsk(null);
      setNote({ tone: 'fail', text: failureText(error) });
      onError?.(error);
      setWorking(false);
      return;
    }
    setWorking(false);
    await run({ ...request, inProgress: undefined });
  }

  /**
   * Save a version: the Workbook's control, on the Workbook's route, in the one
   * surface that is left. It writes nothing itself. `POST /history/label` asks
   * the store for a snapshot, which arrives as an ordinary entry at the top of
   * this list, so the confirmation is the record itself.
   */
  async function saveVersion(label: string) {
    const name = label.trim();
    if (!name) return;
    setWorking(true);
    try {
      await api(`/projects/${projectId}/history/label`, 'POST', { label: name });
      setNaming(null);
      setNote({
        tone: 'done',
        text: `Saved this version as "${name}". It is at the top of History, and you can put the files back from it at any time.`,
      });
      onSavedVersion?.();
    } catch (error) {
      setNote({
        tone: 'fail',
        text:
          error instanceof ApiError
            ? `No version was saved. ${error.message}`
            : 'No version was saved. Diomedes could not reach the service on this computer.',
      });
      onError?.(error);
    } finally {
      setWorking(false);
    }
  }

  function row(entry: HistoryEntry) {
    const files = restorable(entry);
    const paths = entry.files.map((file) => file.path);
    const label = originLabel(entry);
    const putBack = putBackBy.get(entry.id);
    const restoredFrom = entry.restoreOf ? byId.get(entry.restoreOf) : undefined;
    const on = activeId === entry.id;
    const parts = [
      paths.length ? names(paths, NAMED_IN_ROW) : null,
      label,
      restoredFrom ? `Put back the change from ${whenText(restoredFrom.time, entry.time)}` : null,
      putBack ? `Put back later, at ${whenText(putBack.time, entry.time)}` : null,
    ].filter(Boolean);
    return (
      <li className="hrow" key={entry.id}>
        <button
          type="button"
          ref={keep(`${entry.id}:open`)}
          className="hopen"
          tabIndex={on ? 0 : -1}
          // No `aria-label`: a name written over this would hide the line under
          // it, which is where the file names and who made the change are.
          onFocus={() => setActiveRow(entry.id)}
          onClick={() => {
            cameFrom.current = entry.id;
            setOpenId(entry.id);
          }}
        >
          <time className="mono lc" dateTime={entry.time}>
            {time(entry.time)}
          </time>
          <span className="hsent">{entry.sentence}</span>
          {parts.length > 0 && <small className="hmeta">{parts.join(' · ')}</small>}
        </button>
        {files.length > 0 && (
          <button
            type="button"
            ref={keep(`${entry.id}:verb`)}
            className="verb"
            tabIndex={on ? 0 : -1}
            disabled={busy || working}
            onFocus={() => setActiveRow(entry.id)}
            onClick={() => askEntry(entry)}
          >
            {entry.kind === 'saved-version' ? 'Restore this version' : 'Put the files back'}
          </button>
        )}
      </li>
    );
  }

  function list() {
    if (loading && entries.length === 0)
      return <p className="hquiet">Reading what has happened in this project.</p>;
    if (entries.length === 0)
      return (
        <div className="hempty">
          <h2>Nothing has changed yet</h2>
          <p>
            Every change Diomedes makes in this project is listed here, with a way to put the files
            back.
          </p>
        </div>
      );
    if (kept.length === 0)
      return (
        <div className="hempty">
          <h2>Nothing to show here</h2>
          <p>There is nothing in this part of the record yet.</p>
          <button type="button" className="verb light" onClick={() => setFilter('all')}>
            Show all of it
          </button>
        </div>
      );
    const left = kept.length - page.length;
    return (
      <div className="hlist" onKeyDown={onListKeyDown}>
        {days.map((day) => (
          <section className="hday" key={day.key}>
            <h2>{day.heading}</h2>
            <ul>{day.entries.map(row)}</ul>
          </section>
        ))}
        {left > 0 && (
          <button
            type="button"
            className="verb more"
            onClick={() => {
              setRevealed(page.length);
              setShown(shown + PAGE);
            }}
          >
            Show {Math.min(PAGE, left)} older
          </button>
        )}
      </div>
    );
  }

  function entryView(entry: HistoryEntry) {
    const files = entry.files.slice(0, shownFiles);
    const left = entry.files.length - files.length;
    const saved = entry.kind === 'saved-version';
    const canRestore = restorable(entry);
    const label = originLabel(entry);
    const approval = entry.approvalId
      ? needs.find((need) => need.id === entry.approvalId)
      : undefined;
    const putBack = putBackBy.get(entry.id);
    const restoredFrom = entry.restoreOf ? byId.get(entry.restoreOf) : undefined;
    return (
      <div className="hentry">
        <button
          type="button"
          className="verb back"
          onClick={() => {
            cameFrom.current = entry.id;
            setOpenId(null);
          }}
        >
          Back to the list
        </button>
        <h2 ref={heading} tabIndex={-1}>
          {entry.sentence}
        </h2>
        <p className="mono lc">
          {date(entry.time)}, {time(entry.time)}
          {label ? ` · ${label}` : ''}
        </p>
        {restoredFrom && (
          <p className="hsay">
            This put the files back the way they were before the change at{' '}
            {whenText(restoredFrom.time, entry.time)}. That change is still in History.
          </p>
        )}
        {putBack && (
          <p className="hsay">
            The files from this entry were put back at {whenText(putBack.time, entry.time)}. That
            restore is its own entry; this one was left as it is.
          </p>
        )}
        {approval && <ApprovalStatus need={approval} />}
        {entry.files.length === 0 ? (
          <p className="hquiet">No files changed here, so there is nothing to put back.</p>
        ) : (
          <>
            <p className="hsay">
              {canRestore.length > 0
                ? entrySentence({
                    entryId: entry.id,
                    kind: 'entry',
                    paths: canRestore.map((file) => file.path),
                    savedVersion: saved,
                    wholeFolder: isWholeFolder(entry),
                  })
                : 'None of these files were saved to History, so they cannot be put back.'}
            </p>
            {changesFailure && (
              <p className="hquiet">{changesFailure}</p>
            )}
            <ul className="hfiles">
              {files.map((file, index) => {
                const key = `${file.path}:${index}`;
                const change = changes?.[index];
                const showing = shownDiffs.includes(key);
                return (
                  <li className="hfile" key={key}>
                    <span className="hpath">{file.path}</span>
                    <span className={`hwhat${file.recorded ? '' : ' warn'}`}>
                      {fileOutcome(file, saved, 'this change')}
                    </span>
                    <span className="hfacts">
                      {file.recorded && (
                        <button
                          type="button"
                          className="verb"
                          disabled={busy || working}
                          onClick={() => askFile(entry, file)}
                        >
                          Put this file back
                        </button>
                      )}
                      {onOpenFile && file.op !== 'deleted' && (
                        <button type="button" className="verb" onClick={() => onOpenFile(file.path)}>
                          Open this file
                        </button>
                      )}
                      {change && (
                        <button
                          type="button"
                          className="verb"
                          aria-expanded={showing}
                          onClick={() =>
                            setShownDiffs(
                              showing
                                ? shownDiffs.filter((item) => item !== key)
                                : [...shownDiffs, key],
                            )
                          }
                        >
                          {showing ? 'Hide what changed' : 'Show what changed'}
                        </button>
                      )}
                    </span>
                    {change && showing && (
                      <div className="hdiff">
                        <ChangeCard change={change} detail={detail}>
                          {null}
                        </ChangeCard>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {left > 0 && (
              <button
                type="button"
                className="verb more"
                onClick={() => setShownFiles(shownFiles + PAGE)}
              >
                Show {Math.min(PAGE, left)} more files
              </button>
            )}
            {canRestore.length > 0 && (
              <div className="hacts">
                <button
                  type="button"
                  className="verb light"
                  disabled={busy || working}
                  onClick={() => askEntry(entry)}
                >
                  {saved ? 'Restore this version' : `Put ${fileWord(canRestore.length)} back`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  function dialogTitle(request: Ask): string {
    if (request.inProgress) return 'Diomedes is working right now';
    if (request.conflicts?.length) return 'Some files have changed since then';
    if (request.kind === 'undo') return 'Undo the restore?';
    if (request.kind === 'file') return 'Put this file back?';
    if (request.savedVersion) return 'Restore this version?';
    return `Put ${fileWord(request.paths.length)} back?`;
  }

  function dialog(request: Ask) {
    const conflicts = request.conflicts ?? [];
    const records = request.records ?? [];
    return (
      <Modal title={dialogTitle(request)} onClose={() => setAsk(null)}>
        {request.inProgress ? (
          // The server's answer, and where the focus goes when it arrives, so
          // the reason is read rather than left behind a button that vanished.
          <p className="prose" ref={explain} tabIndex={-1}>
            Diomedes is in the middle of a piece of work in this project. Nothing was put back,
            because that work could be writing to the same files.
            {onStopWork
              ? ''
              : ' Stop that work first, then put the files back. What it has already written stays in History.'}
          </p>
        ) : conflicts.length > 0 ? (
          <>
            <p className="prose" ref={explain} tabIndex={-1}>
              Nothing was put back yet. {fileWord(conflicts.length)} changed after the version you
              are putting back, so choose what happens to {conflicts.length === 1 ? 'it' : 'them'}.
              Whatever you choose, the newer work stays in History and can be put back later.
            </p>
            <ul className="hconflicts">
              {conflicts.map((conflict) => (
                <li key={conflict.path}>
                  <span className="hpath">{conflict.path}</span>
                  <span className="hwhat">
                    changed by {actorWord(conflict.actor)}
                    {conflict.at ? ` at ${time(conflict.at)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="prose">{entrySentence(request)}</p>
            {/* Each file with what happens to it: a change that created a file
                is undone by removing it, and nobody should meet that after the
                fact. */}
            <ul className="hnamed">
              {records.length > 0
                ? records.slice(0, NAMED_IN_DIALOG).map((record, index) => (
                    <li key={`${record.path}:${index}`}>
                      <span className="hpath">{record.path}</span>
                      <span className="hwhat">
                        {fileOutcome(
                          record,
                          request.savedVersion,
                          request.kind === 'undo' ? 'the restore' : 'this change',
                        )}
                      </span>
                    </li>
                  ))
                : request.paths.slice(0, NAMED_IN_DIALOG).map((path) => (
                    <li key={path}>
                      <span className="hpath">{path}</span>
                    </li>
                  ))}
              {request.paths.length > NAMED_IN_DIALOG && (
                <li className="hwhat">and {request.paths.length - NAMED_IN_DIALOG} more files</li>
              )}
            </ul>
          </>
        )}
        {conflicts.length > 0 && request.paths.length > conflicts.length && (
          <p className="prose">
            The other {fileWord(request.paths.length - conflicts.length)} go back either way.
          </p>
        )}
        <div className="dialog-actions">
          <Button onClick={() => setAsk(null)}>Cancel</Button>
          {request.inProgress ? (
            onStopWork ? (
              <Button
                tone="primary"
                disabled={busy || working}
                onClick={() => void stopAndRestore(request)}
              >
                Stop the work and put the files back
              </Button>
            ) : null
          ) : conflicts.length > 0 ? (
            <>
              <Button
                tone="primary"
                disabled={busy || working}
                onClick={() => void run(request, 'all')}
              >
                Put all of them back
              </Button>
              <Button
                disabled={busy || working}
                onClick={() => void run(request, 'unchanged-only')}
              >
                Put back only the files that have not changed
              </Button>
              <Button disabled={busy || working} onClick={() => void run(request, 'copies')}>
                Save copies beside the files you have now
              </Button>
            </>
          ) : (
            <Button tone="primary" disabled={busy || working} onClick={() => void run(request)}>
              {request.kind === 'undo'
                ? 'Undo the restore'
                : request.kind === 'file'
                  ? 'Put this file back'
                  : request.savedVersion
                    ? 'Restore this version'
                    : `Put ${fileWord(request.paths.length)} back`}
            </Button>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <section className="hist" aria-label="History">
      <div className="hhead">
        <h1>History</h1>
        <span className="mono">
          {kept.length} recorded{page.length < kept.length ? ` · newest ${page.length}` : ''}
        </span>
        <div className="seg" role="radiogroup" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['saved', 'Saved versions'],
              ['diomedes', 'Diomedes'],
              ['you', 'You'],
            ] as [HistoryFilter, string][]
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={filter === value}
              className={filter === value ? 'on' : ''}
              onClick={() => setFilter(value)}
            >
              {text}
            </button>
          ))}
        </div>
        {/* A version is a marker a person puts down before they change something,
            so it belongs where they can see what is already recorded. */}
        <button
          type="button"
          className="verb light hsave"
          disabled={busy || working}
          onClick={() => setNaming('')}
        >
          Save a version
        </button>
      </div>
      {/* Always mounted, so what a restore did is a change inside a region the
          reader is already on rather than a new one appearing under them. */}
      <div className="hnote-slot" role="status">
        {note && (
          <div className="hnote">
            <span className={`pt ${note.tone}`} />
            <p>{note.text}</p>
            {note.undo && (
              <button
                type="button"
                className="verb"
                disabled={busy || working}
                onClick={() => {
                  const undo = note.undo;
                  if (undo) setAsk(undo);
                }}
              >
                Undo this restore
              </button>
            )}
            <button type="button" ref={hide} className="verb" onClick={() => setNote(null)}>
              Hide
            </button>
          </div>
        )}
      </div>
      {failure && (
        <div className="hnote fail">
          <span className="pt fail" />
          <p>{failure}</p>
        </div>
      )}
      <div className="hbody">
        {openId && !open ? (
          <div className="hentry">
            <button type="button" className="verb back" onClick={() => setOpenId(null)}>
              Back to the list
            </button>
            <p className="hquiet">That entry is no longer in this project.</p>
          </div>
        ) : open ? (
          entryView(open)
        ) : (
          list()
        )}
      </div>
      {ask && dialog(ask)}
      {naming !== null && (
        <Modal title="Save a version" onClose={() => setNaming(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveVersion(naming);
            }}
          >
            <p className="prose">
              This records every file in the project as it is right now, under a name you choose.
              Nothing is changed and nothing is sent anywhere. You can put the files back the way
              they are at this moment at any point after.
            </p>
            <label className="field">
              Name this version
              <input
                autoFocus
                value={naming}
                onChange={(event) => setNaming(event.target.value)}
                placeholder="Before the menu rewrite"
                maxLength={120}
                required
              />
            </label>
            <div className="dialog-actions">
              <Button onClick={() => setNaming(null)}>Cancel</Button>
              <Button type="submit" tone="primary" disabled={working || !naming.trim()}>
                Save this version
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
