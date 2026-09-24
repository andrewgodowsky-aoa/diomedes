import { useEffect, useMemo, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';
import { delimiterFor, parseDelimited, TABLE_PAGE_ROWS } from '../../shared/delimited';
import { IMAGE_KINDS } from '../../shared/file-drops';
import { identityLabel, versionsOf, type FileIdentity } from '../../shared/file-identity';
import { date, time } from '../components';
import {
  documentFacts,
  documentVersion,
  pictureUrl,
  workbookSheet,
  type DocumentFacts,
  type DocumentVersion,
  type WorkbookPage,
} from './file-drops-api';
import { VersionCompare } from './VersionCompare';

/**
 * Read-only previews for the Files pane: a picture, a PDF's facts, a workbook's
 * facts, CSV/TSV as a table, and an older version opened by identity.
 *
 * Every preview is decided by the bytes the local service sniffed, never by
 * the name alone, and each says plainly when it cannot show a file. Nothing
 * here writes a file, and nothing here is an editor (decision 13); a review
 * comment on a version (VersionCompare) is the one record it can add.
 */

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Where to open a file this window cannot show. Said once, where the preview would be. */
const NO_HANDOFF =
  'This window has no hand-off to the desktop shell, so open it from the project folder in the app that owns it.';

function useFacts(projectId: string, path: string, sha?: string | null) {
  const [facts, setFacts] = useState<DocumentFacts | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setFacts(null);
    setFailure(null);
    documentFacts(projectId, path, sha, controller.signal)
      .then(setFacts)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : 'Files could not read this file.');
      });
    return () => controller.abort();
  }, [projectId, path, sha]);
  return { facts, failure };
}

/** The identity line: which exact bytes are on screen. */
export function IdentityLine({ identity, current }: { identity: FileIdentity; current: boolean }) {
  return (
    <p className="caption files-identity mono" title={identity.sha}>
      {identityLabel(identity)}
      {current ? '' : ' · older version from History'}
    </p>
  );
}

/**
 * A picture, served by the local service only when its bytes are a PNG, JPEG,
 * GIF or WebP small enough to decode, into an `<img>` that runs nothing.
 */
export function PicturePreview({ projectId, path, sha }: { projectId: string; path: string; sha?: string | null }) {
  const { facts, failure } = useFacts(projectId, path, sha);
  const [broken, setBroken] = useState(false);
  if (failure) return <p className="caption files-fail" role="alert">{failure}</p>;
  if (!facts) return <p className="caption" role="status">Reading...</p>;
  const picture = facts.kind !== null && IMAGE_KINDS.includes(facts.kind);
  return (
    <div className="files-preview">
      <IdentityLine identity={facts.identity} current={facts.current} />
      {!picture ? (
        <p className="caption">
          This file is named as a picture but its contents are not a PNG, JPEG, GIF or WebP, so Files does not show it.
        </p>
      ) : !facts.picture?.previewable ? (
        <p className="caption">
          {facts.picture?.width}×{facts.picture?.height} pixels is too large for Files to show. {NO_HANDOFF}
        </p>
      ) : broken ? (
        <p className="caption">This picture could not be drawn. {NO_HANDOFF}</p>
      ) : (
        <figure className="files-picture">
          <img
            src={pictureUrl(projectId, path, facts.identity.sha)}
            alt={path.slice(path.lastIndexOf('/') + 1)}
            onError={() => setBroken(true)}
          />
          <figcaption className="caption mono">
            {facts.kind?.toUpperCase()} · {facts.picture.width}×{facts.picture.height} · {size(facts.bytes)}
          </figcaption>
        </figure>
      )}
    </div>
  );
}

