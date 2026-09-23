import { useCallback, useEffect, useState } from 'react';
import { AGENT_NAME } from '../shared/agent-name';
import {
  CONNECTOR_DATA_KINDS,
  CONNECTOR_DATA_LABELS,
  type ReadConnectorsView,
} from '../shared/read-connectors';
import { ApiError, api } from './api';
import { Button } from './components';
import {
  connectorBody,
  connectorFormFrom,
  connectorRows,
  emptyConnectorForm,
  type ConnectorForm,
} from './read-connectors-view';

const BASE = '/ai/read-connectors';

const messageOf = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.';

/**
 * Settings' list of approved read connectors: local connectors (MCP servers) that Ask and Plan
 * may read from, each with the exact read tools the owner approves. Nothing here starts a
 * connector. The file stays the host's; this screen only asks it to add, change or remove one.
 */
export function ReadConnectors() {
  const [view, setView] = useState<ReadConnectorsView | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  // null: no form open. A name: changing that connector. '': adding one.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectorForm>(emptyConnectorForm());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setView(await api<ReadConnectorsView>(BASE, 'GET', undefined, signal));
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

  const run = async (action: () => Promise<ReadConnectorsView>) => {
    setWorking(true);
    setError('');
    try {
      setView(await action());
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      setWorking(false);
    }
  };
  const open = (name: string | null) => {
    const found = name ? view?.connectors.find((connector) => connector.name === name) : undefined;
    setForm(found ? connectorFormFrom(found) : emptyConnectorForm());
    setEditing(name ?? '');
    setError('');
  };
  const submit = () => {
    const parsed = connectorBody(form);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const changing = editing ? editing : null;
    void run(() =>
      changing
        ? api<ReadConnectorsView>(`${BASE}/${encodeURIComponent(changing)}`, 'PUT', parsed.body)
        : api<ReadConnectorsView>(BASE, 'POST', parsed.body),
    ).then((done) => {
      if (done) setEditing(null);
    });
  };
  const remove = (name: string) => {
    if (!window.confirm(`Remove the ${name} connector? Ask and Plan stop reading from it.`)) return;
    void run(() => api<ReadConnectorsView>(`${BASE}/${encodeURIComponent(name)}`, 'DELETE'));
  };
  const toggleKind = (kind: (typeof CONNECTOR_DATA_KINDS)[number], on: boolean) =>
    setForm({ ...form, provides: on ? [...form.provides, kind] : form.provides.filter((k) => k !== kind) });

  const malformed = view?.state === 'malformed';
  const disabled = working;

  return (
    <div className="ai-connections read-connectors">
      <section className="service" aria-label="Read connectors">
        <div className="row">
          <h3>Read connectors</h3>
        </div>
        <p className="caption ai-route">
          Local connectors Ask and Plan may read from, such as your sales or bookkeeping data. {AGENT_NAME} can
          only read with the tools you list here, never write. Environment variables are passed by name; their
          values are never stored.
        </p>
        {view?.problem && (
          <p className="ai-note" role="alert">
            {view.problem}
          </p>
        )}
        {error && (
          <p className="ai-note" role="alert">
            {error}
          </p>
        )}
        {view && !malformed && view.connectors.length === 0 && editing === null && (
          <p className="caption">No connectors are approved.</p>
        )}
        {view?.connectors.map((connector) => (
          <div className="read-connector" key={connector.name} data-connector={connector.name}>
            <div className="row">
              <strong className="read-connector-name">{connector.name}</strong>
              <span className="actions push-right">
                <Button tone="quiet" onClick={() => open(connector.name)} disabled={disabled}>
                  Change
                </Button>
                <Button tone="quiet" onClick={() => remove(connector.name)} disabled={disabled}>
                  Remove
                </Button>
              </span>
            </div>
            <div className="setting-rows">
              {connectorRows(connector).map((row) => (
                <div className="setting-row" key={row.label}>
                  <span>{row.label}</span>
                  <span>{row.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {view && view.ignored.length > 0 && (
          <ul className="caption read-connectors-ignored" aria-label="Entries Ask and Plan skip">
            {view.ignored.map((entry) => (
              <li key={entry.index}>
                {entry.name ?? `Entry ${entry.index + 1}`}: {entry.reason}
              </li>
            ))}
          </ul>
        )}

        {editing !== null && !malformed && (
          <form
            className="ai-provider-connect"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label>
              Name
              <input
                autoComplete="off"
                spellCheck={false}
                value={form.name}
                disabled={!!editing}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="pos"
              />
            </label>
            <label>
              Command that starts it
              <input
                autoComplete="off"
                spellCheck={false}
                value={form.command}
                onChange={(event) => setForm({ ...form, command: event.target.value })}
              />
            </label>
            <label>
              Arguments, one per line (optional)
              <textarea
                rows={2}
                spellCheck={false}
                value={form.args}
                onChange={(event) => setForm({ ...form, args: event.target.value })}
              />
            </label>
            <label>
              Environment variable names it needs (optional)
              <input
                autoComplete="off"
                spellCheck={false}
                value={form.envFrom}
                onChange={(event) => setForm({ ...form, envFrom: event.target.value })}
                placeholder="POS_TOKEN"
              />
            </label>
            <label>
              Read tools you approve, exactly as the connector names them
              <textarea
                rows={2}
                spellCheck={false}
                value={form.readTools}
                onChange={(event) => setForm({ ...form, readTools: event.target.value })}
                placeholder="list_orders, daily_sales"
              />
            </label>
            <fieldset className="ai-provider-model">
              <legend>What it reads (optional)</legend>
              {CONNECTOR_DATA_KINDS.map((kind) => (
                <label className="check" key={kind}>
                  <input
                    type="checkbox"
                    checked={form.provides.includes(kind)}
                    onChange={(event) => toggleKind(kind, event.target.checked)}
                  />
                  {CONNECTOR_DATA_LABELS[kind]}
                </label>
              ))}
            </fieldset>
            <label>
              Note (optional)
              <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.consent}
                onChange={(event) => setForm({ ...form, consent: event.target.checked })}
              />
              I approve these read tools. {AGENT_NAME} may call only them, and only to read.
            </label>
            <div className="actions">
              <Button tone="primary" type="submit" disabled={disabled}>
                {editing ? 'Save connector' : 'Approve connector'}
              </Button>
              <Button tone="quiet" onClick={() => setEditing(null)} disabled={disabled}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {editing === null && view && !malformed && (
          <div className="actions">
            <Button onClick={() => open(null)} disabled={disabled || view.connectors.length + view.ignored.length >= 16}>
              Add a connector
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
