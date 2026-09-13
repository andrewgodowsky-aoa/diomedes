import { useEffect, useState } from 'react';
import type { DocumentInfo } from '../../shared/types';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_FILES,
  importableName,
  type FileReference,
} from '../../shared/file-imports';
import { api, listDocuments, readDocument } from '../api';
import { Button } from '../components';
import './file-imports.css';

export function BriefFiles({
  organizationId,
  projectId,
  disabled,
  onResult,
  report,
}: {
  organizationId: string;
  projectId: string;
  disabled: boolean;
  onResult(message: string): void;
  report(error: unknown): void;
}) {
  const [files, setFiles] = useState<DocumentInfo[]>([]);
  const [selected, setSelected] = useState<FileReference[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    listDocuments(projectId, abort.signal)
      .then(({ documents }) =>
        setFiles(
          documents.filter((file) => importableName(file.path) && file.size <= IMPORT_MAX_BYTES),
        ),
      )
      .catch((e: unknown) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : 'The project files could not be read.');
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [projectId, refresh]);
  async function act(action: () => Promise<void>) {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    onResult('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The brief could not be prepared.');
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="brief-files">
      <p className="caption">
        Check the exports for this brief, or check nothing to read the files the active setup
        approved. Use Files &gt; Import files to add exports from this computer. This brief runs
        locally.
      </p>
      <div className="brief-file-list" role="group" aria-label="Weekly brief sources">
        {files.map((file) => (
          <label key={file.path}>
            <input
              type="checkbox"
              checked={selected.some((ref) => ref.path === file.path)}
              disabled={
                disabled ||
                busy ||
                (selected.length >= IMPORT_MAX_FILES &&
                  !selected.some((ref) => ref.path === file.path))
              }
              onChange={(event) => {
                if (!event.target.checked) {
                  setSelected((current) => current.filter((ref) => ref.path !== file.path));
                  onResult('');
                  return;
                }
                void act(async () => {
                  const document = await readDocument(projectId, file.path);
                  setSelected((current) => [...current, { path: file.path, sha: document.sha }]);
                });
              }}
            />
            <span>{file.path}</span>
          </label>
        ))}
      </div>
      {error && (
        <p className="ws-error" role="alert">
          {error}
        </p>
      )}
      <div className="ws-actions">
        <Button
          tone="quiet"
          disabled={disabled || busy}
          onClick={() => {
            setSelected([]);
            setError('');
            setRefresh((value) => value + 1);
          }}
        >
          Refresh files
        </Button>
        <Button
          tone="quiet"
          disabled={disabled || busy}
          onClick={() =>
            void act(async () => {
              // Nothing checked is the configured run: the setup's approved scope is
              // read, and what it could not read is reported the same way.
              const result = await api<{ destination: string; projectName: string }>(
                `/workspace/organizations/${organizationId}/brief`,
                'POST',
                selected.length ? { projectId, sources: selected } : {},
              );
              onResult(
                `Drafted into ${result.projectName} as ${result.destination}. It is waiting for you to read.`,
              );
            })
          }
        >
          Prepare the weekly brief
        </Button>
      </div>
      <p className="caption" role="status">
        {busy
          ? 'Reading selected files or preparing the brief...'
          : selected.length
            ? `${selected.length} of ${IMPORT_MAX_FILES} files selected`
            : 'Nothing checked: the brief reads the files the active setup approved.'}
      </p>
    </div>
  );
}
