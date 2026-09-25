import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../shared/types';
import type { ExternalEngine } from '../shared/types';
import type { ConnectionReceipt, EngineConnection, InstallOffer } from '../shared/engines';
import { ENGINE_NAMES, EXTERNAL_ENGINES, TEXT_ROUTE_CONTROLS } from '../shared/engines';
import { ENGINE_ROUTE_PROFILES, routeCaption } from '../shared/engine-routes';
import { AwsBedrockSetup } from './AwsBedrockSetup';
import { AzureOpenAISetup, OpenRouterSetup } from './ProviderSetup';
import { GoogleVertexSetup } from './VertexSetup';
import { TierSetup } from './TierSetup';
import { CodexSetup } from './CodexSetup';
import {
  advanceSetup,
  continueChoice,
  continueLabel,
  continueNote,
} from '../shared/onboarding';
import type { AttemptFailure, SignInWatch } from './ai-setup-state';
import {
  SIGN_IN_POLL_MS,
  advanceWatches,
  attemptFailure,
  attemptSentence,
  attemptStage,
  benignConflict,
  checkedSentence,
  compatibilityText,
  discoveryOutcome,
  NO_ENGINES_FOUND,
  connected,
  contextText,
  firstTaskHandoff,
  installationConflict,
  placeholderConnection,
  primaryControl,
  provenanceText,
  repairNote,
  routeIssueSentences,
  setupStates,
  showsCandidates,
  signInSentence,
  signingIn,
  sourceText,
  verified,
  verifiedSentence,
} from './ai-setup-state';
import { ApiError, api, selectEngineModel, setEngineEnabled } from './api';
import { Button } from './components';
import './ai-setup.css';

const DISCLOSURE =
  'Nectovia checks installed tools, versions, sign-in status, and model lists on this computer. ' +
  'Short-lived checks do not send model prompts, install tools, or open sign-in pages.';

/**
 * The private compatible copy, said once, wherever it is offered. It is an
 * addition, never a change to what the person already installed.
 */
const PRIVATE_COPY =
  'This copy belongs to Nectovia alone. It does not change, downgrade or remove your own ' +
  'installation, and it does not change PATH.';

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The request could not be completed.';
}

/**
 * The host's own account of a failed action: its message, its code, whether it
 * may already have reached the provider, and the stage it stopped at. The stage
 * travels with the error, so nothing has to re-read status to find it.
 */
function failureOf(error: unknown): AttemptFailure {
  return attemptFailure(messageOf(error), error instanceof ApiError ? error.data : null);
}

const timeOf = (value: string) => new Date(value).toLocaleTimeString();
const dateTimeOf = (value: string) => new Date(value).toLocaleString();

export interface AIConnectionProps {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  busy?: boolean;
  /** The rows this component read, for a screen that must describe them. */
  onConnections?: (connections: EngineConnection[]) => void;
  /**
   * Open one route's test consent from outside the card. It reveals the same
   * panel the card's own control reveals; the request is still the explicit
   * second click inside it.
   */
  openTest?: { engine: ExternalEngine; at: number } | null;
  /**
   * Leave this screen and start a first task on a route the host still calls
   * ready. Absent in onboarding, where Continue already advances the step, and
   * then no control is drawn at all.
   */
  onStartFirstTask?: (route: ExternalEngine, model: string, effort: string | null) => void;
}

export interface AISetupProps extends AIConnectionProps {
  onContinue: () => void;
  onBack: () => void;
}

