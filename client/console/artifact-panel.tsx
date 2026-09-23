import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Session } from '../../shared/types';
import { ArtifactPane } from './ArtifactPane';
import type { SaveOutcome } from './artifact-save';
import { clampArtifactWidth, remember, stored, storedArtifactWidth, viewportWidth } from './artifact-width';
import { indexArtifacts, indexFile, type ArtifactIndex, type ArtifactRecord, type TurnLike } from './artifacts';
import type { Board } from './board-model';
import { BoardPane, ProgressBoard } from './ProgressBoard';

// Which artifact the panel shows, and where the panel sits. The selection is
// UI state only: every record it points at is derived from a durable turn (or
// a file the person opened), so nothing here is a second copy of the record.

const NO_TURNS: readonly TurnLike[] = [];

const LIVE: ReadonlySet<Session['state']> = new Set(['queued', 'working', 'waiting']);

/**
 * The run a thread's run-status card reads: its own queued, working or waiting
 * session, or its task's when the session names no thread. The same one
 * ThreadView hands a turn's inline card (its `live`), so a card opened in the
 * panel shows what the card in the turn shows.
 */
export function threadRun(
  sessions: readonly Session[] | null | undefined,
  thread: { id: string; taskId?: string | null } | null | undefined,
): Session | null {
  if (!thread || !sessions) return null;
  return (
    sessions.find(
      (session) =>
        (session.threadId ? session.threadId === thread.id : !!thread.taskId && session.taskId === thread.taskId) &&
        LIVE.has(session.state),
    ) ?? null
  );
}

interface Opened {
  /** The conversation the key was read from, when it came from one. */
  scope: string | null;
  /** A file's own artifacts, when the person opened them from Files. */
  file: ArtifactIndex | null;
  key: string;
  /** True when this artifact switched in by itself because a new turn brought it. */
  arrived: boolean;
}

export interface ArtifactSelection {
  /** Every artifact in the conversation's durable turns. */
  index: ArtifactIndex;
  /** What the panel shows, or null when it shows nothing. */
  record: ArtifactRecord | null;
  /** The index the shown record belongs to: the conversation's, or a file's. */
  source: ArtifactIndex;
  arrived: boolean;
  /** Changes each time a person opens an artifact, so the panel can take focus. */
  focusToken: number;
  /** A chip's key when its artifact is the one showing. */
  openKey: string | null;
  open(record: ArtifactRecord, from?: ArtifactIndex): void;
  /** Another version of the artifact showing. Focus stays where it is. */
  select(record: ArtifactRecord): void;
  close(): void;
}

/**
 * The panel's selection for one conversation. `reset` is what the selection
 * belongs to beyond the conversation (the project): when it changes, the panel
 * closes. Changing the conversation closes a conversation's artifact too,
 * because its chip is no longer on screen; a file's stays open.
 *
 * When the panel is showing this conversation's artifact and a later durable
 * turn brings a new one, the panel switches to the newest and says so. The
 * first read of a conversation only learns what is already there.
 */
export function useArtifactSelection(
  reset: string | null,
  scope: string | null,
  turns: readonly TurnLike[] | null | undefined,
): ArtifactSelection {
  const list = turns ?? NO_TURNS;
  const index = useMemo(() => indexArtifacts(scope ?? '', list), [scope, list]);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const known = useRef<{ scope: string | null; keys: Set<string> } | null>(null);

  useEffect(() => {
    setOpened(null);
  }, [reset]);

  useEffect(() => {
    const keys = new Set(index.list.map((record) => record.key));
    const before = known.current;
    known.current = { scope, keys };
    if (!before || before.scope !== scope) {
      // A different conversation: learn what it holds, and let go of the last one's artifact.
      setOpened((current) => (current && !current.file ? null : current));
      return;
    }
    const fresh = index.list.filter((record) => !before.keys.has(record.key));
    const newest = fresh[fresh.length - 1];
    if (!newest) return;
    setOpened((current) =>
      current && !current.file && current.scope === scope
        ? { scope, file: null, key: newest.key, arrived: true }
        : current,
    );
  }, [index, scope]);

  const source = opened?.file ?? index;
  const record =
    opened && (opened.file || opened.scope === scope) ? (source.byKey.get(opened.key) ?? null) : null;

  return {
    index,
    record,
    source,
    arrived: !!record && !!opened?.arrived,
    focusToken,
    openKey: record && !opened?.file ? record.key : null,
    open(next, from) {
      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement)
        opener.current = document.activeElement;
      setOpened({ scope: from ? null : scope, file: from ?? null, key: next.key, arrived: false });
      setFocusToken((value) => value + 1);
    },
    select(next) {
      setOpened((current) => (current ? { ...current, key: next.key, arrived: false } : current));
    },
    close() {
      setOpened(null);
      const back = opener.current;
      opener.current = null;
      if (back && back.isConnected) back.focus();
    },
  };
}

/** The artifact view's width, remembered per person under `console.artifacts.width`. */
export function useArtifactWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(storedArtifactWidth);
  useEffect(() => {
    remember('console.artifacts.width', String(width));
  }, [width]);
  return [width, (next) => setWidth(clampArtifactWidth(next, viewportWidth()))];
}

/**
 * The column's two views: Files, and the panel, which holds an open artifact or, when none is
 * open, the thread's progress board.
 */
export type PaneView = 'files' | 'artifact';

/** Where the stage has a third column (artifacts.css): narrower, the panel overlays the page. */
const WIDE_STAGE = '(min-width: 861px)';

