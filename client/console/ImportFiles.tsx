import { useEffect, useState } from 'react';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_MAX_TOTAL_BYTES,
  type ImportCandidate,
  type ImportListing,
} from '../../shared/file-imports';
import { api } from '../api';
import { Button, Modal } from '../components';
import './file-imports.css';

/** Host-side selection keeps the real path available to the path/trust guard. */
export function ImportFiles({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose(): void;
  onImported(paths: string[]): void;
}) {
  const [folder, setFolder] = useState('');
  const [listing, setListing] = useState<ImportListing | null>(null);
  const [selected, setSelected] = useState<ImportCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/projects/${encodeURIComponent(projectId)}/imports`;
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    api<ImportListing>(`${base}/browse`, 'GET', undefined, abort.signal)
      .then((result) => {
        setListing(result);
        setFolder(result.path);
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : 'The folder could not be read.');
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [base]);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import could not be completed.');
    } finally {
      setBusy(false);
    }
  }
  const browse = (path: string) =>
    act(async () => {
      const result = await api<ImportListing>(`${base}/browse?path=${encodeURIComponent(path)}`);
      setListing(result);
      setFolder(result.path);
    });
  const bytes = selected.reduce((total, file) => total + file.bytes, 0);
  return (
    <Modal
      title="Import export files"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="file-import">
        <p className="caption">
          Copy UTF-8 TXT, Markdown, CSV, TSV or JSON exports into Imports in this project. Originals
          stay where they are. Up to 8 files, 1 MB each and 4 MB total.
        </p>
        <form
          className="import-location"
          onSubmit={(event) => {
            event.preventDefault();
            void browse(folder);
          }}
        >
          <label>
            Folder on this computer
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              disabled={busy}
            />
          </label>
          <Button disabled={busy} type="submit">
            Open folder
          </Button>
          <Button disabled={busy || !listing?.parent} onClick={() => void browse(listing!.parent!)}>
            Up
          </Button>
        </form>
        <div className="import-list" aria-label="Local exports" aria-busy={busy}>
          {listing?.folders.map((item) => (
            <button
              type="button"
              key={item.path}
              disabled={busy}
              onClick={() => void browse(item.path)}
              title={item.path}
            >
              Folder: {item.name}
            </button>
          ))}
          {listing?.files.map((item) => (
            <button
              type="button"
              key={item.path}
              title={item.path}
              disabled={
                busy ||
                selected.length >= IMPORT_MAX_FILES ||
                item.bytes > IMPORT_MAX_BYTES ||
                selected.some((file) => file.path === item.path)
              }
              onClick={() =>
                void act(async () => {
                  const file = await api<ImportCandidate>(`${base}/inspect`, 'POST', {
                    path: item.path,
                  });
                  if (bytes + file.bytes > IMPORT_MAX_TOTAL_BYTES)
                    throw new Error('Choose no more than 4 MB of exports at once.');
                  setSelected((current) => [...current, file]);
                })
              }
            >
              {item.name}{' '}
              <span className="caption">
                {Math.ceil(item.bytes / 1024)} KB
                {item.bytes > IMPORT_MAX_BYTES ? ' - over limit' : ''}
              </span>
            </button>
          ))}
          {listing && !listing.files.length && (
            <p className="caption">
              No supported text exports in this folder. Images, PDF and spreadsheet workbooks are
              not supported by this import.
            </p>
          )}
        </div>
        <ul className="import-selection" aria-label="Selected exports">
          {selected.map((file) => (
            <li key={file.path}>
              <span title={file.path}>{file.name}</span>
              <Button
                tone="quiet"
                disabled={busy}
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  setSelected((current) => current.filter((item) => item.path !== file.path))
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <p className="caption">
          Importing records a local copy in History. Choose the copies separately when preparing a
          weekly brief; importing sends nothing to a provider.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <span role="status">
            {busy ? 'Reading or importing files...' : `${selected.length} selected`}
          </span>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || !selected.length}
            onClick={() =>
              void act(async () => {
                const result = await api<{ files: { path: string }[] }>(base, 'POST', {
                  files: selected.map(({ path, sha }) => ({ path, sha })),
                });
                onImported(result.files.map((file) => file.path));
              })
            }
          >
            Import selected files
          </Button>
        </div>
      </div>
    </Modal>
  );
}
