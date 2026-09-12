import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../shared/types';
import type { ExternalEngine } from '../shared/types';
import type { EngineConnection, InstallOffer } from '../shared/engines';
import { ENGINE_NAMES, EXTERNAL_ENGINES, TEXT_ROUTE_CONTROLS } from '../shared/engines';
import { advanceSetup } from '../shared/onboarding';
import { api } from './api';
import { Button } from './components';
import './ai-setup.css';

const DISCLOSURE =
  'Diomedes checks installed tools, versions, sign-in status, and model lists on this computer. ' +
  'Short-lived checks do not send model prompts, install tools, or open sign-in pages.';

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The request could not be completed.';
}

function placeholder(engine: ExternalEngine): EngineConnection {
  return {
    engine,
    installation: 'not-checked',
    compatibility: 'unknown',
    authentication: 'unknown',
    accountRoute: null,
    models: [],
    checkedAt: null,
    detail: 'Not checked yet.',
    usage: { state: 'unknown', checkedAt: null },
  };
}

function installationText(value: EngineConnection['installation']): string {
  if (value === 'missing') return 'Not installed';
  if (value === 'found') return 'Found';
  return 'Not checked';
}

function compatibilityText(value: EngineConnection['compatibility']): string {
  if (value === 'supported') return 'Supported';
  if (value === 'unsupported') return 'Not supported';
  return 'Unknown';
}

function authenticationText(value: EngineConnection['authentication']): string {
  if (value === 'signed-in') return 'Signed in';
  if (value === 'signed-out') return 'Signed out';
  return 'Unknown';
}

function isUsable(connection: EngineConnection): boolean {
  return (
    connection.compatibility === 'supported' &&
    connection.authentication === 'signed-in' &&
    connection.checkedAt !== null &&
    Date.now() - Date.parse(connection.checkedAt) < 300_000 &&
    connection.models.length > 0
  );
}

export interface AIConnectionProps {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  busy?: boolean;
}

export interface AISetupProps extends AIConnectionProps {
  onContinue: () => void;
  onBack: () => void;
}

