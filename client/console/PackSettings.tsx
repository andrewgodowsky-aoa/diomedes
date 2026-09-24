import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import {
  isPackActive,
  type CapabilityPackManifest,
  type InstructionFileRecord,
  type PackActivation,
} from '../../shared/capability-packs';
import { contributionSummary, type PackManifest } from '../../shared/pack-manifest';

interface InstalledPack {
  id: string;
  manifest: PackManifest | null;
  current: string;
  versions: { version: string; source: 'bundled' | 'directory' }[];
  rollbackTo: string | null;
  runtime: 'wired' | 'declared';
  damaged: string | null;
  activeProjects: { id: string; name: string }[];
  dependents: string[];
  updateAvailable: string | null;
}

interface PackOperation {
  opId: string;
  kind: string;
  phase: string;
  packId: string;
  at: string;
  detail: string;
}

interface PacksView {
  packs: CapabilityPackManifest[];
  activations: PackActivation[];
  instructionFiles: InstructionFileRecord[];
  installed: InstalledPack[];
  available: PackManifest[];
  operations: PackOperation[];
  storeProblem: string | null;
}

/** An action that needs a second, explicit yes before it runs. */
interface Pending {
  key: string;
  question: string;
  confirm: string;
  run(): Promise<unknown>;
}

type Dependency = { id: string; name: string; version: string };

/**
 * Capability packs: what is installed, which are on in this Project, and the
 * install, update, rollback and uninstall actions.
 *
 * Every pack's requested permissions are shown as requests - a pack declares
 * what it would use and Trust decides at use, so nothing here changes
 * authority (`AGENTS.md` decision 14). It lives inside the existing
 * task-permissions dialog rather than opening a settings surface of its own.
 * Every state it shows is read back from the pack store and the Project's own
 * activation records after each action; nothing is assumed to have worked.
 */
