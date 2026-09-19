import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentContent, DocumentInfo } from '../../shared/types';
import { readDocument } from '../api';
import { date, time } from '../components';
import type { FilesPaneProps } from './types';
import { ImportFiles } from './ImportFiles';
import {
  fileTreeKey,
  visibleFileNodes,
  visibleFocus,
  type FileNode as Node,
} from './file-tree-navigation';

/**
 * The Files pane: the Core file and artifact surface, bound to the current
 * Project. Imports use the existing recorded writer; previews are read-only.
 *
 * Every byte arrives through the existing guarded routes — `DocumentInfo` from
 * `GET /projects/:id/documents` and `DocumentContent` from `.../documents/read`
 * — so this pane creates no second file authority (decision 13). It is not
 * an editor: the pack tier owns code reading, editing,
 * Git and diffs, and none of that is here.
 *
 * Search lives in Ctrl+K, not in this pane (FIL-01).
 */

/** Smallest and largest the pane may be dragged to, in CSS pixels. */
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 640;
export const DEFAULT_WIDTH = 320;

export const clampWidth = (value: number): number =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));

type Folder = Extract<Node, { kind: 'folder' }>;

/**
 * A tree, derived in the client from the flat `/`-joined paths the listing
 * already returns. No tree endpoint, and no second listing.
 */
export function buildTree(documents: readonly DocumentInfo[]): Node[] {
  const roots: Node[] = [];
  const folders = new Map<string, Folder>();
  const folderAt = (path: string): Folder => {
    const found = folders.get(path);
    if (found) return found;
    const at = path.lastIndexOf('/');
    const folder: Folder = {
      kind: 'folder',
      path,
      name: at < 0 ? path : path.slice(at + 1),
      children: [],
    };
    folders.set(path, folder);
    (at < 0 ? roots : folderAt(path.slice(0, at)).children).push(folder);
    return folder;
  };
  for (const file of documents) {
    const at = file.path.lastIndexOf('/');
    const name = at < 0 ? file.path : file.path.slice(at + 1);
    const leaf: Node = { kind: 'file', path: file.path, name, document: file };
    (at < 0 ? roots : folderAt(file.path.slice(0, at)).children).push(leaf);
  }
  const order = (nodes: Node[]): Node[] => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
    );
    for (const node of nodes) if (node.kind === 'folder') order(node.children);
    return nodes;
  };
  return order(roots);
}

/** Every folder on the way to a path, so opening a file can reveal it. */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  const out: string[] = [];
  for (const part of parts) out.push(out.length ? `${out[out.length - 1]}/${part}` : part);
  return out;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function changedLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'not dated';
  return Date.now() - at < 24 * 60 * 60 * 1000 ? time(iso) : date(iso);
}

/** What the row says about a file beyond its name, or nothing at all. */
function marks(file: DocumentInfo): string[] {
  return [
    ...(file.hasChangesWaiting ? ['changes waiting'] : []),
    ...(file.recorded ? ['recorded'] : []),
  ];
}

/**
 * Markdown, at the grammar the app already reads: fenced code, three heading
 * levels, list lines and bold spans. No new dependency, and nothing is
 * interpreted that the raw view would not show.
 */
