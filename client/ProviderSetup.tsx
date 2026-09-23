import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  AzureConnectionView,
  ModelApiReadiness,
  OpenRouterConnectionView,
} from '../shared/model-api';
import type { Settings } from '../shared/types';
import { AGENT_NAME } from '../shared/agent-name';
import { routeDisplayName } from '../shared/engines';
import { ApiError, api } from './api';
import { awsLimitBody, holdSentence, usd } from './aws-bedrock-view';
import {
  azureConnectBody,
  azureInputFrom,
  emptyAzureDeployment,
  emptyOpenRouterModel,
  openRouterConnectBody,
  openRouterInputFrom,
  providerIsDefault,
  providerStateRows,
  readinessLines,
  type AzureDeploymentInput,
  type OpenRouterModelInput,
  type ProviderView,
  type RatesInput,
} from './provider-setup-view';
import { Button } from './components';

const messageOf = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.';

interface CardProps {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  busy?: boolean;
}

/**
 * The part of a model-API route's setup card every route shares: the state rows, the
 * offline readiness check, the spend limit, each paid call and the route's own actions.
 * The connection form is the route's own and arrives as `form`.
 */
function useProviderCard<V extends ProviderView>(route: V['route']) {
  const base = `/ai/model-api/${route}`;
  const [view, setView] = useState<V | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setView(await api<V>(base, 'GET', undefined, signal));
        setError('');
      } catch (reason) {
        if (!signal?.aborted) setError(messageOf(reason));
      }
    },
    [base],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const run = async (action: () => Promise<V | void>): Promise<boolean> => {
    setWorking(true);
    setError('');
    try {
      const next = await action();
      if (next) setView(next);
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      setWorking(false);
    }
  };
  return { route, base, view, error, setError, working, run, load };
}

type Card<V extends ProviderView> = ReturnType<typeof useProviderCard<V>>;

