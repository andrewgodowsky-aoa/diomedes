import { useCallback, useEffect, useState } from 'react';
import type { ModelApiReadiness, VertexConnectionView } from '../shared/model-api';
import type { Settings } from '../shared/types';
import { AGENT_NAME } from '../shared/agent-name';
import { routeDisplayName } from '../shared/engines';
import { ApiError, api } from './api';
import { awsLimitBody, holdSentence, usd } from './aws-bedrock-view';
import { readinessLines } from './provider-setup-view';
import { vertexConnectBody, vertexMoneyLines, vertexStateRows } from './vertex-setup-view';
import { Button } from './components';

const ROUTE = 'google-vertex' as const;
const BASE = `/ai/model-api/${ROUTE}`;

const messageOf = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.';

/**
 * The owner's Google Vertex AI route. There is no key to paste: the host reads the
 * Application Default Credentials `gcloud` left on this computer, records which
 * identity was verified, and refuses if it changes. The owner names the project
 * Google bills and approves a spend limit; nothing is sent until both are done.
 */
export function GoogleVertexSetup({ settings, save, busy = false }: { settings: Settings; save: (value: Settings) => Promise<void>; busy?: boolean }) {
  const name = routeDisplayName(ROUTE);
  const [view, setView] = useState<VertexConnectionView | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [consent, setConsent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState('');
  const [limitConsent, setLimitConsent] = useState(false);
  const [reconcile, setReconcile] = useState<Record<string, string>>({});
  const [readiness, setReadiness] = useState<ModelApiReadiness | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setView(await api<VertexConnectionView>(BASE, 'GET', undefined, signal));
      setError('');
    } catch (reason) {
      if (!signal?.aborted) setError(messageOf(reason));
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const run = async (action: () => Promise<VertexConnectionView | void>) => {
    setWorking(true);
    setError('');
    try {
      const next = await action();
      if (next) setView(next);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setWorking(false);
    }
  };

  const connection = view?.connection ?? null;
  const spend = view?.spend ?? null;
  const disabled = busy || working;
  const showForm = !!view && (!connection || editing);

  const connect = () => {
    const parsed = vertexConnectBody({ projectId, consent });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    void run(async () => {
      const next = await api<VertexConnectionView>(BASE, 'PUT', parsed.body);
      setConsent(false);
      setEditing(false);
      return next;
    });
  };
  const approve = () => {
    const parsed = awsLimitBody(limit, limitConsent);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    void run(async () => {
      const next = await api<VertexConnectionView>(`${BASE}/spend-limit`, 'PUT', parsed.body);
      setLimitConsent(false);
      return next;
    });
  };
  const test = () =>
    void run(async () => {
      setReadiness(await api<ModelApiReadiness>(`${BASE}/test`, 'POST', {}));
    });
  const turnOn = () =>
    void run(async () => {
      await save({ ...settings, services: { ...settings.services, [ROUTE]: true } });
      await load();
    });
  const disconnect = () => {
    if (!window.confirm(`Forget the ${name} connection and switch it off? Spend records are kept.`)) return;
    void run(async () => {
      setReadiness(null);
      return api<VertexConnectionView>(BASE, 'DELETE');
    });
  };
  const recordCost = (holdId: string) => {
    const dollars = Number(reconcile[holdId] ?? '');
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError(`Enter what Google billed for this call, in dollars.`);
      return;
    }
    void run(() =>
      api<VertexConnectionView>(`${BASE}/holds/${encodeURIComponent(holdId)}/reconcile`, 'POST', {
        microUsd: Math.round(dollars * 1_000_000),
        note: 'Recorded by the owner from the Google Cloud billing report.',
      }),
    );
  };
  const writeOff = (holdId: string) =>
    void run(() =>
      api<VertexConnectionView>(`${BASE}/holds/${encodeURIComponent(holdId)}/write-off`, 'POST', {
        note: 'Accepted at its held ceiling by the owner.',
      }),
    );

  return (
    <section className="service" aria-label={name}>
      <div className="row">
        <h3>{name}</h3>
      </div>
      <p className="caption ai-route">
        Owner route: Gemini 3.8 Flash on Google’s global endpoint, billed to your own Google Cloud project with the
        Google sign-in on this computer. {AGENT_NAME} keeps no Google key or token. Which work runs here is set by
        the Focused tier, not by this card.
      </p>
      {view && (
        <ul className="ai-states" aria-label={`${name} setup state`}>
          {vertexStateRows(view).map((row) => (
            <li className={`ai-state is-${row.value}`} data-state={row.key} key={row.key}>
              <span className="ai-state-label">{row.label}</span>
              <span className="ai-state-value">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
      {connection?.lastVerified && (
        <p className="caption" data-testid="vertex-last-verified">
          Last answered call {new Date(connection.lastVerified.at).toLocaleString()}
          {connection.lastVerified.providerRequestId ? ` · request ${connection.lastVerified.providerRequestId}` : ''}
        </p>
      )}
      {view?.next && <p className="ai-note">{view.next}</p>}
      {error && (
        <p className="ai-note" role="alert">
          {error}
        </p>
      )}

      {showForm && (
        <form
          className="ai-aws-form"
          aria-label={`Connect ${name}`}
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <label>
            Google Cloud project id
            <input
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder={connection?.projectId ?? view?.detected.quotaProject ?? 'my-project-id'}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            Bill this project, and no other, for every {name} call {AGENT_NAME} sends.
          </label>
          <div className="actions">
            <Button type="submit" disabled={disabled || !view?.detected.adc}>
              Connect
            </Button>
            {connection && (
              <Button tone="quiet" onClick={() => setEditing(false)} disabled={disabled}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

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
            Approve this as the most {AGENT_NAME} may send to {name} in total, estimated at Google’s standard price.
          </label>
          <div className="actions">
            <Button type="submit" disabled={disabled}>
              Save limit
            </Button>
          </div>
        </form>
      )}

      {view?.accounting && (
        <ul className="ai-states" aria-label={`${name} cost and payer`}>
          {vertexMoneyLines(view).map((line) => (
            <li className="ai-state" data-money={line.key} key={line.key}>
              <span className="ai-state-label">{line.label}</span>
              <span className="ai-state-value">{line.text}</span>
            </li>
          ))}
        </ul>
      )}

      {spend && (
        <div className="ai-aws-usage">
          <p className="caption">
            Spent {usd(spend.settledMicroUsd)} · in progress {usd(spend.pendingMicroUsd)} · unknown {usd(spend.uncertainMicroUsd)} ·
            left {usd(spend.availableMicroUsd)}
          </p>
          <p className="caption">{spend.note}</p>
          {spend.recent.length > 0 && (
            <ul className="ai-aws-holds" aria-label={`Recent ${name} calls`}>
              {spend.recent.map((hold) => (
                <li key={hold.id} data-state={hold.state}>
                  <span className="caption">{new Date(hold.createdAt).toLocaleString()}</span> <span>{holdSentence(hold)}</span>
                  {hold.usage && hold.usage.cacheReadTokens > 0 && (
                    <span className="caption"> · {hold.usage.cacheReadTokens.toLocaleString()} of the input cached</span>
                  )}
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
          {connection && !editing && (
            <Button tone="quiet" onClick={() => setEditing(true)} disabled={disabled}>
              Change project
            </Button>
          )}
          {connection && !view.enabled && (
            <Button onClick={turnOn} disabled={disabled}>
              Turn on
            </Button>
          )}
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
