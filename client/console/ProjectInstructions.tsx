import { useState } from 'react';
import { api } from '../api';
import {
  compareInstructionPrecedence,
  instructionScope,
  type InstructionDelivery,
  type InstructionExclusion,
  type InstructionFileRecord,
} from '../../shared/capability-packs';
import type { DocumentContent } from '../../shared/types';

/**
 * One line in the thread head saying which repository instruction files this
 * project is working under, and a panel that inspects them.
 *
 * Three properties from `capability-packs.md` §4.1 and H11 are the whole
 * component:
 *
 * - **It is an indication, not a narration.** One line, on the surface where
 *   work happens, and no caption underneath restating it (`AGENTS.md`
 *   decision 4). The state word is the only thing that changes: files that
 *   were found but produced no rule say `found`, not `loaded`.
 * - **Discovery is not obedience-in-secret.** Every record discovery made is
 *   listed here, including the ones the path guard refused and the ones too
 *   large for the instruction view, and each readable one can be opened and
 *   read exactly as Diomedes read it, or opened in Files.
 * - **What a run used is read from the run's own record.** When this thread
 *   has run with instructions, the panel lists that session's delivery record
 *   in precedence order: each file's folder, sha, size and whether it went,
 *   and for every file that did not, the recorded reason. Nothing here
 *   re-derives what was sent from the folder as it is now.
 *
 * The body is fetched from the instruction read route, which serves only paths
 * discovery already recorded. Nothing here sends a file to a model.
 */
const kb = (size: number | null | undefined) =>
  size === null || size === undefined
    ? ''
    : size === 0
      ? '0 KB'
      : `${Math.max(1, Math.round(size / 1024))} KB`;

const EXCLUSION: Record<InstructionExclusion, string> = {
  'over-file-limit': 'left out whole · over the file limit',
  'no-room': 'left out whole · no room left',
  refused: 'refused',
  missing: 'missing',
  'out-of-scope': 'out of scope',
  'not-shared': 'not shared',
  'not-loaded': 'not loaded',
};

/** The folder a file governs, as a person reads it. */
const scopeLabel = (scope: string) => scope || 'project root';

interface Row {
  readonly path: string;
  readonly scope: string;
  readonly precedence: number | null;
  readonly status: string;
  readonly bytes: number | null;
  readonly sha: string | null;
  /** Said only when it adds something the status word does not. */
  readonly detail: string | null;
  readonly readable: boolean;
}

function deliveryRows(
  delivery: InstructionDelivery,
  files: readonly InstructionFileRecord[],
): Row[] {
  const readable = (path: string) =>
    files.some((record) => record.path === path && record.state !== 'unreadable');
  const sent: Row[] = delivery.files.map((file, index) => ({
    path: file.path,
    scope: file.scope ?? instructionScope(file.path),
    precedence: file.precedence ?? index + 1,
    status: file.state === 'sent' ? 'sent' : EXCLUSION[file.exclusion ?? 'no-room'],
    bytes: file.bytes,
    sha: file.sha,
    detail: file.detail === 'Sent whole.' ? null : file.detail,
    // A file this run sent stays readable after its pack is turned off: the
    // read route serves every recorded path, and what was applied must stay
    // inspectable (decision 14).
    readable:
      file.state === 'sent' ||
      (readable(file.path) && file.exclusion !== 'refused' && file.exclusion !== 'missing'),
  }));
  const excluded: Row[] = (delivery.excluded ?? []).map((file) => ({
    path: file.path,
    scope: file.scope,
    precedence: null,
    status: EXCLUSION[file.exclusion],
    bytes: file.bytes,
    sha: file.sha,
    detail: file.detail,
    readable: readable(file.path),
  }));
  return [...sent, ...excluded];
}

function discoveryRows(files: readonly InstructionFileRecord[]): Row[] {
  return [...files]
    .sort((a, b) => compareInstructionPrecedence(a.path, b.path))
    .map((file) => ({
      path: file.path,
      scope: instructionScope(file.path),
      precedence: null,
      status: file.state,
      bytes: file.size,
      sha: file.sha,
      detail: file.detail,
      readable: file.state !== 'unreadable',
    }));
}