/** Whether the stage has room for the column beside the thread. True where nothing can say. */
function useWideStage(): boolean {
  const query = () =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? null : window.matchMedia(WIDE_STAGE);
  const [wide, setWide] = useState(() => query()?.matches ?? true);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

export interface ArtifactHost {
  selection: ArtifactSelection;
  /** Which view the third column shows, or null when it is closed. */
  shown: PaneView | null;
  /** The stage's class suffix and track width while the column is open. */
  stageClass: string;
  stageStyle: CSSProperties | undefined;
  /** The Files | Artifact (or Files | Progress) switch, for a view's head while both are open; null otherwise. */
  switcher: ReactNode;
  /** The panel's view, an artifact or the progress board, ready for the stage's third column, or null. */
  pane: ReactNode;
  /** The rail's Files item: shows Files when it is behind an artifact, and otherwise toggles it. */
  toggleFiles(): void;
  /** A document was opened: Files comes to the front. */
  showFiles(): void;
  /** "Open in panel" from the Files viewer: the file's first artifact. */
  openFile(path: string, text: string): void;
}

/**
 * The Console stage's third column, hosting two views: the Files pane and the
 * artifact panel. Each keeps its own state while the other is in front (the
 * one behind is `hidden`, not unmounted), and each remembers its own width.
 * Which view was in front is remembered under `console.pane.view`
 * (localStorage, like `console.files.*`: Settings rejects keys it does not know).
 *
 * With no artifact open, the panel holds the thread's progress board while its
 * work is still moving (board-model.ts), where the stage has room for it: it
 * opens by itself, takes no focus, and Close puts it away until the board
 * counts different tasks (remembered under `console.board.closed`). An open
 * artifact carries the board compactly under its head.
 */
export function useArtifactHost(input: {
  reset: string | null;
  scope: string | null;
  turns: readonly TurnLike[] | null | undefined;
  filesOpen: boolean;
  setFilesOpen(open: boolean): void;
  filesWidth: number;
  onSave?(record: ArtifactRecord): Promise<SaveOutcome>;
  onShowFile?(path: string): void;
  /** The conversation's live run, for a visual's run-status card in the panel (`threadRun`). */
  session?: Session | null;
  /** The thread's progress board (`boardFor`), or null when nothing on record is still moving. */
  board?: Board | null;
  /** The board view's title: the thread's name. */
  boardTitle?: string;
}): ArtifactHost {
  const { filesOpen, setFilesOpen, filesWidth } = input;
  const selection = useArtifactSelection(input.reset, input.scope, input.turns);
  const [width, setWidth] = useArtifactWidth();
  const [view, setView] = useState<PaneView>(() =>
    stored('console.pane.view') === 'files' ? 'files' : 'artifact',
  );
  useEffect(() => {
    remember('console.pane.view', view);
  }, [view]);
  // Opening an artifact brings its view to the front.
  useEffect(() => {
    if (selection.focusToken) setView('artifact');
  }, [selection.focusToken]);
  const wide = useWideStage();
  const [closedBoard, setClosedBoard] = useState(() => stored('console.board.closed'));
  const board = input.board && input.board.key !== closedBoard ? input.board : null;
  const closeBoard = (key: string) => {
    setClosedBoard(key);
    remember('console.board.closed', key);
  };

  const record = selection.record;
  // What the panel holds: an open artifact, or else the board, only beside the thread.
  const holds: 'artifact' | 'board' | null = record ? 'artifact' : board && wide ? 'board' : null;
  const shown: PaneView | null = holds && filesOpen ? view : holds ? 'artifact' : filesOpen ? 'files' : null;
  const switcher =
    holds && filesOpen ? (
      <div className="art-switch" role="group" aria-label="Panel">
        <button type="button" aria-pressed={shown === 'files'} onClick={() => setView('files')}>
          Files
        </button>
        <button type="button" aria-pressed={shown === 'artifact'} onClick={() => setView('artifact')}>
          {holds === 'board' ? 'Progress' : 'Artifact'}
        </button>
      </div>
    ) : null;

  return {
    selection,
    shown,
    stageClass: shown ? ' files-open' : '',
    stageStyle:
      shown === 'files'
        ? ({ '--files-w': `${filesWidth}px` } as CSSProperties)
        : shown === 'artifact'
          ? ({ '--files-w': `min(${width}px, 60vw)` } as CSSProperties)
          : undefined,
    switcher,
    pane: record ? (
      <ArtifactPane
        record={record}
        index={selection.source}
        arrived={selection.arrived}
        focusToken={selection.focusToken}
        width={width}
        onWidth={setWidth}
        onSelect={selection.select}
        onClose={selection.close}
        hidden={shown !== 'artifact'}
        switcher={switcher}
        onSave={input.onSave}
        onShowFile={input.onShowFile}
        session={input.session ?? null}
        board={board ? <ProgressBoard board={board} compact /> : null}
      />
    ) : holds === 'board' && board ? (
      <BoardPane
        board={board}
        title={input.boardTitle || 'This thread'}
        width={width}
        onWidth={setWidth}
        onClose={() => closeBoard(board.key)}
        hidden={shown !== 'artifact'}
        switcher={switcher}
      />
    ) : null,
    toggleFiles() {
      if (filesOpen && shown === 'files') setFilesOpen(false);
      else {
        setFilesOpen(true);
        setView('files');
      }
    },
    showFiles() {
      setView('files');
    },
    openFile(path, text) {
      const found = indexFile(path, text);
      const first = found.list[0];
      if (first) selection.open(first, found);
    },
  };
}
