import { useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  EngineCatalog,
  EngineModel,
  ExternalEngine,
  IntegrationStatus,
  Mode,
  Route,
  Settings,
} from '../../shared/types';
import type { EngineConnection } from '../../shared/engines';
import { EXTERNAL_ENGINES, isExternalEngine } from '../../shared/engines';
import { MODE_CEILING, effortFor } from '../../shared/effort';
import { api, engineConnections } from '../api';

const ENGINE_IDS = ['codex', 'claude-code', 'opencode', 'oh-my-pi', 'cursor'] as const;

/**
 * How long a connection check stays fresh, matching
 * `EngineService.integration()`. Past it the account is still signed in and its
 * model list is still the one the engine reported; only the check is old, and
 * `EngineService.generate()` rechecks before anything is sent. So the menu says
 * when it last looked instead of hiding the account.
 */
const FRESH_MS = 300_000;

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
 * The same four facts AI setup shows for an external engine: found, a supported
 * version, signed in, and a model list the engine itself reported. An engine
 * the person has turned on and signed into belongs on the thread whether or not
 * its last check is inside the freshness window — the window governs how the
 * status line reads, never whether the account exists.
 */
function signedIn(connection: EngineConnection | undefined): connection is EngineConnection {
  return (
    !!connection &&
    connection.installation === 'found' &&
    connection.compatibility === 'supported' &&
    connection.authentication === 'signed-in' &&
    connection.models.length > 0
  );
}

/** One sentence for the engine heading: what Diomedes last saw, and when. */
function connectionState(connection: EngineConnection): string {
  const at = connection.checkedAt ? Date.parse(connection.checkedAt) : Number.NaN;
  if (Number.isFinite(at) && Date.now() - at < FRESH_MS) return 'Signed in · Ready';
  return Number.isFinite(at)
    ? `Signed in · checked ${new Date(at).toLocaleTimeString()}, rechecked before sending`
    : 'Signed in · rechecked before sending';
}

/**
 * The mono ENGINE model-id effort control. The menu groups live engine
 * catalogues plus Sample work; the choice PUTs `requested` on the thread
 * exactly as the Console did.
 *
 * Two sources, because the two families report differently. Codex keeps a
 * catalogue on disk that `GET /engines/codex/models` projects. An external
 * engine reports its models during the sign-in check, and
 * `GET /ai/status` is where that answer is kept — the same read AI setup makes,
 * so the thread offers exactly the models Settings > Engines just listed
 * instead of an empty menu beside a connected account.
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
  const [connections, setConnections] = useState<Partial<Record<ExternalEngine, EngineConnection>>>(
    {},
  );
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    for (const id of ENGINE_IDS) {
      if (isExternalEngine(id)) continue;
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

  // Read on mount and again when the menu opens: the sign-in check runs in
  // Settings, so the roster this component was mounted with is older than the
  // account it is meant to describe. The read is answered from memory and
  // starts no process.
  useEffect(() => {
    let alive = true;
    void engineConnections()
      .then((rows) => {
        if (!alive) return;
        setConnections(Object.fromEntries(rows.map((row) => [row.engine, row])));
      })
      .catch(() => {
        // A failed read leaves the last answer in place; nothing is invented.
      });
    return () => {
      alive = false;
    };
  }, [open]);

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

  /** Turned on by the person, and reported usable by the engine's own check. */
  function offered(id: (typeof ENGINE_IDS)[number]): boolean {
    if (!isExternalEngine(id)) return available(id, integrations, settings);
    return settings.services?.[id] === true && signedIn(connections[id]);
  }

  function modelsFor(id: string): EngineModel[] {
    if (isExternalEngine(id)) return connections[id]?.models ?? [];
    return catalogs[id]?.models ?? [];
  }

  const offeredIds = ENGINE_IDS.filter(offered);
  const savedModel =
    typeof settings.services?.[`${route}Model`] === 'string'
      ? String(settings.services[`${route}Model`])
      : '';
  const savedEffort =
    route === 'codex' && typeof settings.services?.codexEffort === 'string'
      ? settings.services.codexEffort
      : '';
  const chosenSlug = thread.requested?.model ?? '';
  const chosenModel = modelsFor(route).find((m) => m.slug === (chosenSlug || savedModel));
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
  // An engine the person turned on that has not passed its own check: say which
  // one and what fixes it, rather than leaving a gap in the menu.
  const waiting = EXTERNAL_ENGINES.filter(
    (id) => settings.services?.[id] === true && !signedIn(connections[id]),
  );

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
              {offeredIds.map((id) => {
                const integration = integrations.find((i) => i.id === id);
                const connection = isExternalEngine(id) ? connections[id] : undefined;
                const location = connection?.location || integration?.location || '';
                return (
                  <div key={id}>
                    <h4>
                      {integration?.name ?? id}
                      <span title={location || integration?.status}>
                        {shortLocation(location || integration?.status || '')}
                      </span>
                    </h4>
                    {connection && <p className="note">{connectionState(connection)}</p>}
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
                    {modelsFor(id).map((m) => (
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
              {waiting.map((id) => (
                <p className="note" key={id}>
                  {integrations.find((i) => i.id === id)?.name ?? id} is on but has not passed a
                  sign-in and model check. Open Settings &gt; Engines and press “Check sign-in and
                  models”.
                </p>
              ))}
              {offeredIds.length === 0 && waiting.length === 0 && (
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