export function ProjectInstructions({
  projectId,
  files,
  delivery = null,
  onOpenInFiles,
}: {
  projectId: string;
  files: readonly InstructionFileRecord[];
  /** The newest delivery record among this thread's sessions, when it has one. */
  delivery?: InstructionDelivery | null;
  onOpenInFiles?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [error, setError] = useState('');

  // A thread whose run was sent instructions keeps this line even when
  // nothing is loaded now (the pack was turned off, or the files were
  // removed): what was applied is never left where it cannot be inspected.
  if (!files.length && !delivery?.files.some((file) => file.state === 'sent')) return null;
  const loaded = files
    .filter((file) => file.state === 'loaded')
    .sort((a, b) => compareInstructionPrecedence(a.path, b.path));
  const named = (
    loaded.length
      ? loaded
      : files.length
        ? files
        : (delivery?.files ?? []).filter((file) => file.state === 'sent')
  )
    .map((file) => file.path)
    .join(' · ');
  const lead = loaded.length ? 'loaded' : files.length ? 'found' : 'last sent';

  // The run's record first; anything discovery has found since that run
  // follows it, so a file is never missing from the panel for being new.
  const recorded = delivery ? deliveryRows(delivery, files) : [];
  const later = discoveryRows(files).filter(
    (row) => !recorded.some((item) => item.path === row.path),
  );
  const sent = delivery?.files.filter((file) => file.state === 'sent').length ?? 0;

  async function read(path: string) {
    if (shown === path) {
      setShown(null);
      setContent(null);
      return;
    }
    setShown(path);
    setContent(null);
    setError('');
    try {
      setContent(
        await api<DocumentContent>(
          `/projects/${projectId}/instructions/read?path=${encodeURIComponent(path)}`,
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This file could not be opened.');
    }
  }

  const row = (item: Row, ranked: boolean) => (
    <li className="instructions-file" key={item.path} data-path={item.path}>
      <div className="instructions-file-head">
        {ranked && (
          <span
            className="mono lc instructions-rank"
            title={item.precedence === null ? 'Did not take part in the run' : 'Precedence; 1 governs'}
          >
            {item.precedence ?? '–'}
          </span>
        )}
        {item.readable ? (
          <button
            type="button"
            className="instructions-name"
            aria-expanded={shown === item.path}
            title={item.path}
            onClick={() => void read(item.path)}
          >
            {item.path}
          </button>
        ) : (
          <span className="instructions-name" title={item.path}>
            {item.path}
          </span>
        )}
        <span className="mono lc instructions-meta">
          {item.status}
          {` · ${scopeLabel(item.scope)}`}
          {item.bytes === null ? '' : ` · ${kb(item.bytes)}`}
          {item.sha ? ` · ${item.sha.slice(0, 12)}` : ''}
        </span>
        {item.readable && onOpenInFiles && (
          <button
            type="button"
            className="instructions-open"
            onClick={() => onOpenInFiles(item.path)}
          >
            Open in Files
          </button>
        )}
      </div>
      {item.detail && <p>{item.detail}</p>}
      {shown === item.path && (error || content) && (
        <pre className="instructions-body">{error || content?.text}</pre>
      )}
    </li>
  );

  return (
    <div className="instructions">
      <button
        type="button"
        className="instructions-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={named}
      >
        <span className="instructions-lead">
          Project instructions {lead} ·
        </span>{' '}
        <span>{named}</span>
      </button>
      {open && (
        <div className="instructions-panel">
          {delivery && (
            <section className="instructions-run" aria-label="Last run">
              <div className="mono lc instructions-run-head">
                last run · {delivery.routeId} · {sent} sent · {kb(delivery.bytes)}
              </div>
              <ol className="instructions-list">{recorded.map((item) => row(item, true))}</ol>
            </section>
          )}
          {later.length > 0 && (
            <section className="instructions-run" aria-label="Discovered">
              {delivery && <div className="mono lc instructions-run-head">found since</div>}
              <ol className="instructions-list">{later.map((item) => row(item, false))}</ol>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