/** A PDF or workbook: what the bytes say, and the truth about where to read it. */
export function DocumentFactsPreview({
  projectId,
  path,
  sha,
  expect,
}: {
  projectId: string;
  path: string;
  sha?: string | null;
  expect: 'pdf' | 'xlsx';
}) {
  const { facts, failure } = useFacts(projectId, path, sha);
  if (failure) return <p className="caption files-fail" role="alert">{failure}</p>;
  if (!facts) return <p className="caption" role="status">Reading...</p>;
  if (facts.kind !== expect)
    return (
      <div className="files-preview">
        <IdentityLine identity={facts.identity} current={facts.current} />
        <p className="caption">
          This file is named as {expect === 'pdf' ? 'a PDF' : 'an XLSX workbook'} but its contents are not one, so
          Files does not describe it.
        </p>
      </div>
    );
  return (
    <div className="files-preview">
      <IdentityLine identity={facts.identity} current={facts.current} />
      <dl className="files-facts">
        <dt>Kind</dt>
        <dd>{expect === 'pdf' ? `PDF${facts.pdf?.version ? ` ${facts.pdf.version}` : ''}` : 'XLSX workbook'}</dd>
        <dt>Size</dt>
        <dd>{size(facts.bytes)}</dd>
        {facts.pdf?.encrypted && (
          <>
            <dt>Protection</dt>
            <dd>Encrypted</dd>
          </>
        )}
      </dl>
      {expect === 'pdf' ? (
        <p className="caption">Files has no in-app PDF viewer in this build. {NO_HANDOFF}</p>
      ) : (
        <WorkbookPreview projectId={projectId} path={path} sha={facts.identity.sha} />
      )}
    </div>
  );
}

/**
 * A workbook's first sheet, a page of rows at a time, read by the local
 * service from the saved values. Nothing is recalculated.
 */
function WorkbookPreview({ projectId, path, sha }: { projectId: string; path: string; sha: string }) {
  const [page, setPage] = useState(0);
  const [sheet, setSheet] = useState<WorkbookPage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    workbookSheet(projectId, path, sha, page * TABLE_PAGE_ROWS, controller.signal)
      .then(setSheet)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : 'Files could not read this workbook.');
      });
    return () => controller.abort();
  }, [projectId, path, sha, page]);
  if (failure) return <p className="caption">{failure} {NO_HANDOFF}</p>;
  if (!sheet) return <p className="caption" role="status">Reading...</p>;
  return (
    <>
      <p className="caption">
        The first sheet, {sheet.sheet}
        {sheet.sheets.length > 1 ? `, of ${sheet.sheets.length} sheets` : ''}. Values are shown as the
        workbook saved them: formulas are not recalculated and dates are serial numbers.
      </p>
      <RowsTable
        rows={sheet.rows}
        total={sheet.total}
        columns={sheet.columns}
        clipped={sheet.clipped}
        page={page}
        onPage={setPage}
        header={false}
      />
    </>
  );
}

