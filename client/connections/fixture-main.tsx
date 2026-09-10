import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/schibsted-grotesk/400';
import '@fontsource/schibsted-grotesk/500';
import '@fontsource/schibsted-grotesk/600';
import '@fontsource/ibm-plex-mono/400';
import '../styles.css';
import './connections.css';
import { Brand, Button } from '../components.js';
import type {
  ConnectionInstance,
  ConnectionObservation,
  InboxEvent,
} from '../../shared/connections.js';
import type { Rule, RuleProposal } from '../../shared/connection-rules.js';
import type { Task } from '../../shared/types.js';

interface View {
  connection: ConnectionInstance;
  health: string;
  freshness: string;
  observations: ConnectionObservation[];
  rules: Rule[];
  tasks: Task[];
  events: InboxEvent[];
  failure: string | null;
  canRepeatFixtureEvent: boolean;
}
async function request<T>(route: string, data?: unknown): Promise<T> {
  const result = await fetch(`/api/${route}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Fixture': '1' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!result.ok) {
    const failure: { error: string } = await result.json();
    throw new Error(failure.error);
  }
  return result.json();
}
const statusNames: Record<string, string> = {
  healthy: 'Healthy',
  stale: 'Connection stale',
  connected: 'Connected',
  paused: 'Paused',
  disconnected: 'Disconnected',
  'authorization-required': 'Reauthorization required',
  'source-unavailable': 'Source unavailable',
  'reconciliation-required': 'Reconciliation required',
};
const itemNames: Record<string, string> = {
  '101': 'Ribeye',
  '102': 'House salad',
  '103': 'Seasonal special',
};
const stamp = (time: string | null) =>
  time
    ? new Date(time).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'No observation yet';

export function Connections() {
  const [view, setView] = useState<View | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [text, setText] = useState('Alert a manager when reported quantity is at most 5');
  const [proposal, setProposal] = useState<{ proposal: RuleProposal; digest: string } | null>(null);
  const refresh = async () => {
    setView(await request<View>('connections'));
  };
  useEffect(() => {
    void refresh().catch((error) => setError(String(error)));
  }, []);
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  };
  const control = (status: ConnectionInstance['status']) =>
    action(() => request('fixture/control', { status }));
  return (
    <div className="connections-page">
      <header className="connections-top">
        <Brand />
        <span className="connections-kicker">CONNECTIONS / LOCAL FIXTURE</span>
      </header>
      <main>
        <div className="connections-heading">
          <div>
            <p className="connections-kicker">YOUR BUSINESS SOFTWARE</p>
            <h1>Connections</h1>
            <p>
              Understand what your software reports. Keep every action within its approved scope.
            </p>
          </div>
          <span className="connections-demo-label">Synthetic restaurant group</span>
        </div>
        <p className="connections-notice">
          Interactive fixture. This demo uses sample data and a scripted agent. No Toast account is
          connected.
        </p>
        {error && (
          <p className="connections-error" role="alert">
            {error}
          </p>
        )}
        {view && (
          <>
            {view.failure && (
              <p className="connections-error" role="alert">
                {view.failure}
              </p>
            )}
            <section className="connection-summary" aria-label="Toast connection">
              <div>
                <h2>Toast</h2>
                <p>{view.connection.name}</p>
                <small>Connected as: synthetic local worker</small>
              </div>
              <div>
                <span className="connections-kicker">STATUS</span>
                <strong data-testid="connection-health">{statusNames[view.health]}</strong>
              </div>
              <div>
                <span className="connections-kicker">SCOPE</span>
                <strong>3 approved locations</strong>
                <small>Downtown / North Hills / Cary</small>
              </div>
              <div>
                <span className="connections-kicker">PERMISSIONS</span>
                <strong>Read only</strong>
                <small>No stock, price or order changes</small>
              </div>
            </section>
            <div className="connection-actions">
              <Button
                disabled={busy || view.connection.status !== 'connected'}
                onClick={() => action(() => request('fixture/read', {}))}
              >
                Refresh sample
              </Button>
              <Button
                disabled={busy || view.connection.status !== 'connected'}
                onClick={() => control('paused')}
              >
                Pause
              </Button>
              <Button
                disabled={busy || view.connection.status === 'connected'}
                onClick={() => control('connected')}
              >
                Reconnect fixture
              </Button>
              <Button
                disabled={busy || view.connection.status === 'disconnected'}
                onClick={() => control('disconnected')}
              >
                Disconnect
              </Button>
              <details>
                <summary>Permissions</summary>
                <p>
                  Read selected menu availability and reported quantities at these three locations.
                  A reviewed rule can create internal manager issues. No external writes, orders or
                  model-provider calls are available.
                </p>
              </details>
            </div>
            <div className="connection-freshness">
              <span>Last event: {stamp(view.connection.lastEventAt)}</span>
              <span>Oldest location refresh: {stamp(view.connection.lastReconciledAt)}</span>
              <span>Monitoring while this host is online</span>
            </div>
            <div className="connection-columns">
              <section>
                <div className="connection-section-title">
                  <h2>Menu availability</h2>
                  <span>Sample observations</span>
                </div>
                <p className="connection-subtitle">
                  Menu-item and modifier availability. Physical ingredient inventory is not
                  supplied.
                </p>
                {view.observations.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Item / location</th>
                        <th>Availability</th>
                        <th>Reported quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.observations.map((item) => (
                        <tr key={`${item.resourceId}-${item.key}`}>
                          <td>
                            {itemNames[item.key] ?? item.key}
                            <small>
                              {
                                view.connection.resources.find(
                                  (resource) => resource.id === item.resourceId,
                                )?.name
                              }
                            </small>
                          </td>
                          <td>
                            {item.facts.availability === 'available'
                              ? 'Available'
                              : item.facts.availability === 'unavailable'
                                ? 'Unavailable'
                                : 'Unknown'}
                          </td>
                          <td>
                            {typeof item.facts.quantity === 'number'
                              ? item.facts.quantity
                              : item.facts.quantityState === 'not-tracked'
                                ? 'Not tracked by source'
                                : 'Unknown'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="connection-empty">
                    Refresh the sample to read all three approved locations.
                  </p>
                )}
              </section>
              <section>
                <div className="connection-section-title">
                  <h2>Manager issues</h2>
                  <span data-testid="issue-count">{view.tasks.length} open</span>
                </div>
                {view.tasks.length ? (
                  view.tasks.map((task) => (
                    <article className="connection-issue" key={task.id}>
                      <span className="connections-kicker">{task.id} / SOURCE EVIDENCE</span>
                      <h3>{task.name}</h3>
                      <p>
                        A reviewed stock rule matched a reported quantity. No Toast changes were
                        permitted.
                      </p>
                      <details>
                        <summary>Why was this created?</summary>
                        <pre>{task.description}</pre>
                      </details>
                    </article>
                  ))
                ) : (
                  <p className="connection-empty">
                    Review a rule, then simulate a low-stock event. An issue appears here when the
                    rule matches.
                  </p>
                )}
                <div className="connection-actions">
                  <Button
                    disabled={busy || view.connection.status !== 'connected'}
                    onClick={() => action(() => request('fixture/event', { repeat: false }))}
                  >
                    Simulate low stock
                  </Button>
                  <Button
                    disabled={
                      busy || !view.canRepeatFixtureEvent || view.connection.status !== 'connected'
                    }
                    onClick={() => action(() => request('fixture/event', { repeat: true }))}
                  >
                    Repeat sample event
                  </Button>
                </div>
              </section>
            </div>
            <section className="connection-rules">
              <h2>Business rules</h2>
              <p>Describe the behavior, inspect the proposal, then activate it for this fixture.</p>
              <label htmlFor="rule-request">Rule request</label>
              <div className="connection-rule-input">
                <input
                  id="rule-request"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
                <Button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      setProposal(await request('fixture/propose', { text }));
                    })
                  }
                >
                  Review proposal
                </Button>
              </div>
              {proposal && (
                <div className="connection-proposal">
                  <strong>Proposed rule / inactive until activated</strong>
                  <dl>
                    {Object.entries(proposal.proposal.preview).map(([name, value]) => (
                      <div key={name}>
                        <dt>{name === 'appliesTo' ? 'Applies to' : name}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {proposal.proposal.questions.map((question) => (
                    <p key={question}>{question}</p>
                  ))}
                  <Button
                    disabled={busy || !proposal.proposal.rule}
                    onClick={() =>
                      action(async () => {
                        await request('fixture/activate', {
                          id: proposal.proposal.id,
                          digest: proposal.digest,
                        });
                        setProposal(null);
                      })
                    }
                  >
                    Activate fixture rule
                  </Button>
                </div>
              )}
              <p className="connection-subtitle">
                Active workflow rules:{' '}
                {view.rules
                  .filter((rule) => rule.enabled && rule.type === 'workflow')
                  .map((rule) => `${rule.id} v${rule.version}`)
                  .join(', ') || 'None'}
              </p>
            </section>
            <details className="connection-inspector">
              <summary>Technical inspector</summary>
              <p>
                Fixture adapter / Toast v{view.connection.version}. Scope: stock:read. Signed event
                validation and durable receipts; no production authentication or OS containment
                claim.
              </p>
              <pre>{JSON.stringify({ events: view.events, rules: view.rules }, null, 2)}</pre>
            </details>
          </>
        )}
      </main>
    </div>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Connections />);
