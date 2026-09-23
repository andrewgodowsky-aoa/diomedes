/**
 * Approved read connectors, as the Console and the host exchange them.
 *
 * A read connector is a local MCP server the owner approved for Ask and Plan,
 * with the exact tools a read turn may call. The host keeps them in one file
 * (`<data>/read-connectors.json`) validated by `approvedReadServerSchema` in
 * `server/engines/read-scope.ts`; this module holds only the shapes the routes
 * return and the plain names of the kinds of data a connector may provide.
 *
 * The kinds are the Small Business pack's declared read needs, minus project
 * files, so a playbook's inputs and a connector are matched on the same words
 * and nothing here invents a vocabulary. `tests/read-connector-routes.test.ts`
 * pins the two lists together.
 */
export const CONNECTOR_DATA_KINDS = [
  'read-sales',
  'read-accounting',
  'read-bank',
  'read-payroll',
  'read-inventory',
  'read-reviews',
  'read-leads',
] as const;
export type ConnectorDataKind = (typeof CONNECTOR_DATA_KINDS)[number];

export const isConnectorDataKind = (value: unknown): value is ConnectorDataKind =>
  typeof value === 'string' && (CONNECTOR_DATA_KINDS as readonly string[]).includes(value);

/** What each kind is called where a person reads it. Generic on purpose: no vendor is named. */
export const CONNECTOR_DATA_LABELS: Record<ConnectorDataKind, string> = {
  'read-sales': 'sales',
  'read-accounting': 'bookkeeping and invoices',
  'read-bank': 'bank balances and transactions',
  'read-payroll': 'timesheets and payroll',
  'read-inventory': 'stock and inventory',
  'read-reviews': 'customer reviews',
  'read-leads': 'leads and enquiries',
};

/** One approved connector as `GET /api/ai/read-connectors` returns it. Names only, never a value. */
export interface ReadConnectorView {
  name: string;
  command: string;
  args: string[];
  /** Names of environment variables forwarded to the connector. Their values are never stored. */
  envFrom: string[];
  /** Of those, the ones not set on this computer, so the connector would start without them. */
  missingEnv: string[];
  readTools: string[];
  provides: ConnectorDataKind[];
  note: string | null;
}

export interface ReadConnectorsView {
  /** `none`: no file yet. `malformed`: the file cannot be read and nothing is written over it. */
  state: 'none' | 'ok' | 'malformed';
  problem: string | null;
  connectors: ReadConnectorView[];
  /** Entries in the file that Ask and Plan skip, kept as they are and said out loud. */
  ignored: { index: number; name: string | null; reason: string }[];
}

/** What a person enters to approve one connector. The host adds the approval itself. */
export interface ReadConnectorInput {
  name: string;
  command: string;
  args: string[];
  envFrom: string[];
  readTools: string[];
  provides: ConnectorDataKind[];
  note?: string;
  consent: true;
}