function ProviderCard<V extends ProviderView>({
  card,
  settings,
  save,
  busy = false,
  caption,
  facts,
  form,
  editing,
  setEditing,
  shortName,
}: CardProps & {
  card: Card<V>;
  caption: string;
  facts?: ReactNode;
  form: ReactNode;
  editing: boolean;
  setEditing: (value: boolean) => void;
  /** The short name the action buttons use: "Azure", "OpenRouter". */
  shortName: string;
}) {
  const { route, base, view, error, setError, working, run, load } = card;
  const name = routeDisplayName(route);
  const [limit, setLimit] = useState('');
  const [limitConsent, setLimitConsent] = useState(false);
  const [reconcile, setReconcile] = useState<Record<string, string>>({});
  const [readiness, setReadiness] = useState<ModelApiReadiness | null>(null);

  const connection = view?.connection ?? null;
  const spend = view?.spend ?? null;
  const showForm = !!view && view.protectedStorage && (!connection || editing || connection.credential.expired);
  const disabled = busy || working;

  const approve = () => {
    const parsed = awsLimitBody(limit, limitConsent);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    void run(async () => {
      const next = await api<V>(`${base}/spend-limit`, 'PUT', parsed.body);
      setLimitConsent(false);
      return next;
    });
  };
  // Only on a click, and only through the host's own readiness route: it sends nothing to
  // the provider, and its note says exactly what it did and did not check.
  const test = () =>
    void run(async () => {
      setReadiness(await api<ModelApiReadiness>(`${base}/test`, 'POST', {}));
    });
  const turnOn = () =>
    void run(async () => {
      await save({ ...settings, services: { ...settings.services, [route]: true } });
      await load();
    });
  const disconnect = () => {
    if (!window.confirm(`Forget the saved ${name} key and switch ${name} off? Spend records are kept.`)) return;
    void run(async () => {
      setReadiness(null);
      return api<V>(base, 'DELETE');
    });
  };
  const recordCost = (holdId: string) => {
    const dollars = Number(reconcile[holdId] ?? '');
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError(`Enter what ${name} billed for this call, in dollars.`);
      return;
    }
    void run(() =>
      api<V>(`${base}/holds/${encodeURIComponent(holdId)}/reconcile`, 'POST', {
        microUsd: Math.round(dollars * 1_000_000),
        note: `Recorded by the owner from the ${name} bill.`,
      }),
    );
  };
  const writeOff = (holdId: string) =>
    void run(() =>
      api<V>(`${base}/holds/${encodeURIComponent(holdId)}/write-off`, 'POST', {
        note: 'Accepted at its held ceiling by the owner.',
      }),
    );

  return (
    <section className="service" aria-label={name}>
      <div className="row">
        <h3>{name}</h3>
        {providerIsDefault(route, settings.services) && <span className="caption push-right">Default</span>}
      </div>
      <p className="caption ai-route">{caption}</p>
      {view && (
        <ul className="ai-states" aria-label={`${name} setup state`}>
          {providerStateRows(view).map((row) => (
            <li className={`ai-state is-${row.value}`} data-state={row.key} key={row.key}>
              <span className="ai-state-label">{row.label}</span>
              <span className="ai-state-value">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
      {connection && facts}
      {view?.next && <p className="ai-note">{view.next}</p>}
      {error && (
        <p className="ai-note" role="alert">
          {error}
        </p>
      )}

      {showForm && form}

      {connection && (
        <form
          className="ai-aws-limit"
          onSubmit={(event) => {
            event.preventDefault();
            approve();
          }}
        >
          <label>
            Spend limit for this connection (US dollars)
            <input
              inputMode="decimal"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder={spend ? (spend.capMicroUsd / 1_000_000).toFixed(2) : '1.00'}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={limitConsent} onChange={(event) => setLimitConsent(event.target.checked)} />
            Approve this as the most {AGENT_NAME} may send to {name} in total, estimated from the prices
            you entered.
          </label>
          <div className="actions">
            <Button type="submit" disabled={disabled}>
              Save limit
            </Button>
          </div>
        </form>
      )}

      {spend && (
        <div className="ai-aws-usage">
          <p className="caption">
            Spent {usd(spend.settledMicroUsd)} · in progress {usd(spend.pendingMicroUsd)} · unknown{' '}
            {usd(spend.uncertainMicroUsd)} · left {usd(spend.availableMicroUsd)}
          </p>
          <p className="caption">{spend.note}</p>
          {spend.recent.length > 0 && (
            <ul className="ai-aws-holds" aria-label={`Recent ${name} calls`}>
              {spend.recent.map((hold) => (
                <li key={hold.id} data-state={hold.state}>
                  <span className="caption">{new Date(hold.createdAt).toLocaleString()}</span>{' '}
                  <span>{holdSentence(hold)}</span>
                  {hold.state === 'uncertain' && (
                    <span className="actions">
                      <input
                        aria-label="Actual cost in dollars"
                        inputMode="decimal"
                        value={reconcile[hold.id] ?? ''}
                        onChange={(event) => setReconcile({ ...reconcile, [hold.id]: event.target.value })}
                      />
                      <Button tone="quiet" onClick={() => recordCost(hold.id)} disabled={disabled}>
                        Record cost
                      </Button>
                      <Button tone="quiet" onClick={() => writeOff(hold.id)} disabled={disabled}>
                        Accept at {usd(hold.maxMicroUsd)}
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {readiness && (
        <div className="ai-note" aria-label={`${name} setup check`} data-ready={readiness.ready}>
          <p>{readiness.ready ? 'Setup is complete.' : 'Setup is not complete.'}</p>
          <ul className="ai-readiness">
            {readinessLines(readiness).map((line) => (
              <li key={line.id} data-ok={line.ok}>
                {line.ok ? 'Yes' : 'No'} · {line.text}
              </li>
            ))}
          </ul>
          <p className="caption">{readiness.note}</p>
        </div>
      )}

      {view && (
        <div className="actions">
          {connection && (
            <Button tone="quiet" onClick={test} disabled={disabled}>
              Check setup
            </Button>
          )}
          {connection && !editing && !connection.credential.expired && (
            <Button tone="quiet" onClick={() => setEditing(true)} disabled={disabled}>
              Replace key
            </Button>
          )}
          {connection && !view.enabled && (
            <Button onClick={turnOn} disabled={disabled}>
              Turn on
            </Button>
          )}
          {/* No "use for new work" here: the owner's tier map is the one place that decides
              which route serves each tier (Tiers, below). */}
          {connection && (
            <Button tone="quiet" onClick={disconnect} disabled={disabled}>
              Disconnect
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Four price fields and their source, for one model. */
function RatesFields({
  rates,
  onChange,
  label,
}: {
  rates: RatesInput;
  onChange: (next: RatesInput) => void;
  label: string;
}) {
  const field = (key: keyof RatesInput, text: string, placeholder: string) => (
    <label>
      {text}
      <input
        inputMode={key === 'source' ? undefined : 'decimal'}
        autoComplete="off"
        aria-label={`${text} for ${label}`}
        value={rates[key]}
        placeholder={placeholder}
        onChange={(event) => onChange({ ...rates, [key]: event.target.value })}
      />
    </label>
  );
  return (
    <>
      {field('input', 'Input price ($ per million tokens)', '1.25')}
      {field('output', 'Output price ($ per million tokens)', '10.00')}
      {field('cacheRead', 'Cached input price (optional)', '')}
      {field('cacheWrite', 'Cache write price (optional)', '')}
      {field('source', 'Where these prices come from', 'The provider’s pricing page, read today')}
    </>
  );
}

/** The key, its expiry and the consent sentence, the same on every route. */
function KeyFields({
  keyLabel,
  apiKey,
  setApiKey,
  expiresLocal,
  setExpiresLocal,
  consent,
  setConsent,
  consentText,
}: {
  keyLabel: string;
  apiKey: string;
  setApiKey: (value: string) => void;
  expiresLocal: string;
  setExpiresLocal: (value: string) => void;
  consent: boolean;
  setConsent: (value: boolean) => void;
  consentText: string;
}) {
  return (
    <>
      <label>
        {keyLabel}
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label>
        Key expires (optional)
        <input type="datetime-local" value={expiresLocal} onChange={(event) => setExpiresLocal(event.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        {consentText}
      </label>
    </>
  );
}

/**
 * AI setup's card for the Azure OpenAI route: the company's own Azure OpenAI resource, the
 * deployments it may call and what each costs, an approved spend limit, and each paid call.
 * The key goes one way, into the desktop app's protected storage; nothing here reads it back.
 */
export function AzureOpenAISetup(props: CardProps) {
  const card = useProviderCard<AzureConnectionView>('azure-openai');
  const [editing, setEditing] = useState(false);
  const [resourceName, setResourceName] = useState('');
  const [deployments, setDeployments] = useState<AzureDeploymentInput[]>([emptyAzureDeployment()]);
  const [apiKey, setApiKey] = useState('');
  const [expiresLocal, setExpiresLocal] = useState('');
  const [consent, setConsent] = useState(false);
  const connection = card.view?.connection ?? null;
  const revision = connection?.revision ?? 0;
  // The saved deployments and prices fill the form, so replacing a key is only the key.
  useEffect(() => {
    const saved = azureInputFrom(card.view);
    setResourceName(saved.resourceName);
    setDeployments(saved.deployments);
    // Only a new saved generation refills the form; a spend-limit save must not wipe edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, !!connection]);

  const change = (index: number, next: Partial<AzureDeploymentInput>) =>
    setDeployments(deployments.map((entry, i) => (i === index ? { ...entry, ...next } : entry)));
  const connect = () => {
    const parsed = azureConnectBody({ resourceName, deployments, apiKey, expiresLocal, consent });
    if (!parsed.ok) {
      card.setError(parsed.message);
      return;
    }
    void card.run(async () => {
      const next = await api<AzureConnectionView>(card.base, 'PUT', parsed.body);
      // The key leaves this screen's memory as soon as it is saved.
      setApiKey('');
      setConsent(false);
      setEditing(false);
      return next;
    });
  };
  const disabled = props.busy || card.working;

  return (
    <ProviderCard
      {...props}
      card={card}
      shortName="Azure"
      editing={editing}
      setEditing={setEditing}
      caption="Your company’s own Azure OpenAI resource. Only the deployments you list are called, and every call is billed to that Azure subscription."
      facts={connection && <p className="caption">{connection.endpoint}</p>}
      form={
        <form
          className="ai-aws-connect ai-provider-connect"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <label>
            Azure OpenAI resource name
            <input
              autoComplete="off"
              spellCheck={false}
              value={resourceName}
              onChange={(event) => setResourceName(event.target.value)}
              placeholder="contoso-ai"
            />
          </label>
          {deployments.map((entry, index) => {
            const label = entry.model || `deployment ${index + 1}`;
            return (
              <fieldset key={index} className="ai-provider-model">
                <legend>Deployment {index + 1}</legend>
                <label>
                  Model
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={entry.model}
                    onChange={(event) => change(index, { model: event.target.value })}
                    placeholder="gpt-5.6-luna"
                  />
                </label>
                <label>
                  Deployment name, exactly as Azure shows it
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={entry.deployment}
                    onChange={(event) => change(index, { deployment: event.target.value })}
                    placeholder="luna-prod-eastus2"
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={entry.reasoning}
                    onChange={(event) => change(index, { reasoning: event.target.checked })}
                  />
                  This is a reasoning model
                </label>
                <RatesFields label={label} rates={entry.rates} onChange={(rates) => change(index, { rates })} />
                {deployments.length > 1 && (
                  <Button
                    tone="quiet"
                    onClick={() => setDeployments(deployments.filter((_, i) => i !== index))}
                    disabled={disabled}
                  >
                    Remove this deployment
                  </Button>
                )}
              </fieldset>
            );
          })}
          <div className="actions">
            <Button
              tone="quiet"
              onClick={() => setDeployments([...deployments, emptyAzureDeployment()])}
              disabled={disabled || deployments.length >= 16}
            >
              Add another deployment
            </Button>
          </div>
          <KeyFields
            keyLabel="Azure OpenAI API key"
            apiKey={apiKey}
            setApiKey={setApiKey}
            expiresLocal={expiresLocal}
            setExpiresLocal={setExpiresLocal}
            consent={consent}
            setConsent={setConsent}
            consentText="Send my conversations and the files I attach to this Azure OpenAI resource under this key."
          />
          <div className="actions">
            <Button tone="primary" type="submit" disabled={disabled}>
              {connection ? 'Save new key' : 'Connect Azure'}
            </Button>
            {connection && (
              <Button tone="quiet" onClick={() => setEditing(false)} disabled={disabled}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      }
    />
  );
}

/**
 * AI setup's card for the OpenRouter route: the models it may call, the only endpoints each
 * may run on, what each costs, an approved spend limit, and each paid call. Provider data
 * collection is refused and fallbacks are off on every request; the host fixes both.
 */
export function OpenRouterSetup(props: CardProps) {
  const card = useProviderCard<OpenRouterConnectionView>('openrouter');
  const [editing, setEditing] = useState(false);
  const [models, setModels] = useState<OpenRouterModelInput[]>([emptyOpenRouterModel()]);
  const [apiKey, setApiKey] = useState('');
  const [expiresLocal, setExpiresLocal] = useState('');
  const [consent, setConsent] = useState(false);
  const connection = card.view?.connection ?? null;
  const revision = connection?.revision ?? 0;
  useEffect(() => {
    setModels(openRouterInputFrom(card.view).models);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, !!connection]);

  const change = (index: number, next: Partial<OpenRouterModelInput>) =>
    setModels(models.map((entry, i) => (i === index ? { ...entry, ...next } : entry)));
  const connect = () => {
    const parsed = openRouterConnectBody({ models, apiKey, expiresLocal, consent });
    if (!parsed.ok) {
      card.setError(parsed.message);
      return;
    }
    void card.run(async () => {
      const next = await api<OpenRouterConnectionView>(card.base, 'PUT', parsed.body);
      setApiKey('');
      setConsent(false);
      setEditing(false);
      return next;
    });
  };
  const disabled = props.busy || card.working;

  return (
    <ProviderCard
      {...props}
      card={card}
      shortName="OpenRouter"
      editing={editing}
      setEditing={setEditing}
      caption="Your own OpenRouter account. Only the models and endpoints you list are used; provider data collection is refused and fallbacks are off. Every call is billed to that account."
      form={
        <form
          className="ai-aws-connect ai-provider-connect"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          {models.map((entry, index) => {
            const label = entry.id || `model ${index + 1}`;
            return (
              <fieldset key={index} className="ai-provider-model">
                <legend>Model {index + 1}</legend>
                <label>
                  Model id
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={entry.id}
                    onChange={(event) => change(index, { id: event.target.value })}
                    placeholder="vendor/model"
                  />
                </label>
                <label>
                  Endpoints it may run on (comma separated)
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={entry.upstreams}
                    onChange={(event) => change(index, { upstreams: event.target.value })}
                    placeholder="provider-name"
                  />
                </label>
                <RatesFields label={label} rates={entry.rates} onChange={(rates) => change(index, { rates })} />
                {models.length > 1 && (
                  <Button tone="quiet" onClick={() => setModels(models.filter((_, i) => i !== index))} disabled={disabled}>
                    Remove this model
                  </Button>
                )}
              </fieldset>
            );
          })}
          <div className="actions">
            <Button
              tone="quiet"
              onClick={() => setModels([...models, emptyOpenRouterModel()])}
              disabled={disabled || models.length >= 16}
            >
              Add another model
            </Button>
          </div>
          <KeyFields
            keyLabel="OpenRouter API key"
            apiKey={apiKey}
            setApiKey={setApiKey}
            expiresLocal={expiresLocal}
            setExpiresLocal={setExpiresLocal}
            consent={consent}
            setConsent={setConsent}
            consentText="Send my conversations and the files I attach to OpenRouter under this key, for the listed endpoints only."
          />
          <div className="actions">
            <Button tone="primary" type="submit" disabled={disabled}>
              {connection ? 'Save new key' : 'Connect OpenRouter'}
            </Button>
            {connection && (
              <Button tone="quiet" onClick={() => setEditing(false)} disabled={disabled}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      }
    />
  );
}
