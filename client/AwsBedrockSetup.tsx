import { useCallback, useEffect, useState } from 'react';
import type { AwsConnectionView } from '../shared/model-api';
import type { Settings } from '../shared/types';
import { ApiError, api } from './api';
import {
  awsConnectBody,
  awsIsDefault,
  awsLimitBody,
  awsStateRows,
  holdSentence,
  usd,
} from './aws-bedrock-view';
import { Button } from './components';

const BASE = '/ai/model-api/aws-bedrock';

const messageOf = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.';

/**
 * AI setup's card for the AWS Bedrock route: connect the company's own AWS account, approve an
 * aggregate spend limit, see what each call cost and record the cost of any call whose answer
 * was lost. The key goes one way, into the desktop app's protected storage; nothing here ever
 * reads it back.
 */
export function AwsBedrockSetup({
  settings,
  save,
  busy = false,
}: {
  settings: Settings;
  save: (value: Settings) => Promise<void>;
  busy?: boolean;
}) {
  const [view, setView] = useState<AwsConnectionView | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [expiresLocal, setExpiresLocal] = useState('');
  const [consent, setConsent] = useState(false);
  const [limit, setLimit] = useState('');
  const [limitConsent, setLimitConsent] = useState(false);
  const [reconcile, setReconcile] = useState<Record<string, string>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setView(await api<AwsConnectionView>(BASE, 'GET', undefined, signal));
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

  const run = async (action: () => Promise<AwsConnectionView | void>) => {
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

  const connect = () => {
    const parsed = awsConnectBody({ accountId, apiKey, expiresLocal, consent });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    void run(async () => {
      const next = await api<AwsConnectionView>(BASE, 'PUT', parsed.body);
      // The key leaves this screen's memory as soon as it is saved.
      setApiKey('');
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
      const next = await api<AwsConnectionView>(`${BASE}/spend-limit`, 'PUT', parsed.body);
      setLimitConsent(false);
      return next;
    });
  };
  const makeDefault = () =>
    void run(() =>
      save({ ...settings, services: { ...settings.services, defaultEngine: 'aws-bedrock' } }),
    );
  // Connecting turns the route on; this is only for a route someone switched off since.
  const turnOn = () =>
    void run(async () => {
      await save({ ...settings, services: { ...settings.services, 'aws-bedrock': true } });
      await load();
    });
  const disconnect = () => {
    if (!window.confirm('Forget the saved AWS key and switch AWS Bedrock off? Spend records are kept.')) return;
    void run(() => api<AwsConnectionView>(BASE, 'DELETE'));
  };
  const recordCost = (holdId: string) => {
    const dollars = Number(reconcile[holdId] ?? '');
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError('Enter what AWS billed for this call, in dollars.');
      return;
    }
    void run(() =>
      api<AwsConnectionView>(`${BASE}/holds/${encodeURIComponent(holdId)}/reconcile`, 'POST', {
        microUsd: Math.round(dollars * 1_000_000),
        note: 'Recorded by the owner from the AWS bill.',
      }),
    );
  };
  const writeOff = (holdId: string) =>
    void run(() =>
      api<AwsConnectionView>(`${BASE}/holds/${encodeURIComponent(holdId)}/write-off`, 'POST', {
        note: 'Accepted at its held ceiling by the owner.',
      }),
    );

  const disabled = busy || working;
  const connection = view?.connection ?? null;
  const spend = view?.spend ?? null;
  const showForm = !!view && view.protectedStorage && (!connection || editing || connection.credential.expired);

  return (
    <section className="service" aria-label="AWS Bedrock (GPT-5.6 Luna)">
      <div className="row">
        <h3>AWS Bedrock (GPT-5.6 Luna)</h3>
        {awsIsDefault(settings.services) && <span className="caption push-right">Default</span>}
      </div>
      <p className="caption ai-route">
        Your company’s own AWS account, us-east-1, US processing. AWS keeps nothing between calls
        (store:false), and every call is billed to that account.
      </p>
      {view && (
        <ul className="ai-states" aria-label="AWS Bedrock setup state">
          {awsStateRows(view).map((row) => (
            <li className={`ai-state is-${row.value}`} data-state={row.key} key={row.key}>
              <span className="ai-state-label">{row.label}</span>
              <span className="ai-state-value">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
      {connection && <p className="caption">{connection.accountEvidence}</p>}
      {view?.next && <p className="ai-note">{view.next}</p>}
      {error && (
        <p className="ai-note" role="alert">
          {error}
        </p>
      )}

      {showForm && (
        <form
          className="ai-aws-connect"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <label>
            AWS account number
            <input
              inputMode="numeric"
              autoComplete="off"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="123456789012"
            />
          </label>
          <label>
            Bedrock API key
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
            Send my conversations and the files I attach to AWS Bedrock in us-east-1 under this account.
          </label>
          <div className="actions">
            <Button tone="primary" type="submit" disabled={disabled}>
              {connection ? 'Save new key' : 'Connect AWS'}
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
            <input
              type="checkbox"
              checked={limitConsent}
              onChange={(event) => setLimitConsent(event.target.checked)}
            />
            Approve this as the most Diomedes may send to AWS in total, estimated from AWS list prices.
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
            <ul className="ai-aws-holds" aria-label="Recent AWS calls">
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

      {connection && (
        <div className="actions">
          {!editing && !connection.credential.expired && (
            <Button tone="quiet" onClick={() => setEditing(true)} disabled={disabled}>
              Replace key
            </Button>
          )}
          {!view?.enabled && (
            <Button onClick={turnOn} disabled={disabled}>
              Turn on
            </Button>
          )}
          {!awsIsDefault(settings.services) && view?.enabled && (
            <Button onClick={makeDefault} disabled={disabled}>
              Use AWS for new work
            </Button>
          )}
          <Button tone="quiet" onClick={disconnect} disabled={disabled}>
            Disconnect
          </Button>
        </div>
      )}
    </section>
  );
}
