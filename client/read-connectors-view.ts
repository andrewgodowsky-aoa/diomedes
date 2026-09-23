/**
 * What Settings shows and sends for approved read connectors
 * (`/api/ai/read-connectors`). Pure, so every sentence is testable without a
 * browser. The format rules (names, tools, forbidden variables) live on the
 * host, in the one schema a read turn loads with; this module checks only
 * what is missing and shows the host's refusal as it arrives.
 */
import {
  CONNECTOR_DATA_LABELS,
  type ConnectorDataKind,
  type ReadConnectorInput,
  type ReadConnectorView,
} from '../shared/read-connectors';

export interface ConnectorForm {
  name: string;
  command: string;
  /** One argument per line, so an argument may contain spaces. */
  args: string;
  /** Variable names, separated by commas, spaces or lines. */
  envFrom: string;
  /** Exact tool names, separated by commas, spaces or lines. */
  readTools: string;
  provides: ConnectorDataKind[];
  note: string;
  consent: boolean;
}

export const emptyConnectorForm = (): ConnectorForm => ({
  name: '',
  command: '',
  args: '',
  envFrom: '',
  readTools: '',
  provides: [],
  note: '',
  consent: false,
});

const words = (value: string) => [...new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean))];
const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** The host's body, or the one sentence that says what is missing. */
export function connectorBody(form: ConnectorForm):
  | { ok: true; body: ReadConnectorInput }
  | { ok: false; message: string } {
  const name = form.name.trim();
  if (!name) return { ok: false, message: 'Name the connector.' };
  const command = form.command.trim();
  if (!command) return { ok: false, message: 'Enter the command that starts the connector.' };
  const readTools = words(form.readTools);
  if (readTools.length === 0) return { ok: false, message: 'List the exact read tools you approve.' };
  if (!form.consent) return { ok: false, message: 'Confirm that you approve these read tools.' };
  const note = form.note.trim();
  return {
    ok: true,
    body: {
      name,
      command,
      args: lines(form.args),
      envFrom: words(form.envFrom),
      readTools,
      provides: [...new Set(form.provides)],
      ...(note ? { note } : {}),
      consent: true,
    },
  };
}

/** A saved connector back into the form, for changing it. Consent is asked again. */
export function connectorFormFrom(connector: ReadConnectorView): ConnectorForm {
  return {
    name: connector.name,
    command: connector.command,
    args: connector.args.join('\n'),
    envFrom: connector.envFrom.join(', '),
    readTools: connector.readTools.join(', '),
    provides: [...connector.provides],
    note: connector.note ?? '',
    consent: false,
  };
}

/** The kinds of data a connector provides, as a person reads them. */
export const providesText = (kinds: readonly ConnectorDataKind[]) =>
  kinds.map((kind) => CONNECTOR_DATA_LABELS[kind]).join(', ');

/** The rows one connector shows: what runs, what it may call, and what it is given. */
export function connectorRows(connector: ReadConnectorView): { label: string; text: string }[] {
  const rows = [
    { label: 'Runs', text: [connector.command, ...connector.args].join(' ') },
    { label: 'Read tools', text: connector.readTools.join(', ') },
  ];
  if (connector.envFrom.length > 0)
    rows.push({
      label: 'Given',
      text: connector.envFrom
        .map((name) => (connector.missingEnv.includes(name) ? `${name} (not set on this computer)` : name))
        .join(', '),
    });
  if (connector.provides.length > 0) rows.push({ label: 'Provides', text: providesText(connector.provides) });
  if (connector.note) rows.push({ label: 'Note', text: connector.note });
  return rows;
}