function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  let inCode = false;
  return (
    <div className="files-md">
      {lines.map((line, i) => {
        if (line.startsWith('```')) {
          inCode = !inCode;
          return <span key={i} />;
        }
        if (inCode)
          return (
            <pre className="files-code" key={i}>
              {line || ' '}
            </pre>
          );
        if (/^### /.test(line)) return <h4 key={i}>{line.slice(4)}</h4>;
        if (/^## /.test(line)) return <h3 key={i}>{line.slice(3)}</h3>;
        if (/^# /.test(line)) return <h3 key={i}>{line.slice(2)}</h3>;
        if (/^\s*([-*]|\d+\.) /.test(line))
          return (
            <div className="files-li" key={i}>
              <span>{line.match(/^\s*([-*]|\d+\.)/)?.[1]}</span>
              <span>{line.replace(/^\s*([-*]|\d+\.) /, '').replace(/\[ \] /, '')}</span>
            </div>
          );
        if (!line.trim()) return <div className="files-gap" key={i} />;
        return (
          <p key={i}>
            {line
              .split(/(\*\*.*?\*\*)/g)
              .map((part, j) =>
                part.startsWith('**') ? <strong key={j}>{part.slice(2, -2)}</strong> : part,
              )}
          </p>
        );
      })}
    </div>
  );
}

function FileTree({
  nodes,
  open,
  openPath,
  focusPath,
  restoreFocus,
  onFocus,
  onToggle,
  onOpen,
}: {
  nodes: Node[];
  open: ReadonlySet<string>;
  openPath: string | null;
  focusPath: string | null;
  restoreFocus: boolean;
  onFocus(path: string): void;
  onToggle(path: string): void;
  onOpen(path: string): void;
}) {
  const rows = useMemo(() => visibleFileNodes(nodes, open), [nodes, open]);
  const activePath = visibleFocus(rows, focusPath);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const treeRef = useRef<HTMLUListElement>(null);
  const hadFocus = useRef(false);
  const restoreOnMount = useRef(restoreFocus);
  useEffect(() => {
    // Refreshes can remove the focused file. Restore only when focus belonged
    // to the tree or Back requested it, never while the person is elsewhere.
    if (
      activePath &&
      (restoreOnMount.current || (hadFocus.current && document.activeElement === document.body))
    )
      buttons.current.get(activePath)?.focus();
    restoreOnMount.current = false;
  }, [activePath]);
  return (
    <ul
      className="files-tree"
      role="tree"
      aria-label="Project files"
      ref={treeRef}
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !treeRef.current?.contains(event.relatedTarget))
          hadFocus.current = false;
      }}
    >
      {rows.map(({ node, depth, position, size }) => (
        <li key={node.path} role="none">
          <button
            type="button"
            role="treeitem"
            ref={(element) => {
              if (element) buttons.current.set(node.path, element);
              else buttons.current.delete(node.path);
            }}
            tabIndex={node.path === activePath ? 0 : -1}
            aria-label={node.name}
            aria-description={
              node.kind === 'file' ? marks(node.document).join(', ') || undefined : undefined
            }
            aria-level={depth + 1}
            aria-posinset={position}
            aria-setsize={size}
            aria-expanded={node.kind === 'folder' ? open.has(node.path) : undefined}
            aria-selected={node.path === openPath}
            title={node.path}
            className={`files-row files-${node.kind}${node.path === openPath ? ' on' : ''}`}
            // Deep folders retain their full ARIA level and path, while
            // indentation leaves room for names at the existing pane minimum.
            style={{ paddingLeft: 10 + Math.min(depth, 4) * 12 }}
            onFocus={() => onFocus(node.path)}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              if (
                !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                  event.key,
                )
              )
                return;
              const action = fileTreeKey(rows, open, node.path, event.key);
              event.preventDefault();
              event.stopPropagation();
              if (!action) return;
              if (action.kind === 'focus') buttons.current.get(action.path)?.focus();
              else onToggle(action.path);
            }}
            onClick={() => {
              buttons.current.get(node.path)?.focus();
              if (node.kind === 'folder') onToggle(node.path);
              else onOpen(node.path);
            }}
          >
            {node.kind === 'folder' ? (
              <span className="files-caret" aria-hidden="true">
                {open.has(node.path) ? '−' : '+'}
              </span>
            ) : (
              <span
                className={`pt ${node.document.hasChangesWaiting ? 'attn' : node.document.recorded ? 'done' : ''}`.trimEnd()}
              />
            )}
            <span className="files-name">{node.name}</span>
            <span className="mono files-meta">
              {node.kind === 'folder'
                ? node.children.length
                : changedLabel(node.document.changedAt)}
            </span>
            {node.kind === 'file' && marks(node.document).length > 0 && (
              <small className="files-marks">{marks(node.document).join(' · ')}</small>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Viewer({
  projectId,
  document: info,
  onBack,
  onEdit,
}: {
  projectId: string;
  document: DocumentInfo;
  onBack(): void;
  /** Write in this file. Offered only for the kinds the editor can open. */
  onEdit?(path: string): void;
}) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  const readable = info.kind !== 'unsupported';
  useEffect(() => {
    back.current?.focus();
  }, []);
  useEffect(() => {
    if (!readable) return;
    let alive = true;
    const controller = new AbortController();
    setContent(null);
    setFailure(null);
    readDocument(projectId, info.path, controller.signal)
      .then((value) => {
        if (alive) setContent(value);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setFailure(e instanceof Error ? e.message : 'This document could not be read.');
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [projectId, info.path, readable, attempt]);
  const rendered = info.kind === 'markdown' || info.kind === 'plan';
  return (
    <div className="files-doc">
      <div className="files-doc-head">
        <button ref={back} type="button" className="files-back" onClick={onBack}>
          Back
        </button>
        <span className="files-path mono" title={info.path}>
          {info.path}
        </span>
      </div>
      <div className="files-doc-bar">
        <span className="mono files-meta">
          {info.kind} · {sizeLabel(info.size)} · {changedLabel(info.changedAt)}
        </span>
        {rendered && readable && (
          <span className="files-seg">
            <button
              type="button"
              className={raw ? '' : 'on'}
              aria-pressed={!raw}
              onClick={() => setRaw(false)}
            >
              Rendered
            </button>
            <button
              type="button"
              className={raw ? 'on' : ''}
              aria-pressed={raw}
              onClick={() => setRaw(true)}
            >
              Raw
            </button>
          </span>
        )}
        {/* This pane stays a reader (decision 13, and the note at the top of
            this file). Writing happens in the editor on the main stage, which
            is a different surface reached from here, not one grown inside the
            pane. */}
        {onEdit && readable && (
          <button type="button" className="files-edit" onClick={() => onEdit(info.path)}>
            Write in this file
          </button>
        )}
      </div>
      {marks(info).length > 0 && <p className="caption">{marks(info).join(' · ')}</p>}
      {/* The head and the bar already carry the path, kind, size and changed
          time, so the metadata is not repeated here (decision 4); what is left
          to say is where this file can be opened. */}
      {!readable && (
        <p className="caption files-external">
          Open in the app that owns it — this window has no hand-off to the desktop shell, so
          Diomedes cannot start it for you.
        </p>
      )}
      {readable && failure && (
        <div className="files-read-failure">
          <p className="caption files-fail" role="alert">
            {failure}
          </p>
          <button
            type="button"
            className="files-retry"
            onClick={() => {
              setFailure(null);
              setContent(null);
              setAttempt((value) => value + 1);
              back.current?.focus();
            }}
          >
            Retry preview
          </button>
        </div>
      )}
      {readable && !failure && !content && (
        <p className="caption" role="status">
          Reading...
        </p>
      )}
      {readable && content && content.outsideChange && (
        <p className="caption">{content.outsideChange.sentence}</p>
      )}
      {readable &&
        content &&
        (rendered && !raw ? (
          <Markdown text={content.text} />
        ) : (
          <pre className="files-raw">{content.text}</pre>
        ))}
    </div>
  );
}

export function FilesPane(props: FilesPaneProps) {
  // Expansion, focus and pending reads all belong to one project, even when
  // two projects contain the same relative path.
  return <ProjectFilesPane key={props.projectId} {...props} />;
}

function ProjectFilesPane({
  projectId,
  documents,
  loading,
  failure,
  openPath,
  width,
  onOpen,
  onWidth,
  onClose,
  onEdit,
}: FilesPaneProps) {
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const restoreFocus = useRef(false);
  const dragFrom = useRef<{ x: number; width: number } | null>(null);
  const tree = useMemo(() => buildTree(documents), [documents]);
  const openDocument = openPath ? (documents.find((d) => d.path === openPath) ?? null) : null;

  // Opening a document from the palette reveals the folders it sits in, so
  // closing it lands on the row rather than a collapsed tree.
  useEffect(() => {
    if (!openPath) return;
    setFocusPath(openPath);
    const reveal = ancestors(openPath);
    if (!reveal.length) return;
    setExpanded((prev) => {
      if (reveal.every((path) => prev.has(path))) return prev;
      const next = new Set(prev);
      for (const path of reveal) next.add(path);
      return next;
    });
  }, [openPath]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const onGripDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onGripMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    onWidth(clampWidth(from.width + (from.x - event.clientX)));
  };
  const onGripUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <aside className="files" aria-label="Files" style={{ width }}>
      <div
        className="files-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the Files pane"
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onWidth(clampWidth(width + 16));
          if (e.key === 'ArrowRight') onWidth(clampWidth(width - 16));
        }}
      />
      <div className="files-head">
        <h2>Files</h2>
        <button type="button" className="files-close" onClick={onClose}>
          Hide
        </button>
      </div>
      <div className="files-body">
        <button type="button" className="files-import" onClick={() => setImporting(true)}>
          Import files
        </button>
        {failure && <p className="caption files-fail">{failure}</p>}
        {!failure && loading && !documents.length && (
          <p className="caption">Reading the folder...</p>
        )}
        {!failure && !loading && !documents.length && (
          <p className="caption">This project's folder has nothing to list.</p>
        )}
        {openDocument ? (
          // A fresh viewer per document: the Rendered/Raw choice belongs to the
          // document being read, not to the pane.
          <Viewer
            key={JSON.stringify([projectId, openDocument.path])}
            projectId={projectId}
            document={openDocument}
            onBack={() => {
              restoreFocus.current = true;
              onOpen(null);
            }}
            onEdit={onEdit}
          />
        ) : (
          documents.length > 0 && (
            <FileTree
              nodes={tree}
              open={expanded}
              openPath={openPath}
              focusPath={focusPath}
              restoreFocus={restoreFocus.current}
              onFocus={(path) => {
                restoreFocus.current = false;
                setFocusPath(path);
              }}
              onToggle={toggle}
              onOpen={onOpen}
            />
          )
        )}
      </div>
      {importing && (
        <ImportFiles
          key={projectId}
          projectId={projectId}
          onClose={() => setImporting(false)}
          onImported={(paths) => {
            setImporting(false);
            onOpen(paths[0] ?? null);
          }}
        />
      )}
    </aside>
  );
}
