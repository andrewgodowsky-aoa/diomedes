import { useEffect, useState } from 'react';
import type { Settings } from '../shared/types';
import { api } from './api';
import { Button, Mark } from './components';
import type { LocalModelsView } from './console/LocalModelControls';

/**
 * The folder a local model is installed in (DIO-201). The model's installer writes a
 * `nectovia-connection.json` there, and that file is where the model's name, its server and its
 * profiles come from. Empty reads the folder the environment names instead. Saving reads the
 * folder again. It starts nothing: only Start in the ask row starts the model.
 */
export function LocalModelFolder({
  settings,
  save,
  refresh,
}: {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  refresh: () => void;
}) {
  const saved = settings.localModelFolder ?? '';
  const [value, setValue] = useState(saved);
  const [view, setView] = useState<LocalModelsView | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  useEffect(() => {
    const controller = new AbortController();
    void api<LocalModelsView>('/ai/local-models', 'GET', undefined, controller.signal)
      .then(setView)
      .catch(() => {
        if (!controller.signal.aborted) setView(null);
      });
    return () => controller.abort();
  }, [saved]);

  const changed = value.trim() !== saved;
  const submit = () => {
    if (!changed || saving) return;
    setSaving(true);
    void save({ ...settings, localModelFolder: value.trim() || null })
      .then(refresh)
      .finally(() => setSaving(false));
  };
  const folder = view?.folder ?? null;
  const running = view?.status.state === 'ready' || view?.status.state === 'busy';
  return (
    <section className="service" aria-label="Local model folder">
      <div className="row">
        <h3>
          <Mark state={running ? 'done' : folder && view?.status.installed ? 'waiting' : 'todo'} />
          Local model folder
        </h3>
        {view?.name && <span className="caption push-right">{view.name}</span>}
      </div>
      <p>
        Choose the folder that holds your local AI and its nectovia-connection.json file. Press Start to use it.
      </p>
      <div className="row choice-row">
        <input
          aria-label="Local model folder"
          value={value}
          placeholder={folder?.source === 'environment' ? folder.path : 'F:\\Models\\Local'}
          spellCheck={false}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <Button onClick={submit} disabled={!changed || saving}>
          Save
        </Button>
      </div>
      {folder?.source === 'environment' && (
        <p className="caption">Read from the environment: {folder.path}</p>
      )}
      {view && (
        <p className="caption" role="status">
          {view.status.detail}
        </p>
      )}
    </section>
  );
}
