import { useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  EngineCatalog,
  IntegrationStatus,
  Mode,
  Route,
  Settings,
} from '../../shared/types';
import { MODE_CEILING, effortFor } from '../../shared/effort';
import { api } from '../api';

const ENGINE_IDS = ['codex', 'claude-code', 'opencode', 'oh-my-pi', 'cursor'] as const;

interface PickerProps {
  thread: Conversation;
  mode: Mode;
  route: Route;
  live: boolean;
  integrations: IntegrationStatus[];
  settings: Settings;
  busy: boolean;
  onPick(requested: Conversation['requested'], engine: string): void;
}

/**
 * A 340 px menu cannot hold an install path. Keep the tail that identifies the
 * binary; the whole path stays available on hover.
 */
function shortLocation(value: string): string {
  if (value.length <= 28) return value;
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length < 3) return value;
  return `…${value.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(value.includes('\\') ? '\\' : '/')}`;
}

function available(id: string, integrations: IntegrationStatus[], settings: Settings): boolean {
  const found = integrations.find((i) => i.id === id);
  if (!found) return false;
  if (found.kind === 'sample') return found.available;
  return found.available && settings.services?.[id] === true;
}

/**
 * The mono ENGINE model-id effort control. The menu groups live engine
 * catalogues (GET /engines/:id/models) plus Sample work; the choice PUTs
 * `requested` on the thread exactly as the Console did.
 */
export function Picker({
  thread,
  mode,
  route,
  live,
  integrations,
  settings,
  busy,
  onPick,
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const [catalogs, setCatalogs] = useState<Record<string, EngineCatalog | null>>({});
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    for (const id of ENGINE_IDS) {
      if (!available(id, integrations, settings)) continue;
      api<EngineCatalog>(`/engines/${id}/models`)
        .then((catalog) => {
          if (alive) setCatalogs((prev) => ({ ...prev, [id]: catalog }));
        })
        .catch(() => {
          if (alive)
            setCatalogs((prev) => ({ ...prev, [id]: { engine: id, models: [], detail: '' } }));
        });
    }
    return () => {
      alive = false;
    };
  }, [integrations, settings]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const savedModel =
    typeof settings.services?.[`${route}Model`] === 'string'
      ? String(settings.services[`${route}Model`])
      : '';
  const savedEffort =
    route === 'codex' && typeof settings.services?.codexEffort === 'string'
      ? settings.services.codexEffort
      : '';
  const chosenSlug = thread.requested?.model ?? '';
  const chosenModel = catalogs[route]?.models.find((m) => m.slug === (chosenSlug || savedModel));
  const chosen = chosenModel ? { engine: route, model: chosenModel } : undefined;
  const displayEngine = route;
  const engLabel =
    displayEngine === 'sample'
      ? ''
      : (integrations.find((i) => i.id === displayEngine)?.name ?? displayEngine);
  const displayModel = chosenSlug || savedModel || chosen?.model.slug || 'default';
  const wantedEffort =
    route === 'codex'
      ? thread.requested?.effort || savedEffort || chosen?.model.defaultEffort || 'medium'
      : '';
  const runsAt = effortFor(mode, wantedEffort, wantedEffort);
  const capped = runsAt !== wantedEffort;
  const ceiling = MODE_CEILING[mode];

  function choose(requested: Conversation['requested'], engine: string) {
    if (live || busy) return;
    onPick(requested, engine);
    setOpen(false);
  }

  return (
    <div className="picker model-picker" ref={root}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Engine, model and reasoning level for this thread"
        onClick={() => setOpen(!open)}
      >
        {engLabel && <span className="eng">{engLabel}</span>}
        <span className="mdl">{displayEngine === 'sample' ? 'Choose an engine' : displayModel}</span>
        {wantedEffort && (
          <span className={`eff ${capped ? 'capped' : ''}`}>
            {capped ? `${wantedEffort}, runs ${runsAt}` : runsAt}
          </span>
        )}
      </button>
      {open && (
        <div className="pmenu open" role="menu">
          {live ? (
            <div className="note">Waiting for the current run to finish</div>
          ) : (
            <>
              {ENGINE_IDS.filter((id) => available(id, integrations, settings)).map((id) => {
                const integration = integrations.find((i) => i.id === id);
                const catalog = catalogs[id];
                return (
                  <div key={id}>
                    <h4>
                      {integration?.name ?? id}
                      <span title={integration?.location || integration?.status}>
                        {shortLocation(integration?.location || integration?.status || '')}
                      </span>
                    </h4>
                    <button
                      type="button"
                      className={`m ${!chosenSlug ? 'on' : ''}`}
                      role="menuitemradio"
                      aria-checked={!chosenSlug}
                      onClick={() => choose(null, id)}
                    >
                      <span>Default</span>
                      <span className="id">default</span>
                      <small>Follow the saved default in Settings</small>
                    </button>
                    {(catalog?.models ?? []).map((m) => (
                      <button
                        key={m.slug}
                        type="button"
                        className={`m ${m.slug === chosenSlug ? 'on' : ''}`}
                        role="menuitemradio"
                        aria-checked={m.slug === chosenSlug}
                        onClick={() => choose({ model: m.slug, effort: m.defaultEffort }, id)}
                      >
                        <span>{m.name}</span>
                        <span className="id">{m.slug}</span>
                        <small>{m.description}</small>
                      </button>
                    ))}
                  </div>
                );
              })}
              {!ENGINE_IDS.some((id) => available(id, integrations, settings)) && (
                <p className="note">Connect an engine in Settings.</p>
              )}
              {chosen && chosen.model.efforts.length > 0 ? (
                <>
                  <div className="ladder" role="radiogroup" aria-label="Reasoning level">
                    {chosen.model.efforts.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        title={e.description}
                        className={`${e.id === wantedEffort ? 'on' : ''} ${ceiling && effortFor(mode, e.id, e.id) !== e.id ? 'capped' : ''}`.trim()}
                        onClick={() =>
                          choose({ model: chosen.model.slug, effort: e.id }, chosen.engine)
                        }
                      >
                        {e.id}
                      </button>
                    ))}
                  </div>
                  {ceiling ? (
                    <div className="note">
                      <b>Fix runs at {ceiling}.</b> Your choice still governs Ask, Plan and Build.
                    </div>
                  ) : (
                    <div className="note">
                      Applies to this thread. The default lives in Settings.
                    </div>
                  )}
                </>
              ) : (
                <div className="note">Applies to this thread. The default lives in Settings.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
