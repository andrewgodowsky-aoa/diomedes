import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatusSnapshot } from '../shared/app-updates';
import { ApiError, api } from './api';
import { Button } from './components';
import './app-updates.css';

type Phase = 'loading' | 'ready' | 'checking' | 'downloading' | 'installing' | 'launched';

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The update check could not be completed.';
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AppUpdates() {
  const [status, setStatus] = useState<UpdateStatusSnapshot | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [problem, setProblem] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<UpdateStatusSnapshot>('/updates/status'));
    } catch (error) {
      setStatus(null);
      setProblem(failureMessage(error));
    }
  }, []);

  useEffect(() => {
    setPhase('loading');
    void refresh().finally(() => {
      setPhase((current) => (current === 'loading' ? 'ready' : current));
    });
  }, [refresh]);

  const run = useCallback(
    async (
      next: Phase,
      route: '/updates/check' | '/updates/download' | '/updates/install',
      body?: unknown,
    ) => {
      setPhase(next);
      setProblem('');
      try {
        if (route === '/updates/install') {
          await api<{ launched: boolean; version: string }>(route, 'POST', body);
          setPhase('launched');
          return;
        } else {
          await api(route, 'POST', body ?? {});
          setPhase('ready');
        }
        await refresh();
      } catch (error) {
        setProblem(failureMessage(error));
        setPhase('ready');
        await refresh();
      }
    },
    [refresh],
  );

  const outcome = status?.check.outcome ?? null;
  const handedOff = phase === 'launched' || status?.install.phase === 'launched';
  const busy =
    phase === 'checking' ||
    phase === 'downloading' ||
    phase === 'installing' ||
    handedOff ||
    status?.install.phase === 'installing';

  return (
    <div className="app-updates">
      <h2>App updates</h2>
      <p className="prose">
        Diomedes checks the official release page only when you ask. A newer version downloads first
        for verification; nothing installs without your explicit close-and-install.
      </p>
      <p className="prose version-row">
        <span>
          Current version <strong>{status?.installedVersion ?? '…'}</strong>
        </span>
        <span className="caption push-right">{status?.channel ?? ''}</span>
      </p>
      {problem && <p role="alert">{problem}</p>}
      {phase === 'loading' ? (
        <p className="caption">Reading the installed version.</p>
      ) : !status ? (
        <Button onClick={() => void refresh()}>Read version again</Button>
      ) : (
        <>
          {outcome !== 'available' && (
            <p className="prose">
              {outcome === null
                ? 'Check for the latest stable Windows release.'
                : (status.check.detail ??
                  (outcome === 'current'
                    ? 'This installation is current.'
                    : 'No stable update is published.'))}
            </p>
          )}
          {outcome === 'available' && (
            <section className="block">
              <h3>Version {status.check.latestVersion} is available</h3>
              {status.check.notesUrl && (
                <p className="prose notes-row">
                  <a href={status.check.notesUrl} target="_blank" rel="noreferrer">
                    Release notes
                  </a>
                </p>
              )}
              {status.download.ready ? (
                <>
                  <p className="code">
                    {status.download.assetName}
                    <br />
                    {status.download.bytes !== null ? `${megabytes(status.download.bytes)} · ` : ''}
                    {status.download.verified === 'size-origin-digest'
                      ? 'size, origin and published digest verified'
                      : 'Published digest verification unavailable'}
                  </p>
                  <p className="caption">
                    Close and install exits Diomedes and opens the verified installer. The existing
                    per-user installer preserves project and profile data.
                  </p>
                </>
              ) : (
                <p className="caption">
                  Download checks the official asset's size and published SHA-256 before
                  installation.
                </p>
              )}
            </section>
          )}
          {(outcome === 'no-release' || outcome === 'prerelease-only' || !status.supported) && (
            <p className="prose notes-row">
              <a href={status.releasesUrl} target="_blank" rel="noreferrer">
                Official releases
              </a>
            </p>
          )}
          {!status.supported && <p className="caption">{status.supportReason}</p>}
          {status.workActive && outcome === 'available' && status.download.ready && (
            <p className="caption">
              Project work is active. Finish or stop it before installing the update.
            </p>
          )}
          <div className="actions">
            <Button disabled={busy} onClick={() => void run('checking', '/updates/check')}>
              {phase === 'checking' ? 'Checking…' : 'Check for updates'}
            </Button>
            {outcome === 'available' && !status.download.ready && (
              <Button disabled={busy} onClick={() => void run('downloading', '/updates/download')}>
                {phase === 'downloading' ? 'Downloading…' : 'Download'}
              </Button>
            )}
            {outcome === 'available' && status.download.ready && status.supported && (
              <Button
                disabled={busy || status.workActive}
                onClick={() =>
                  void run('installing', '/updates/install', {
                    assetName: status.download.assetName,
                    sha256: status.download.sha256 ?? undefined,
                  })
                }
              >
                {phase === 'installing' ? 'Starting installer…' : 'Close and install'}
              </Button>
            )}
          </div>
          {handedOff && (
            <p className="prose">
              Update handoff accepted. Diomedes is closing; the installer will open after it exits.
            </p>
          )}
        </>
      )}
    </div>
  );
}
