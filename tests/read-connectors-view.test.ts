import { describe, expect, test } from 'vitest';
import {
  connectorBody,
  connectorFormFrom,
  connectorRows,
  emptyConnectorForm,
} from '../client/read-connectors-view';
import type { ReadConnectorView } from '../shared/read-connectors';

const saved: ReadConnectorView = {
  name: 'pos',
  command: 'C:\\Tools\\pos mcp\\pos-mcp.exe',
  args: ['--store', 'Main Street'],
  envFrom: ['POS_TOKEN', 'POS_SITE'],
  missingEnv: ['POS_SITE'],
  readTools: ['list_orders', 'daily_sales'],
  provides: ['read-sales', 'read-inventory'],
  note: null,
};

describe('read connectors in Settings', () => {
  test('the form sends names only, one argument per line, and needs consent', () => {
    const form = {
      ...emptyConnectorForm(),
      name: ' pos ',
      command: ' pos-mcp.exe ',
      args: '--store\nMain Street\n\n',
      envFrom: 'POS_TOKEN, POS_SITE POS_TOKEN',
      readTools: 'list_orders,\ndaily_sales',
      provides: ['read-sales' as const, 'read-sales' as const],
      consent: true,
    };
    expect(connectorBody(form)).toEqual({
      ok: true,
      body: {
        name: 'pos',
        command: 'pos-mcp.exe',
        args: ['--store', 'Main Street'],
        envFrom: ['POS_TOKEN', 'POS_SITE'],
        readTools: ['list_orders', 'daily_sales'],
        provides: ['read-sales'],
        consent: true,
      },
    });
    expect(connectorBody({ ...form, name: '' })).toEqual({ ok: false, message: 'Name the connector.' });
    expect(connectorBody({ ...form, command: ' ' }).ok).toBe(false);
    expect(connectorBody({ ...form, readTools: ' , ' }).ok).toBe(false);
    expect(connectorBody({ ...form, consent: false })).toEqual({
      ok: false,
      message: 'Confirm that you approve these read tools.',
    });
  });

  test('changing a connector refills everything but consent', () => {
    const form = connectorFormFrom(saved);
    expect(form).toMatchObject({ name: 'pos', args: '--store\nMain Street', envFrom: 'POS_TOKEN, POS_SITE', consent: false });
    const round = connectorBody({ ...form, consent: true });
    expect(round.ok && round.body.args).toEqual(saved.args);
  });

  test('a connector reads as what runs, what it may call, what it is given and what it provides', () => {
    expect(connectorRows(saved)).toEqual([
      { label: 'Runs', text: 'C:\\Tools\\pos mcp\\pos-mcp.exe --store Main Street' },
      { label: 'Read tools', text: 'list_orders, daily_sales' },
      { label: 'Given', text: 'POS_TOKEN, POS_SITE (not set on this computer)' },
      { label: 'Provides', text: 'sales, stock and inventory' },
    ]);
    expect(connectorRows({ ...saved, envFrom: [], missingEnv: [], provides: [] }).map((row) => row.label)).toEqual([
      'Runs',
      'Read tools',
    ]);
  });
});