export function PackSettings({ projectId, onChange }: { projectId: string; onChange?(): void }) {
  const [view, setView] = useState<PacksView | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [folder, setFolder] = useState('');
  const [inspected, setInspected] = useState<{ path: string; manifest: PackManifest } | null>(null);
  const base = `/projects/${projectId}/packs`;

  useEffect(() => {
    let current = true;
    api<PacksView>(base).then(
      (loaded) => current && setView(loaded),
      (failure: unknown) =>
        current &&
        setError(failure instanceof Error ? failure.message : 'Capabilities could not be read.'),
    );
    return () => {
      current = false;
    };
  }, [base]);

  /**
   * Run one action and read the whole view back. A refusal that asks for more
   * (a dependency to install or turn on too) becomes a confirmation rather
   * than a silent retry.
   */
  async function act(
    key: string,
    run: () => Promise<unknown>,
    retry?: (dependencies: Dependency[]) => Omit<Pending, 'key'>,
  ) {
    setBusy(key);
    setError('');
    setPending(null);
    try {
      await run();
      // The checked folder has done its job; the installed list says what it became.
      if (key === 'inspected') setInspected(null);
      onChange?.();
    } catch (failure) {
      const dependencies =
        failure instanceof ApiError && failure.data.code === 'needs-dependencies'
          ? (failure.data.dependencies as Dependency[])
          : null;
      if (dependencies && retry) setPending({ key, ...retry(dependencies) });
      else setError(failure instanceof Error ? failure.message : 'That could not be changed.');
    } finally {
      try {
        setView(await api<PacksView>(base));
      } catch {
        // The error above, if any, is the one worth reading.
      }
      setBusy('');
    }
  }

  const listed = (dependencies: Dependency[]) =>
    dependencies.map((item) => `${item.name} ${item.version}`).join(', ');

  const activate = (pack: { id: string; name: string }) =>
    act(
      pack.id,
      () => api(`${base}/${encodeURIComponent(pack.id)}/activate`, 'POST', {}),
      (dependencies) => ({
        question: `${pack.name} needs ${listed(dependencies)} on in this project too.`,
        confirm: 'Turn on both',
        run: () =>
          api(`${base}/${encodeURIComponent(pack.id)}/activate`, 'POST', {
            includeDependencies: true,
          }),
      }),
    );

  const install = (source: unknown, name: string, key: string) =>
    act(
      key,
      () => api('/packs/install', 'POST', { source }),
      (dependencies) => ({
        question: `${name} needs ${listed(dependencies)} installed too.`,
        confirm: 'Install both',
        run: () => api('/packs/install', 'POST', { source, includeDependencies: true }),
      }),
    );

  const ask = (next: Pending) => {
    setError('');
    setPending(next);
  };

  async function confirmPending() {
    if (!pending) return;
    const current = pending;
    await act(current.key, current.run);
  }

  async function inspect() {
    setBusy('folder');
    setError('');
    setInspected(null);
    try {
      const result = await api<{ manifest: PackManifest }>('/packs/inspect', 'POST', {
        source: { kind: 'directory', path: folder },
      });
      setInspected({ path: folder, manifest: result.manifest });
    } catch (failure) {
      const problems =
        failure instanceof ApiError && Array.isArray(failure.data.problems)
          ? ` ${(failure.data.problems as string[]).join(' ')}`
          : '';
      setError(`${failure instanceof Error ? failure.message : 'That folder could not be read.'}${problems}`);
    } finally {
      setBusy('');
    }
  }

  const confirmation = (key: string) =>
    pending?.key === key && (
      <div className="pack-confirm" role="group" aria-label="Confirm">
        <p>{pending.question}</p>
        <button type="button" className="verb go" onClick={() => void confirmPending()}>
          {pending.confirm}
        </button>
        <button type="button" className="verb" onClick={() => setPending(null)}>
          Cancel
        </button>
      </div>
    );

  const requests = (manifest: PackManifest) =>
    manifest.permissions.requested.length ? (
      <>
        <p className="pack-label">Requests · Trust decides at use</p>
        <ul className="pack-points">
          {manifest.permissions.requested.map((item) => (
            <li key={item.capability}>
              <span className="mono lc">{item.capability}</span> {item.reason}
            </li>
          ))}
        </ul>
      </>
    ) : (
      <p className="pack-label">Requests nothing</p>
    );

  const installedIds = new Set(view?.installed.map((pack) => pack.id));
  const finished = view?.operations.filter((op) => op.phase !== 'started') ?? [];

  return (
    <section className="pack-settings" aria-label="Capabilities">
      <h3>Capabilities</h3>
      <p>Turning a pack on grants nothing; Trust still decides.</p>
      {view?.storeProblem && <p role="alert">{view.storeProblem}</p>}
      {view?.installed.map((pack) => {
        const manifest = pack.manifest;
        const name = manifest?.name ?? pack.id;
        const on = isPackActive(view.activations, pack.id);
        const skills = view.packs.find((item) => item.id === pack.id)?.skills.length ?? 0;
        // Records are per pack: another pack's instruction files are not this one's finding.
        const found = view.instructionFiles.filter((record) => record.packId === pack.id).length;
        const elsewhere = pack.activeProjects.filter((project) => project.id !== projectId);
        return (
          <div className="pack" key={pack.id} data-pack={pack.id}>
            <div className="pack-head">
              <b>{name}</b>
              <span className="mono lc pack-state">
                {pack.current} · {on ? 'on' : 'off'}
              </span>
            </div>
            {manifest && <p>{manifest.description}</p>}
            {pack.damaged && <p role="alert">{pack.damaged}</p>}
            {manifest && requests(manifest)}
            {manifest && (
              <p className="mono lc pack-contributes">{contributionSummary(manifest)}</p>
            )}
            {pack.runtime === 'declared' && (
              <p>Its contributions are recorded; this build does not run them yet.</p>
            )}
            {skills > 0 && (
              <p>
                {skills} playbooks, found with Ctrl K{on ? '' : ' once it is on'}.
              </p>
            )}
            {on && found > 0 && (
              <p>
                {found} instruction {found === 1 ? 'file' : 'files'} recorded in this project.
              </p>
            )}
            {elsewhere.length > 0 && (
              <p className="pack-where">On in {elsewhere.map((project) => project.name).join(', ')}.</p>
            )}
            <div className="pack-actions">
              <button
                type="button"
                className="verb"
                disabled={Boolean(busy) || Boolean(pack.damaged && !on)}
                onClick={() =>
                  void (on
                    ? act(pack.id, () =>
                        api(`${base}/${encodeURIComponent(pack.id)}/deactivate`, 'POST', {}),
                      )
                    : activate({ id: pack.id, name }))
                }
              >
                {busy === pack.id ? 'Saving...' : on ? 'Turn off' : 'Activate'}
              </button>
              {pack.updateAvailable && (
                <button
                  type="button"
                  className="verb"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    ask({
                      key: pack.id,
                      question: `Update ${name} from ${pack.current} to ${pack.updateAvailable}? ${pack.current} is kept for rollback.`,
                      confirm: 'Update',
                      run: () =>
                        api(`/packs/${encodeURIComponent(pack.id)}/update`, 'POST', {
                          source: { kind: 'bundled', packId: pack.id },
                        }),
                    })
                  }
                >
                  Update to {pack.updateAvailable}
                </button>
              )}
              {pack.rollbackTo && (
                <button
                  type="button"
                  className="verb"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    ask({
                      key: pack.id,
                      question: `Roll ${name} back from ${pack.current} to ${pack.rollbackTo}? It grants and restores no permission.`,
                      confirm: 'Roll back',
                      run: () => api(`/packs/${encodeURIComponent(pack.id)}/rollback`, 'POST', {}),
                    })
                  }
                >
                  Roll back to {pack.rollbackTo}
                </button>
              )}
              <button
                type="button"
                className="verb"
                disabled={Boolean(busy)}
                onClick={() =>
                  ask({
                    key: pack.id,
                    question: `Uninstall ${name} ${pack.current}? Its History in each project stays as it was.`,
                    confirm: 'Uninstall',
                    run: () => api(`/packs/${encodeURIComponent(pack.id)}/uninstall`, 'POST', {}),
                  })
                }
              >
                Uninstall
              </button>
            </div>
            {confirmation(pack.id)}
          </div>
        );
      })}
      {view && view.available.length > 0 && (
        <>
          <p className="pack-label">Ships with Diomedes · not installed</p>
          {view.available.map((manifest) => (
            <div className="pack" key={manifest.id} data-pack={manifest.id}>
              <div className="pack-head">
                <b>{manifest.name}</b>
                <span className="mono lc pack-state">{manifest.version}</span>
              </div>
              <p>{manifest.description}</p>
              {requests(manifest)}
              <div className="pack-actions">
                <button
                  type="button"
                  className="verb"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void install({ kind: 'bundled', packId: manifest.id }, manifest.name, manifest.id)
                  }
                >
                  {busy === manifest.id ? 'Installing...' : 'Install'}
                </button>
              </div>
              {confirmation(manifest.id)}
            </div>
          ))}
        </>
      )}
      <p className="pack-label">Install from a folder</p>
      <div className="pack-folder">
        <input
          aria-label="Pack folder"
          placeholder="Full path to a folder with diomedes-pack.json"
          value={folder}
          onChange={(event) => {
            setFolder(event.target.value);
            setInspected(null);
          }}
        />
        <button
          type="button"
          className="verb"
          disabled={Boolean(busy) || !folder.trim()}
          onClick={() => void inspect()}
        >
          {busy === 'folder' ? 'Checking...' : 'Check folder'}
        </button>
      </div>
      {inspected && (
        <div className="pack pack-inspected" data-pack={inspected.manifest.id}>
          <div className="pack-head">
            <b>{inspected.manifest.name}</b>
            <span className="mono lc pack-state">{inspected.manifest.version}</span>
          </div>
          <p>
            {inspected.manifest.publisher.name} · digest verified{' '}
            <span className="mono lc">{inspected.manifest.digest.slice(0, 19)}</span>
          </p>
          <p>{inspected.manifest.description}</p>
          {requests(inspected.manifest)}
          <div className="pack-actions">
            <button
              type="button"
              className="verb go"
              disabled={Boolean(busy)}
              onClick={() =>
                void (installedIds.has(inspected.manifest.id)
                  ? act('inspected', () =>
                      api(`/packs/${encodeURIComponent(inspected.manifest.id)}/update`, 'POST', {
                        source: { kind: 'directory', path: inspected.path },
                      }),
                    )
                  : install(
                      { kind: 'directory', path: inspected.path },
                      inspected.manifest.name,
                      'inspected',
                    ))
              }
            >
              {installedIds.has(inspected.manifest.id)
                ? `Update to ${inspected.manifest.version}`
                : `Install ${inspected.manifest.version}`}
            </button>
          </div>
          {confirmation('inspected')}
        </div>
      )}
      {finished.length > 0 && (
        <>
          <p className="pack-label">Recorded · {finished.length}</p>
          <ul className="pack-points pack-record">
            {finished
              .slice(-5)
              .reverse()
              .map((op) => (
                <li key={`${op.opId}-${op.phase}`}>
                  <span className="mono lc">{op.phase}</span> {op.detail}
                </li>
              ))}
          </ul>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
