import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  isPackActive,
  type CapabilityPackManifest,
  type InstructionFileRecord,
  type PackActivation,
} from '../../shared/capability-packs';

interface PacksView {
  packs: CapabilityPackManifest[];
  activations: PackActivation[];
  instructionFiles: InstructionFileRecord[];
}

/**
 * Turning a capability pack on or off for one Project.
 *
 * The sentence under "What it would use" is the point of the section, not
 * decoration: a pack declares what it would use and Trust still decides, so
 * this control changes what Diomedes is good at and changes no authority at
 * all (`AGENTS.md` decision 14). It lives inside the existing task-permissions
 * dialog rather than opening a settings surface of its own.
 */
export function PackSettings({ projectId, onChange }: { projectId: string; onChange?(): void }) {
  const [view, setView] = useState<PacksView | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
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

  async function decide(pack: CapabilityPackManifest, next: 'activate' | 'deactivate') {
    setBusy(pack.id);
    setError('');
    try {
      await api(`${base}/${encodeURIComponent(pack.id)}/${next}`, 'POST', {});
      setView(await api<PacksView>(base));
      onChange?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That could not be changed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="pack-settings" aria-label="Capabilities">
      <h3>Capabilities</h3>
      {view?.packs.map((pack) => {
        const on = isPackActive(view.activations, pack.id);
        const found = view.instructionFiles.length;
        return (
          <div className="pack" key={pack.id}>
            <div className="pack-head">
              <b>{pack.name}</b>
              <span className="mono lc">{on ? 'on' : 'off'}</span>
            </div>
            <p>{pack.summary}</p>
            <p className="pack-label">What it would use</p>
            <ul className="pack-points">
              {pack.needs.map((need) => (
                <li key={need.capability}>
                  <span className="mono lc">{need.capability}</span> {need.reason}
                </li>
              ))}
            </ul>
            <p>Turning it on grants nothing; Trust still decides.</p>
            <p className="pack-label">What it contributes</p>
            <p className="mono lc pack-contributes">{pack.contributes.join(' · ')}</p>
            {on && found > 0 && (
              <p>
                {found} instruction {found === 1 ? 'file' : 'files'} recorded in this project.
              </p>
            )}
            <button
              type="button"
              className="verb"
              disabled={busy === pack.id}
              onClick={() => void decide(pack, on ? 'deactivate' : 'activate')}
            >
              {busy === pack.id ? 'Saving...' : on ? 'Turn off' : 'Activate'}
            </button>
          </div>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