export function AIConnections({
  settings,
  save,
  busy,
  onConnections,
  openTest,
  onStartFirstTask,
}: AIConnectionProps) {
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
  const [installsOpen, setInstallsOpen] = useState<Record<string, boolean>>({});
  const [binding, setBinding] = useState<Record<string, boolean>>({});
  const [testOpen, setTestOpen] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [receipts, setReceipts] = useState<Record<string, ConnectionReceipt | undefined>>({});
  const [testFailure, setTestFailure] = useState<Record<string, AttemptFailure | undefined>>({});
  const [loginBusy, setLoginBusy] = useState<Record<string, boolean>>({});
  const [loginDetail, setLoginDetail] = useState<Record<string, string>>({});
  // The host's own account of the last failed action on this route, kept as
  // what it was rather than as a sentence: which code arrived decides what the
  // card does about it, and a string has thrown that away.
  const [opError, setOpError] = useState<Record<string, AttemptFailure | null>>({});
  const [progress, setProgress] = useState<string | null>('Loading connections…');
  // What each route is waiting on: a sign-in window Diomedes opened, or the
  // host's own check after that window ended. Derived from `signInWindow` and
  // `checkedAt` alone, so a closed window never reads as an account.
  const [watches, setWatches] = useState<Record<string, SignInWatch>>({});
  const mounted = useRef(true);
  const inFlight = useRef(new Set<AbortController>());
  const installControllers = useRef(new Map<string, AbortController>());
  const watched = useRef<string[]>([]);
  const sections = useRef<Record<string, HTMLElement | null>>({});

  /**
   * What a failure means for this card, wherever it arrived from.
   *
   * The host throws `BINDING_CHANGED` from the check and from the model
   * selection as well as from the test, and it throws `ACCOUNT_ROUTE` from the
   * selection. Both used to be answered only inside `test()`, so every other
   * action that could receive them showed a red banner with the installations
   * shut and the account-route explanation the card already owns unused.
   */
  function answer(engine: string, failure: AttemptFailure): void {
    if (!mounted.current) return;
    // The bound installation is not the one that was bound. That is answered
    // among the installations, never by signing in again, so open them.
    if (installationConflict(failure)) setInstallsOpen((prev) => ({ ...prev, [engine]: true }));
    // Both of these say the record this card is drawn from is out of date: one
    // about the installation, one about the account this route reached. So it
    // is read again, which is also what fills the installations the line above
    // just opened and the account-route explanation the card already owns.
    if (installationConflict(failure) || failure.code === 'ACCOUNT_ROUTE') void refreshStatus();
  }

  function fail(engine: string, error: unknown): void {
    const failure = failureOf(error);
    if (mounted.current) setOpError((prev) => ({ ...prev, [engine]: failure }));
    answer(engine, failure);
  }

  /** Fold one or more host answers into what each route is waiting on. */
  const watch = useCallback((rows: readonly EngineConnection[]) => {
    setWatches((prev) => advanceWatches(prev, rows, Date.now()));
  }, []);

  /** Replace one row from a route that answered with the whole connection. */
  const apply = useCallback(
    (updated: EngineConnection): void => {
      setConnections((prev) =>
        prev === null ? [updated] : prev.map((c) => (c.engine === updated.engine ? updated : c)),
      );
      watch([updated]);
    },
    [watch],
  );

  const refreshStatus = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await api<{ connections: EngineConnection[] }>(
          '/ai/status',
          'GET',
          undefined,
          signal,
        );
        if (!mounted.current) return;
        setConnections(result.connections);
        watch(result.connections);
        setStatusError(null);
      } catch (error) {
        if (signal?.aborted || !mounted.current) return;
        setStatusError(messageOf(error));
      }
    },
    [watch],
  );

  // Initial mount reports status only. Discovery is never started here, and
  // neither is a provider test.
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

  // While a window is open, or its check has not landed, read status on a
  // timer. The timer exists only for as long as something is waiting on it, and
  // the unmount above stops the reads it starts.
  //
  // A route that gave up waiting stays in the map so the same window cannot
  // start it over, so what keeps this timer alive is a live wait, not an entry.
  const waiting = Object.values(watches).some(signingIn);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      // The clock first, and on its own rows. The budget is time, so a
      // `GET /ai/status` that keeps failing — and never reaches the fold on its
      // success path — must not be what decides how long the card waits.
      setWatches((prev) => advanceWatches(prev, [], Date.now()));
      void refreshStatus();
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refreshStatus]);

  // A route that stopped waiting keeps no caption about a window that has since
  // closed. A route that never opened one — the separate OMP profile — keeps
  // the instructions it was given.
  useEffect(() => {
    const open = Object.entries(watches)
      .filter(([, watch]) => signingIn(watch))
      .map(([engine]) => engine);
    const settled = watched.current.filter((engine) => !open.includes(engine));
    watched.current = open;
    if (settled.length === 0) return;
    setLoginDetail((prev) => {
      if (!settled.some((engine) => engine in prev)) return prev;
      const next = { ...prev };
      for (const engine of settled) delete next[engine];
      return next;
    });
  }, [watches]);

  // The rows this card read, for a screen that must say what continuing does.
  useEffect(() => {
    if (connections !== null) onConnections?.(connections);
  }, [connections, onConnections]);

  // The same consent panel the card's own control reveals, asked for from the
  // decision point at the bottom of the setup screen.
  useEffect(() => {
    if (!openTest) return;
    setTestOpen((prev) => ({ ...prev, [openTest.engine]: true }));
    sections.current[openTest.engine]?.scrollIntoView({ block: 'nearest' });
  }, [openTest]);

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
      watch(result.connections);
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
      apply(updated);
      await refreshStatus(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      // A check that collided with the one the host runs for itself when a
      // sign-in window ends is not a failure. The host's check is the answer,
      // and it is already on its way.
      if (benignConflict(failureOf(error))) return;
      fail(engine, error);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setChecking((prev) => ({ ...prev, [engine]: false }));
        setProgress(null);
      }
    }
  }

  /**
   * The switch names one key. It is sent as that one key, and the server merges
   * it into whatever is stored under the store's lock, so pressing this and
   * "Use as default" in quick succession cannot lose either write.
   *
   * Nothing is written back from here. Echoing the response as a whole-object
   * PUT would re-open the very race this route closes: two responses landing in
   * the same tick share one recorded hash, so the slower continuation could
   * still overwrite the faster write with its own older whole object. The
   * server publishes `settings` when it saves, the app re-reads on that event,
   * and the screen shows the settings the server stored.
   */
  async function toggle(engine: ExternalEngine, on: boolean): Promise<void> {
    setOpError((prev) => ({ ...prev, [engine]: null }));
    try {
      await setEngineEnabled(engine, on);
      // The switch is one of the facts the host's next action rests on, so the
      // record is read again rather than guessed at here.
      await refreshStatus();
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
      // The server has already written this under its lock, and publishes the
      // saved settings. As with the switch, nothing is written back from here.
      await selectEngineModel(engine, model, controller.signal);
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
    setProgress(`Installing the compatible copy of ${ENGINE_NAMES[engine]}…`);
    try {
      await api(`/ai/install/${engine}`, 'POST', { consent: true }, controller.signal);
      if (!mounted.current) return;
      await refreshStatus(controller.signal);
    } catch (error) {
      if (!mounted.current) return;
      if (controller.signal.aborted) {
        setOpError((prev) => ({ ...prev, [engine]: attemptFailure('Installation cancelled.') }));
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

  /**
   * Bind one installation the host itself observed. A candidate id is the only
   * thing sent; a path from this screen is never bound.
   */
  async function bind(engine: ExternalEngine, candidateId: string): Promise<void> {
    if (binding[engine]) return;
    const controller = new AbortController();
    inFlight.current.add(controller);
    setBinding((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    setProgress(`Selecting an installation for ${ENGINE_NAMES[engine]}…`);
    try {
      const updated = await api<EngineConnection>(
        '/ai/bind',
        'POST',
        { engine, candidateId },
        controller.signal,
      );
      if (!mounted.current) return;
      apply(updated);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      fail(engine, error);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setBinding((prev) => ({ ...prev, [engine]: false }));
        setProgress(null);
      }
    }
  }

  /**
   * One real request, and only on an explicit second click. Nothing here runs
   * on a scan, on a finished sign-in, or on reopening Settings.
   */
  async function test(engine: ExternalEngine, model: string): Promise<void> {
    if (testing[engine] || !model) return;
    const controller = new AbortController();
    inFlight.current.add(controller);
    setTesting((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    setTestFailure((prev) => ({ ...prev, [engine]: undefined }));
    setProgress(`Sending one test request through ${ENGINE_NAMES[engine]}…`);
    try {
      const result = await api<{ receipt: ConnectionReceipt; connection: EngineConnection }>(
        `/ai/test/${engine}`,
        'POST',
        { consent: true, model },
        controller.signal,
      );
      if (!mounted.current) return;
      setReceipts((prev) => ({ ...prev, [engine]: result.receipt }));
      apply(result.connection);
      setTestOpen((prev) => ({ ...prev, [engine]: false }));
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      const failure = failureOf(error);
      setTestFailure((prev) => ({ ...prev, [engine]: failure }));
      setTestOpen((prev) => ({ ...prev, [engine]: false }));
      // The same handler every other action passes through. This one keeps its
      // own message beside the test rather than in the card's banner.
      answer(engine, failure);
      // The stage travelled with the error. Status is read back for what the
      // record now says about the route, not to discover where it stopped.
      await refreshStatus(controller.signal);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) {
        setTesting((prev) => ({ ...prev, [engine]: false }));
        setProgress(null);
      }
    }
  }

  async function login(engine: ExternalEngine): Promise<void> {
    const controller = new AbortController();
    // The person asking again is what begins a new wait. A route whose last
    // wait was given up on keeps that state until this click or until a check
    // answers, so nothing else can arm the gate on their behalf.
    setWatches((prev) => {
      if (!(engine in prev)) return prev;
      const next = { ...prev };
      delete next[engine];
      return next;
    });
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
      // A finished sign-in process is not proof of the right account, so the
      // record is read again rather than assumed.
      await refreshStatus(controller.signal);
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

  /**
   * Close the window Diomedes opened. The host still runs its own check when
   * the window ends, so this asks for nothing beyond the close.
   */
  async function closeSignIn(engine: ExternalEngine): Promise<void> {
    if (loginBusy[engine]) return;
    const controller = new AbortController();
    inFlight.current.add(controller);
    setLoginBusy((prev) => ({ ...prev, [engine]: true }));
    setOpError((prev) => ({ ...prev, [engine]: null }));
    try {
      await api<{ detail: string }>(
        `/ai/login/${engine}/cancel`,
        'POST',
        {},
        controller.signal,
      );
      if (!mounted.current) return;
      await refreshStatus(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      fail(engine, error);
    } finally {
      inFlight.current.delete(controller);
      if (mounted.current) setLoginBusy((prev) => ({ ...prev, [engine]: false }));
    }
  }

  const nowMs = Date.now();
  const byEngine = new Map((connections ?? []).map((c) => [c.engine, c]));
  const rows = EXTERNAL_ENGINES.map((engine) => byEngine.get(engine) ?? placeholderConnection(engine));
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
      {connections !== null && !discovering && (connections.length === 0 || discoveryOutcome(rows)) && (
        <p className="ai-alert" role="status" data-testid="no-engines-found">
          {NO_ENGINES_FOUND}
        </p>
      )}
      <div className="service-list">
        {rows.map((c) => {
          const engine = c.engine;
          const name = ENGINE_NAMES[engine];
          const profile = ENGINE_ROUTE_PROFILES[engine];
          const primary = primaryControl(c, name);
          const states = setupStates(c);
          const usable = connected(c);
          const raw = services[engine];
          const on = raw === true;
          const savedModel = services[`${engine}Model`];
          const storedModel =
            typeof savedModel === 'string' && c.models.some((m) => m.slug === savedModel)
              ? savedModel
              : '';
          const chosen = choices[engine] ?? (storedModel || c.models[0]?.slug || '');
          // A receipt verifies the route a run would take, so the model tested
          // is the model this route is set to use — never whatever the select
          // happens to be showing. Until one is saved there is nothing to
          // verify, and the host refuses the request anyway.
          const testModel = storedModel;
          const offer = offers[engine];
          const error = opError[engine];
          const repair = repairNote(c);
          // A refused account route is not a red banner: this card already has
          // the words for it, and they say which account this route uses and
          // that Diomedes substitutes nothing for it. Until the record catches
          // up, the host's own sentence goes in the same calm place.
          const routeRefused = error?.code === 'ACCOUNT_ROUTE';
          const reported = routeIssueSentences(c, name);
          const issue = reported.length > 0 ? reported : routeRefused ? [error.message] : [];
          const candidates = c.candidates ?? [];
          const showInstalls = showsCandidates(c) || primary.intent === 'choose';
          const offering = primary.intent === 'install';
          const receipt = receipts[engine];
          // Read from the host's record, never from the click that just
          // returned: a route the host still calls ready offers the same
          // handoff on a fresh Settings open, and one whose binding, account
          // route or model has moved since its receipt offers none.
          const handoff = firstTaskHandoff(c, storedModel);
          const failure = testFailure[engine];
          const stopped = attemptStage(failure, c);
          // A sign-in window Diomedes opened, or the host's own check after it
          // ended. While either is true the card offers no next action of its
          // own: the window is finished in the window, and the check answers.
          const openWindow = watches[engine];
          const holding = signingIn(openWindow);
          const busyRow = busy || discovering || statusLoading;
          return (
            <section
              className="service"
              key={engine}
              aria-label={name}
              ref={(element) => {
                sections.current[engine] = element;
              }}
            >
              <div className="row">
                <h3>{name}</h3>
                {defaultEngine === engine && <span className="caption push-right">Default</span>}
              </div>
              <p className="caption ai-route">{routeCaption(engine)}</p>
              <ul className="ai-states" aria-label={`${name} setup state`}>
                {states.map((state) => (
                  <li className={`ai-state is-${state.value}`} data-state={state.key} key={state.key}>
                    <span className="ai-state-label">{state.label}</span>
                    <span className="ai-state-value">{state.text}</span>
                  </li>
                ))}
              </ul>
              {c.checkedAt !== null && (
                <p className="caption ai-checked">{checkedSentence(c, nowMs, timeOf)}</p>
              )}
              {c.verification && (
                <p className="caption ai-verified">{verifiedSentence(c, dateTimeOf)}</p>
              )}
              <p>{c.detail}</p>
              {repair !== '' && <p className="ai-note">{repair}</p>}
              {issue.length > 0 && (
                <div className="ai-note ai-route-issue">
                  {issue.map((sentence) => (
                    <p key={sentence}>{sentence}</p>
                  ))}
                </div>
              )}
              {stopped && <p className="ai-note">{attemptSentence(stopped)}</p>}
              {/* Kept mounted so a change is announced, and empty when there is
                  nothing to announce. */}
              <p className="caption ai-signin" role="status" aria-live="polite">
                {signInSentence(openWindow, name)}
              </p>
              {openWindow?.state === 'open' && (
                <div className="actions">
                  <Button
                    tone="quiet"
                    disabled={busy || loginBusy[engine]}
                    onClick={() => void closeSignIn(engine)}
                  >
                    {loginBusy[engine] ? 'Closing…' : 'Close sign-in window'}
                  </Button>
                </div>
              )}
              <div className="actions">
                {!holding && primary.intent !== 'none' && (
                  <Button
                    tone="primary"
                    disabled={
                      busyRow ||
                      checking[engine] ||
                      installing[engine] ||
                      binding[engine] ||
                      testing[engine] ||
                      loginBusy[engine]
                    }
                    onClick={() => {
                      if (primary.intent === 'check') void check(engine);
                      else if (primary.intent === 'sign-in') void login(engine);
                      else if (primary.intent === 'enable') void toggle(engine, true);
                      else if (primary.intent === 'choose')
                        setInstallsOpen((prev) => ({ ...prev, [engine]: true }));
                      else if (primary.intent === 'install') {
                        if (offer === undefined) void loadOffer(engine);
                      } else if (primary.intent === 'test')
                        setTestOpen((prev) => ({ ...prev, [engine]: true }));
                    }}
                  >
                    {primary.intent === 'check' && checking[engine]
                      ? 'Checking…'
                      : primary.intent === 'install' && offerLoading[engine]
                        ? 'Reading…'
                        : primary.intent === 'test' && failure
                          ? 'Retry the test'
                          : primary.label}
                  </Button>
                )}
                {!holding && primary.intent !== 'check' && (
                  <Button
                    tone="quiet"
                    disabled={busyRow || checking[engine]}
                    onClick={() => void check(engine)}
                  >
                    {checking[engine] ? 'Checking…' : 'Check sign-in and models'}
                  </Button>
                )}
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={(!usable && !on) || busy}
                    onChange={(e) => void toggle(engine, e.target.checked)}
                  />
                  {on ? 'On' : 'Off'}
                </label>
              </div>
              {usable && (
                <div className="actions">
                  <select
                    aria-label={`${name} model`}
                    value={chosen}
                    disabled={selecting[engine] || busy}
                    onChange={(e) => {
                      // Read now, not inside the updater: the updater can run
                      // after this handler has returned and the event has been
                      // cleared, and a render that throws takes the app down.
                      const slug = e.target.value;
                      setChoices((prev) => ({ ...prev, [engine]: slug }));
                    }}
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
              {offering && offer !== undefined && !installing[engine] && (
                <div className="ai-offer">
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
                  <p className="ai-note">{PRIVATE_COPY}</p>
                  <div className="actions">
                    <Button
                      tone="primary"
                      disabled={busy || !offer.available}
                      onClick={() => void install(engine)}
                    >
                      {primary.action === 'repair' ? 'Repair this installation' : 'Install this copy'}
                    </Button>
                    <Button
                      tone="quiet"
                      onClick={() => setOffers((prev) => ({ ...prev, [engine]: undefined }))}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {installing[engine] && (
                <div className="actions">
                  <Button tone="quiet" onClick={() => cancelInstall(engine)}>
                    Cancel installation
                  </Button>
                </div>
              )}
              {showInstalls && (
                <details
                  className="ai-candidates"
                  open={installsOpen[engine] === true}
                  onToggle={(e) => {
                    // React clears the event's currentTarget once this handler
                    // returns, and the updater below can run later than that.
                    // Reading it in there threw during render and, with no
                    // boundary above this screen, emptied the window.
                    const open = e.currentTarget.open;
                    setInstallsOpen((prev) => ({ ...prev, [engine]: open }));
                  }}
                >
                  <summary>{`Installations on this computer (${candidates.length})`}</summary>
                  {candidates.length === 0 ? (
                    <p className="caption">
                      Nectovia has no guided installer for this route on this computer. Install{' '}
                      {name} yourself, then check again.
                    </p>
                  ) : (
                    <ul className="ai-candidate-list">
                      {candidates.map((candidate) => {
                        const bound = c.binding?.id === candidate.id;
                        return (
                          <li className="ai-candidate" key={candidate.id}>
                            <div className="row ai-candidate-head">
                              <span className="ai-candidate-source">
                                {sourceText(candidate.source)}
                              </span>
                              <span className="caption">{candidate.version}</span>
                              <span className="caption">
                                {compatibilityText(candidate.compatibility)}
                              </span>
                              <span className="caption">{contextText(candidate.context)}</span>
                              {bound && <span className="caption">In use</span>}
                              {!bound && c.recommendedCandidateId === candidate.id && (
                                <span className="caption">Recommended</span>
                              )}
                            </div>
                            <p className="caption">{provenanceText(candidate.provenance)}</p>
                            <p className="code caption ai-path" title={candidate.path}>
                              {candidate.path}
                            </p>
                            {candidate.issue && <p className="caption">{candidate.issue}</p>}
                            {!bound && (
                              <div className="actions">
                                <Button
                                  tone="quiet"
                                  disabled={busyRow || binding[engine] || !candidate.present}
                                  onClick={() => void bind(engine, candidate.id)}
                                >
                                  Use this installation
                                </Button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </details>
              )}
              {usable && !holding && (
                <div className="ai-test">
                  {testOpen[engine] === true ? (
                    <>
                      <p>
                        {testModel === ''
                          ? `Choose this route's model with Use as default before testing it.`
                          : `This sends one small synthetic request through ${profile.routeLabel} using ${testModel}. It may use that service's allowance or add provider charges.`}
                      </p>
                      <div className="actions">
                        {testModel !== '' && (
                          <Button
                            tone="primary"
                            disabled={busy || testing[engine]}
                            onClick={() => void test(engine, testModel)}
                          >
                            {testing[engine] ? 'Testing…' : 'Send the test request'}
                          </Button>
                        )}
                        <Button
                          tone="quiet"
                          disabled={testing[engine]}
                          onClick={() => setTestOpen((prev) => ({ ...prev, [engine]: false }))}
                        >
                          Cancel
                        </Button>
                      </div>
                    </>
                  ) : (
                    primary.intent !== 'test' && (
                      <div className="actions">
                        <Button
                          tone="quiet"
                          disabled={busy || testing[engine]}
                          onClick={() => setTestOpen((prev) => ({ ...prev, [engine]: true }))}
                        >
                          {failure ? 'Retry the test' : 'Test this connection'}
                        </Button>
                      </div>
                    )
                  )}
                </div>
              )}
              {receipt && verified(c) && (
                <p className="ai-note" role="status">
                  Test succeeded {dateTimeOf(receipt.verifiedAt)} on {receipt.model}.
                </p>
              )}
              {handoff && onStartFirstTask && (
                <>
                  <p className="caption">
                    This chooses {handoff.model} on {profile.routeLabel} for the thread you land in.
                    Nothing is sent until you write a task and send it.
                  </p>
                  <div className="actions">
                    <Button
                      tone="primary"
                      disabled={busyRow || testing[engine]}
                      onClick={() =>
                        onStartFirstTask(
                          handoff.route,
                          handoff.model,
                          c.models.find((m) => m.slug === handoff.model)?.defaultEffort ?? null,
                        )
                      }
                    >
                      Start a first task
                    </Button>
                  </div>
                </>
              )}
              {failure && (
                <div className="ai-test-failure">
                  <p className="ai-alert" role="alert">
                    {failure.message}
                  </p>
                  {failure.ambiguous && (
                    <p className="caption">
                      This request may already have reached the provider. A retry may be billed
                      again.
                    </p>
                  )}
                </div>
              )}
              {/* What the host said when the sign-in started, for a route that
                  opened no window of its own to describe — the separate OMP
                  profile. A window that is open says so once, above. */}
              {!holding && loginDetail[engine] !== undefined && <p>{loginDetail[engine]}</p>}
              {!holding &&
                primary.intent === 'sign-in' &&
                (engine === 'oh-my-pi' ? (
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
                    <a target="_blank" rel="noreferrer" href="https://platform.openai.com/api-keys">
                      OpenAI API billing
                    </a>{' '}
                    is separate from ChatGPT. Nectovia creates an empty template only if missing and
                    never reads your key.
                  </p>
                ) : (
                  <p className="caption">
                    {engine === 'devin'
                      ? 'Sign-in opens the Devin browser flow.'
                      : "Sign-in runs in the provider's own tool in your terminal."}{' '}
                    Nectovia never asks for provider secrets.
                  </p>
                ))}
              <details className="ai-connection-details">
                <summary>Details</summary>
                <div className="setting-rows">
                  <div className="setting-row">
                    <span>Installation</span>
                    <span>
                      {c.binding
                        ? sourceText(c.binding.source)
                        : c.location
                          ? 'Found on this computer'
                          : 'Not selected'}
                    </span>
                  </div>
                  {(c.binding?.path ?? c.location) && (
                    <div className="setting-row">
                      <span>Path</span>
                      <span className="ai-path">{c.binding?.path ?? c.location}</span>
                    </div>
                  )}
                  <div className="setting-row">
                    <span>Version</span>
                    <span>{c.binding?.version ?? c.version ?? 'Not reported'}</span>
                  </div>
                  <div className="setting-row">
                    <span>Account route</span>
                    <span>{c.accountRoute ?? 'Not detected'}</span>
                  </div>
                  <div className="setting-row">
                    <span>Selected model</span>
                    <span>{storedModel || 'None saved'}</span>
                  </div>
                  <div className="setting-row">
                    <span>Task scope</span>
                    <span>
                      {profile.taskScope}. {profile.limits}
                    </span>
                  </div>
                  <div className="setting-row">
                    <span>Permission scope</span>
                    <span>
                      {TEXT_ROUTE_CONTROLS.filter((row) => row.level === 'enforced')
                        .map((row) => row.control)
                        .join(', ')}
                    </span>
                  </div>
                  {profile.billing !== '' && (
                    <div className="setting-row">
                      <span>Billing</span>
                      <span>{profile.billing}</span>
                    </div>
                  )}
                  {profile.reuses.length > 0 && (
                    <div className="setting-row">
                      <span>Reused from your setup</span>
                      {/* Entries carry their own commas, so a comma cannot separate them. */}
                      <span>{profile.reuses.join('; ')}</span>
                    </div>
                  )}
                  {profile.doesNotReuse.length > 0 && (
                    <div className="setting-row">
                      <span>Not carried over</span>
                      <span>{profile.doesNotReuse.join('; ')}</span>
                    </div>
                  )}
                  <div className="setting-row">
                    <span>Usage</span>
                    <span>Unknown</span>
                  </div>
                </div>
              </details>
              {error !== null && error !== undefined && !routeRefused && (
                <p className="ai-alert" role="alert">
                  {error.message}
                </p>
              )}
            </section>
          );
        })}
        {/* Model-API routes: the company's own provider accounts, not installed engines. */}
        <AwsBedrockSetup settings={settings} save={save} busy={busy} />
        <AzureOpenAISetup settings={settings} save={save} busy={busy} />
        <OpenRouterSetup settings={settings} save={save} busy={busy} />
        <GoogleVertexSetup settings={settings} save={save} busy={busy} />
        {/* The owner's tier map: the one place that decides which route serves each tier. */}
        <TierSetup settings={settings} save={save} busy={busy} />
      </div>
    </div>
  );
}

export default function AISetup({ settings, save, busy, onContinue, onBack }: AISetupProps) {
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const [connections, setConnections] = useState<EngineConnection[]>([]);
  const [openTest, setOpenTest] = useState<{ engine: ExternalEngine; at: number } | null>(null);
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
  // What continuing actually does. Three different things, and the control and
  // its one sentence say which: a route that answered a real request, a route
  // that is selected and has answered nothing yet, or the scripted local
  // sample. Continuing is never blocked; only described.
  const verifiedRoutes = connections.filter(verified).map((c) => c.engine);
  const choice = continueChoice(settings, verifiedRoutes);
  const defaultEngine = settings.services?.['defaultEngine'];
  const selected = connections.find((c) => c.engine === defaultEngine);
  // The untested route can be tested from here, in the card that owns the test.
  // A test verifies the model the route is set to use, so a route with no saved
  // model has nothing to verify yet and is not offered one.
  const testable =
    choice === 'untested' &&
    selected !== undefined &&
    connected(selected) &&
    typeof settings.services?.[`${selected.engine}Model`] === 'string';
  return (
    <div className="ai-setup">
      <h1>Connect an AI service</h1>
      <CodexSetup settings={settings} save={save} busy={busy} />
      <AIConnections
        settings={settings}
        save={save}
        busy={busy}
        onConnections={setConnections}
        openTest={openTest}
      />
      {skipError !== null && (
        <p className="ai-alert" role="alert">
          {skipError}
        </p>
      )}
      <p className="caption">{continueNote(choice)}</p>
      <div className="setup-actions">
        <Button tone="quiet" disabled={locked} onClick={onBack}>
          Back
        </Button>
        {testable && selected && (
          <Button
            tone="quiet"
            disabled={locked}
            onClick={() => setOpenTest({ engine: selected.engine, at: Date.now() })}
          >
            Test this connection
          </Button>
        )}
        <Button tone="quiet push-right" disabled={locked} onClick={() => void skip()}>
          {skipBusy ? 'Skipping…' : 'Skip AI setup'}
        </Button>
        <Button tone="primary" disabled={locked} onClick={onContinue}>
          {continueLabel(choice)}
        </Button>
      </div>
    </div>
  );
}