/** One page of rows, with its count and pager. Cells are text only. */
function RowsTable({
  rows,
  total,
  columns,
  clipped,
  unterminated = false,
  page,
  onPage,
  header,
}: {
  rows: string[][];
  total: number;
  columns: number;
  clipped: boolean;
  unterminated?: boolean;
  page: number;
  onPage(page: number): void;
  /** Whether the file's first row names the columns. */
  header: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / TABLE_PAGE_ROWS));
  const first = page * TABLE_PAGE_ROWS;
  const [head, ...rest] = header && page === 0 ? rows : [null, ...rows];
  return (
    <div className="files-table-wrap">
      <p className="caption mono" role="status">
        {total === 0
          ? 'No rows'
          : `Rows ${first + 1}–${first + rows.length} of ${total} · ${columns} ${columns === 1 ? 'column' : 'columns'}`}
      </p>
      {clipped && <p className="caption">Columns past the 50th are not shown.</p>}
      {unterminated && (
        <p className="caption">A quote is never closed, so the last rows may be joined; Raw shows the text as written.</p>
      )}
      <div className="files-table-scroll">
        <table className="files-table">
          {head && (
            <thead>
              <tr>
                {head.map((cell, i) => (
                  <th key={i} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rest.map((row, r) => (
              <tr key={r}>
                {row!.map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="files-pager">
          <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}>
            Previous rows
          </button>
          <span className="mono">
            {page + 1} / {pages}
          </span>
          <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
            Next rows
          </button>
        </div>
      )}
    </div>
  );
}

/** CSV or TSV as a table, a page of rows at a time. Cells are exactly the text between delimiters. */
export function TablePreview({ name, text }: { name: string; text: string }) {
  const [page, setPage] = useState(0);
  const table = useMemo(
    () => parseDelimited(text, delimiterFor(name), { offset: page * TABLE_PAGE_ROWS }),
    [text, name, page],
  );
  return (
    <RowsTable
      rows={table.rows}
      total={table.total}
      columns={table.columns}
      clipped={table.clipped}
      unterminated={table.unterminated}
      page={page}
      onPage={setPage}
      header
    />
  );
}

/** The versions History holds for a file, newest first, each one openable. */
export function VersionList({
  history,
  path,
  currentSha,
  onOpenVersion,
}: {
  history: readonly HistoryEntry[];
  path: string;
  currentSha: string | null;
  onOpenVersion(identity: { path: string; sha: string }): void;
}) {
  const versions = useMemo(() => versionsOf(history, path), [history, path]);
  if (versions.length < 2 && (!versions[0] || versions[0].sha === currentSha)) return null;
  return (
    <details className="files-versions">
      <summary>Versions ({versions.length})</summary>
      <ul>
        {versions.map((version) => (
          <li key={version.sha}>
            <button
              type="button"
              className="files-version"
              disabled={version.sha === currentSha}
              onClick={() => onOpenVersion({ path, sha: version.sha })}
            >
              <span className="mono">{identityLabel(version)}</span>
              <span className="files-version-when">
                {version.sha === currentSha ? 'current' : `${date(version.time)} ${time(version.time)}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * One exact version, opened by `{ path, sha }` — from a Thread reference or the
 * version list. Text is shown raw; a picture through the picture route with
 * the same identity. A version History no longer holds says so.
 */
export function VersionView({
  projectId,
  path,
  sha,
  onBack,
  onOpenCurrent,
  history,
}: {
  projectId: string;
  path: string;
  sha: string;
  onBack(): void;
  onOpenCurrent?(): void;
  /** P06: History, so the version can be compared with the one before it. */
  history?: readonly HistoryEntry[];
}) {
  const [version, setVersion] = useState<DocumentVersion | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setVersion(null);
    setFailure(null);
    documentVersion(projectId, path, sha, controller.signal)
      .then(setVersion)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : 'This version could not be read.');
      });
    return () => controller.abort();
  }, [projectId, path, sha]);
  return (
    <div className="files-doc files-version-view">
      <div className="files-doc-head">
        <button type="button" className="files-back" onClick={onBack}>
          Back
        </button>
        <span className="files-path mono" title={path}>
          {path}
        </span>
      </div>
      {failure && (
        <>
          <p className="caption mono" title={sha}>
            {sha.slice(0, 8)}
          </p>
          <p className="caption files-fail" role="alert">
            {failure}
          </p>
        </>
      )}
      {!failure && !version && (
        <p className="caption" role="status">
          Reading...
        </p>
      )}
      {version && (
        <>
          {!(version.kind && IMAGE_KINDS.includes(version.kind)) && (
            <IdentityLine identity={version.identity} current={version.current} />
          )}
          {!version.current && onOpenCurrent && (
            <button type="button" className="files-edit" onClick={onOpenCurrent}>
              Open the current file
            </button>
          )}
          {history && version.text !== null && (
            <VersionCompare
              projectId={projectId}
              path={path}
              sha={version.identity.sha}
              current={version.current}
              history={history}
            />
          )}
          {version.kind && IMAGE_KINDS.includes(version.kind) ? (
            <PicturePreview projectId={projectId} path={path} sha={sha} />
          ) : version.text !== null ? (
            <pre className="files-raw">{version.text}</pre>
          ) : (
            <p className="caption">This version is not text, so Files describes rather than shows it. {NO_HANDOFF}</p>
          )}
        </>
      )}
    </div>
  );
}