export function AIConnections({ settings, save, busy }: AIConnectionProps) {
  const [connections, setConnections] = useState<EngineConnection[] | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [selecting, setSelecting] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [offers, setOffers] = useState<Record<string, InstallOffer | undefined>>({});
  const [offerLoading, setOfferLoading] = useState<Record<string, boolean>>({});
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [loginBusy, setLoginBusy] = useState<Record<string, boolean>>({});
  const [loginDetail, setLoginDetail] = useState<Record<string, string>>({});
  const [opError, setOpError] = useState<Record<string, string | null>>({});
  const [progress, setProgress] = useState<string | null>('Loading connections…');
  const mounted = useRef(true);
  const inFlight = useRef(new Set<AbortController>());
  const installControllers = useRef(new Map<string, AbortController>());

  function fail(engine: string, error: unknown): void {
    if (mounted.current) setOpError((prev) => ({ ...prev, [engine]: messageOf(error) }));
  }

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api<{ connections: EngineConnection[] }>(
        '/ai/status',
        'GET',
        undefined,
        signal,
      );
      if (!mounted.current) return;
      setConnections(result.connections);
      setStatusError(null);
    } catch (error) {
      if (signal?.aborted || !mounted.current) return;
      setStatusError(messageOf(error));
    }
  }, []);

  // Initial mount reports status only. Discovery is never started here.
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    inFlight.current.add(controller);
    setStatusLoading(true);
    setProgress('Loading connections…');
    void refreshStatus(controller.signal).finally(() => {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setStatusLoading(false);
        setProgress(null);
      }
    });
    return () => {
      mounted.current = false;
      inFlight.current.forEach((c) => {
        c.abort();
      });
      inFlight.current.clear();
      installControllers.current.forEach((c) => {
        c.abort();
      });
      installControllers.current.clear();
    };
  }, [refreshStatus]);

  async function discover(): Promise<void> {
    if (discovering) return;
    const controller = new AbortController();
    inFlight.current.add(controller);
    setDiscovering(true);
    setStatusError(null);
    setProgress('Checking installed tools on this computer…');
    try {
      const result = await api<{ connections: EngineConnection[] }>(
        '/ai/discover',
        'POST',
        { consent: true },
        controller.signal,
      );
      if (!mounted.current) return;
      setConnections(result.connections);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      setStatusError(messageOf(error));
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setDiscovering(false);
        setProgress(null);
      }
    }
  }

  async function check(engine: ExternalEngine): Promise<void> {
    const name = ENGINE_NAMES[engine];
    const controller = new AbortController();
    inFlight.current.add(controller);
    setChecking((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    setProgress(`Checking sign-in and models for ${name}…`);
    try {
      const updated = await api<EngineConnection>(
        `/ai/check/${engine}`,
        'POST',
        undefined,
        controller.signal,
      );
      if (!mounted.current) return;
      setConnections((prev) =>
        prev === null ? [updated] : prev.map((c) => (c.engine === engine ? updated : c)),
      );
      await refreshStatus(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      fail(engine, error);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setChecking((prev) => ({ ...prev, [engine]: false }));
        setProgress(null);
      }
    }
  }

  async function toggle(engine: ExternalEngine, on: boolean): Promise<void> {
    setOpError((prev) => ({ ...prev, [engine]: null }));
    try {
      await save({
        ...settings,
        services: { ...settings.services, [engine]: on },
      });
    } catch (error) {
      fail(engine, error);
    }
  }

  async function useAsDefault(engine: ExternalEngine, model: string): Promise<void> {
    if (!model || selecting[engine]) return;
    const controller = new AbortController();
    inFlight.current.add(controller);
    setSelecting((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    setProgress(`Setting the default model for ${ENGINE_NAMES[engine]}…`);
    try {
      const result = await api<Settings>(
        '/ai/select',
        'POST',
        { engine, model },
        controller.signal,
      );
      if (!mounted.current) return;
      // The parent save updates the UI; the old thread and project settings
      // are left untouched by passing the returned settings through as-is.
      await save(result);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      fail(engine, error);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setSelecting((prev) => ({ ...prev, [engine]: false }));
        setProgress(null);
      }
    }
  }

  async function loadOffer(engine: ExternalEngine): Promise<void> {
    const controller = new AbortController();
    inFlight.current.add(controller);
    setOfferLoading((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    try {
      const offer = await api<InstallOffer>(
        `/ai/install/${engine}`,
        'GET',
        undefined,
        controller.signal,
      );
      if (!mounted.current) return;
      setOffers((prev) => ({ ...prev, [engine]: offer }));
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      fail(engine, error);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) setOfferLoading((prev) => ({ ...prev, [engine]: false }));
    }
  }

  async function install(engine: ExternalEngine): Promise<void> {
    if (installing[engine]) return;
    const controller = new AbortController();
    installControllers.current.set(engine, controller);
    inFlight.current.add(controller);
    setInstalling((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    setProgress(`Installing ${ENGINE_NAMES[engine]}…`);
    try {
      await api(`/ai/install/${engine}`, 'POST', { consent: true }, controller.signal);
      if (!mounted.current) return;
      await refreshStatus(controller.signal);
    } catch (error) {
      if (!mounted.current) return;
      if (controller.signal.aborted) {
        setOpError((prev) => ({ ...prev, [engine]: 'Installation cancelled.' }));
        return;
      }
      fail(engine, error);
    } finally {
      installControllers.current.delete(engine);
      inFlight.current.delete(controller);
      if (mounted.current) {
        setInstalling((prev) => ({ ...prev, [engine]: false }));
        setProgress(null);
      }
    }
  }

  function cancelInstall(engine: ExternalEngine): void {
    installControllers.current.get(engine)?.abort();
  }

  async function login(engine: ExternalEngine): Promise<void> {
    const controller = new AbortController();
    inFlight.current.add(controller);
    setLoginBusy((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    setProgress(`Waiting on ${ENGINE_NAMES[engine]} sign-in…`);
    try {
      const result = await api<{ detail: string }>(
        `/ai/login/${engine}`,
        'POST',
        { consent: true },
        controller.signal,
      );
      if (!mounted.current) return;
      setLoginDetail((prev) => ({ ...prev, [engine]: result.detail }));
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      fail(engine, error);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setLoginBusy((prev) => ({ ...prev, [engine]: false }));
        setProgress(null);
      }
    }
  }

  const byEngine = new Map((connections ?? []).map((c) => [c.engine, c]));
  const rows = EXTERNAL_ENGINES.map((engine) => byEngine.get(engine) ?? placeholder(engine));
  const services = settings.services ?? {};
  const defaultEngine =
    typeof services['defaultEngine'] === 'string' ? services['defaultEngine'] : '';

  return (
    <div className="ai-connections">
      <p className="prose small">{DISCLOSURE}</p>
      <details>
        <summary>Controls and limits</summary>
        <div className="setting-rows">
          {TEXT_ROUTE_CONTROLS.map((row) => (
            <div className="setting-row" key={row.control}>
              <span>
                {row.control} ({row.level})
              </span>
              <span>{row.detail}</span>
            </div>
          ))}
        </div>
      </details>
      <div className="actions">
        <Button onClick={() => void discover()} disabled={discovering || statusLoading || busy}>
          {discovering ? 'Checking…' : 'Check this computer'}
        </Button>
      </div>
      <p className="caption" role="status" aria-live="polite">
        {progress ?? ''}
      </p>
      {statusError !== null && (
        <p className="ai-alert" role="alert">
          {statusError}
        </p>
      )}
      {connections !== null && connections.length === 0 && (
        <p className="caption">No connections reported.</p>
      )}
      <div className="service-list">
        {rows.map((c) => {
          const engine = c.engine;
          const name = ENGINE_NAMES[engine];
          const usable = isUsable(c);
          const raw = services[engine];
          const on = raw === true;
          const savedModel = services[`${engine}Model`];
          const storedModel =
            typeof savedModel === 'string' && c.models.some((m) => m.slug === savedModel)
              ? savedModel
              : '';
          const chosen = choices[engine] ?? (storedModel || c.models[0]?.slug || '');
          const offer = offers[engine];
          const error = opError[engine];
          return (
            <section className="service" key={engine} aria-label={name}>
              <div className="row">
                <h3>{name}</h3>
                {defaultEngine === engine && <span className="caption push-right">Default</span>}
              </div>
              <details className="ai-connection-details">
                <summary>
                  Installation: {installationText(c.installation)} · Compatibility:{' '}
                  {compatibilityText(c.compatibility)} · Sign-in:{' '}
                  {authenticationText(c.authentication)}
                </summary>
                <div className="setting-rows">
                  <div className="setting-row">
                    <span>Installation</span>
                    <span>{installationText(c.installation)}</span>
                  </div>
                  <div className="setting-row">
                    <span>Compatibility</span>
                    <span>{compatibilityText(c.compatibility)}</span>
                  </div>
                  <div className="setting-row">
                    <span>Sign-in</span>
                    <span>{authenticationText(c.authentication)}</span>
                  </div>
                  <div className="setting-row">
                    <span>Version</span>
                    <span>{c.version ?? 'Version not reported'}</span>
                  </div>
                  {c.location ? (
                    <div className="setting-row">
                      <span>Location</span>
                      <span>{c.location}</span>
                    </div>
                  ) : null}
                  <div className="setting-row">
                    <span>Usage</span>
                    <span>Unknown</span>
                  </div>
                  <div className="setting-row">
                    <span>Last checked</span>
                    <span>
                      {c.checkedAt ? new Date(c.checkedAt).toLocaleString() : 'Not checked'}
                    </span>
                  </div>
                </div>
              </details>
              <p>{c.detail}</p>
              <div className="actions">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={(!usable && !on) || busy}
                    onChange={(e) => void toggle(engine, e.target.checked)}
                  />
                  {on ? 'On' : 'Off'}
                </label>
                <Button
                  tone="quiet"
                  disabled={
                    checking[engine] ||
                    discovering ||
                    statusLoading ||
                    busy ||
                    c.compatibility !== 'supported'
                  }
                  onClick={() => void check(engine)}
                >
                  {checking[engine] ? 'Checking…' : 'Check sign-in and models'}
                </Button>
              </div>
              {usable && (
                <div className="actions">
                  <select
                    aria-label={`${name} model`}
                    value={chosen}
                    disabled={selecting[engine] || busy}
                    onChange={(e) => setChoices((prev) => ({ ...prev, [engine]: e.target.value }))}
                  >
                    {c.models.map((m) => (
                      <option key={m.slug} value={m.slug} title={m.description}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={!chosen || selecting[engine] || busy}
                    onClick={() => void useAsDefault(engine, chosen)}
                  >
                    {selecting[engine] ? 'Saving…' : 'Use as default'}
                  </Button>
                </div>
              )}
              {c.installation === 'missing' && !installing[engine] && (
                <div className="ai-offer">
                  {offer === undefined ? (
                    <div className="actions">
                      <Button
                        tone="quiet"
                        disabled={offerLoading[engine] || busy}
                        onClick={() => void loadOffer(engine)}
                      >
                        {offerLoading[engine] ? 'Reading…' : `Install ${name}`}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="setting-rows">
                        <div className="setting-row">
                          <span>Publisher</span>
                          <span>{offer.publisher}</span>
                        </div>
                        <div className="setting-row">
                          <span>Source</span>
                          {offer.source.startsWith('http') ? (
                            <a href={offer.source}>{offer.source}</a>
                          ) : (
                            <span>{offer.source}</span>
                          )}
                        </div>
                        <div className="setting-row">
                          <span>Version</span>
                          <span>{offer.version}</span>
                        </div>
                        <div className="setting-row">
                          <span>Destination</span>
                          <span>{offer.destination}</span>
                        </div>
                        <div className="setting-row">
                          <span>Dependencies</span>
                          <span>
                            {offer.dependencies.length > 0
                              ? offer.dependencies.join(', ')
                              : 'None listed'}
                          </span>
                        </div>
                        <div className="setting-row">
                          <span>Privileges</span>
                          <span>{offer.privileges}</span>
                        </div>
                        <div className="setting-row">
                          <span>Account</span>
                          <span>{offer.account}</span>
                        </div>
                      </div>
                      <p>{offer.detail}</p>
                      <div className="actions">
                        <Button disabled={busy || !offer.available} onClick={() => void install(engine)}>
                          Install selected tool
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {installing[engine] && (
                <div className="actions">
                  <Button tone="quiet" onClick={() => cancelInstall(engine)}>
                    Cancel installation
                  </Button>
                </div>
              )}
              {c.compatibility === 'supported' && c.authentication !== 'signed-in' && (
                <>
                  <div className="actions">
                    <Button
                      tone="quiet"
                      disabled={loginBusy[engine] || busy || c.compatibility !== 'supported'}
                      onClick={() => void login(engine)}
                    >
                      {loginBusy[engine]
                        ? 'Opening…'
                        : engine === 'oh-my-pi'
                          ? 'Configure OpenAI API access'
                          : `Sign in with ${name}`}
                    </Button>
                  </div>
                  {engine === 'oh-my-pi' ? (
                    <p className="caption">
                      Open the separate native profile and edit models.yml with a literal API key
                      using the{' '}
                      <a
                        target="_blank"
                        rel="noreferrer"
                        href="https://github.com/can1357/oh-my-pi/blob/v18.0.6/docs/models.md#auth-and-api-key-resolution-order"
                      >
                        OMP instructions
                      </a>
                      .{' '}
                      <a
                        target="_blank"
                        rel="noreferrer"
                        href="https://platform.openai.com/api-keys"
                      >
                        OpenAI API billing
                      </a>{' '}
                      is separate from ChatGPT. Diomedes creates an empty template only if missing
                      and never reads your key. Rechecking verifies local configuration; provider
                      access remains untested until you send a request.
                    </p>
                  ) : (
                    <p className="caption">
                      Sign-in runs in the provider's own tool in your terminal. Diomedes never asks
                      for provider secrets.
                    </p>
                  )}
                  {loginDetail[engine] !== undefined && (
                    <>
                      <p>{loginDetail[engine]}</p>
                      {engine !== 'oh-my-pi' && (
                        <Button
                          tone="quiet"
                          onClick={() => {
                            void api<{ detail: string }>(`/ai/login/${engine}/cancel`, 'POST', {})
                              .then((result) =>
                                setLoginDetail((prev) => ({ ...prev, [engine]: result.detail })),
                              )
                              .catch((error) => fail(engine, error));
                          }}
                        >
                          Close sign-in window
                        </Button>
                      )}
                    </>
                  )}
                </>
              )}
              {error !== null && error !== undefined && (
                <p className="ai-alert" role="alert">
                  {error}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default function AISetup({ settings, save, busy, onContinue, onBack }: AISetupProps) {
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const skipping = useRef(false);

  async function skip(): Promise<void> {
    // Advance the step exactly once: a second click while the save is in
    // flight must not write the onboarding transition a second time.
    if (skipping.current || busy) return;
    skipping.current = true;
    setSkipBusy(true);
    setSkipError(null);
    try {
      // Records the skip explicitly so the ready step never claims a usable
      // service that was never connected.
      await save(advanceSetup(settings, true));
    } catch (error) {
      skipping.current = false;
      setSkipBusy(false);
      setSkipError(messageOf(error));
    }
  }

  const locked = busy === true || skipBusy;
  return (
    <div className="ai-setup">
      <h1>Connect an AI service</h1>
      <AIConnections settings={settings} save={save} busy={busy} />
      {skipError !== null && (
        <p className="ai-alert" role="alert">
          {skipError}
        </p>
      )}
      <div className="setup-actions">
        <Button tone="quiet" disabled={locked} onClick={onBack}>
          Back
        </Button>
        <Button tone="quiet push-right" disabled={locked} onClick={() => void skip()}>
          {skipBusy ? 'Skipping…' : 'Skip AI setup'}
        </Button>
        <Button tone="primary" disabled={locked} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
