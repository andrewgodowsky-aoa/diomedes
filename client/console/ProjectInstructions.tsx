import { useState } from 'react';
import { api } from '../api';
import type { InstructionFileRecord } from '../../shared/capability-packs';
import type { DocumentContent } from '../../shared/types';

/**
 * One line in the thread head saying which repository instruction files this
 * project is working under, and a panel that opens the ones it names.
 *
 * Two properties from `capability-packs.md` §4.1 are the whole component:
 *
 * - **It is an indication, not a narration.** One line, on the surface where
 *   work happens, and no caption underneath restating it (`AGENTS.md`
 *   decision 4). The state word is the only thing that changes: files that
 *   were found but produced no rule say `found`, not `loaded`.
 * - **Discovery is not obedience-in-secret.** Every record discovery made is
 *   listed here, including the ones the path guard refused and the ones too
 *   large for the instruction view, and each readable one can be opened and
 *   read exactly as Diomedes read it.
 *
 * The body is fetched from the instruction read route, which serves only paths
 * discovery already recorded. Nothing here sends a file to a model.
 */
const kb = (size: number | null) => (size === null ? '' : `${Math.max(1, Math.round(size / 1024))} KB`);

export function ProjectInstructions({
  projectId,
  files,
}: {
  projectId: string;
  files: readonly InstructionFileRecord[];
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [error, setError] = useState('');

  if (!files.length) return null;
  const loaded = files.filter((file) => file.state === 'loaded');
  const named = (loaded.length ? loaded : files).map((file) => file.path).join(' · ');

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

  return (
    <div className="instructions">
      <button
        type="button"
        className="instructions-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={named}
      >
        Project instructions {loaded.length ? 'loaded' : 'found'} · <span>{named}</span>
      </button>
      {open && (
        <div className="instructions-panel">
          {files.map((file) => (
            <div className="instructions-file" key={file.path}>
              <div className="instructions-file-head">
                {file.state === 'unreadable' ? (
                  <span className="instructions-name">{file.path}</span>
                ) : (
                  <button
                    type="button"
                    className="instructions-name"
                    aria-expanded={shown === file.path}
                    onClick={() => void read(file.path)}
                  >
                    {file.path}
                  </button>
                )}
                <span className="mono lc">
                  {file.state}
                  {file.size === null ? '' : ` · ${kb(file.size)}`}
                  {file.sha ? ` · ${file.sha.slice(0, 12)}` : ''}
                </span>
              </div>
              <p>{file.detail}</p>
              {shown === file.path && (error || content) && (
                <pre className="instructions-body">{error || content?.text}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
