import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { InventoryCatalog, InventoryScope } from '../shared/inventory.js';
import { IMPORT_MAX_BYTES } from '../shared/file-imports.js';
import { ApiError } from '../server/paths.js';
import { createInventoryCatalog } from '../server/inventory/catalog.js';
import {
  prepareInventoryImport,
  prepareOpeningCount,
  type InventoryImportMapping,
  type InventoryImportOptions,
  type InventorySourceSelection,
} from '../server/inventory/import.js';

// Independent fixtures: no producer helper, snapshot or implementation-private API.
const scope: InventoryScope = {
  organizationId: 'review-org', tenantId: 'review-tenant', projectId: 'review-project',
};
const sourceAt = '2026-09-19T10:00:00.000Z';
const now = '2026-09-19T10:05:00.000Z';
const old = '2026-08-01T01:00:00.000Z';
const policy = { now, maxSourceAgeMs: 60_000, maxCountAgeMs: 86_400_000 };
const fields = [
  'itemId', 'name', 'variant', 'barcode', 'unit', 'scale', 'siteId', 'siteName',
  'binId', 'binName', 'onHandMinor', 'reservedMinor', 'lastMovementAt',
  'lastPhysicalCountAt', 'countReference',
] as const;
const mapping: InventoryImportMapping = Object.fromEntries(fields.map(f => [f, f])) as InventoryImportMapping;
const options: InventoryImportOptions = { reservationMode: 'read-only', now };
type Row = Record<(typeof fields)[number], string | number | null>;
function row(overrides: Partial<Row> = {}): Row {
  return {
    itemId: 'part-a', name: 'Same visible name', variant: 'left', barcode: '00001042',
    unit: 'each', scale: 0, siteId: 'north', siteName: 'North fixture',
    binId: 'north-bin', binName: 'Shelf fixture', onHandMinor: null,
    reservedMinor: null, lastMovementAt: null, lastPhysicalCountAt: null,
    countReference: null, ...overrides,
  };
}
function table(rows = [row()], headers: readonly string[] = fields) {
  return [headers, ...rows.map(r => headers.map(h => r[h as keyof Row] ?? null))];
}
function csv(rows = [row()], headers: readonly string[] = fields) {
  return table(rows, headers).map(r => r.map(v => {
    const s = v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(',')).join('\r\n');
}
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function inputs(text: string, format: InventorySourceSelection['format'] = 'csv') {
  const selected: InventorySourceSelection = {
    scope: { ...scope }, format,
    source: { kind: 'approved-file', reference: 'file-ref', revision: 'rev-1', observedAt: sourceAt, sha256: sha(text) },
  };
  return { selected, snapshot: { ...structuredClone(selected), text } };
}
function preview(text = csv(), format: InventorySourceSelection['format'] = 'csv', map: unknown = mapping, opts = options) {
  const { selected, snapshot } = inputs(text, format);
  return prepareInventoryImport(selected, snapshot, map, opts);
}
function fixture(): InventoryCatalog {
  return structuredClone(preview().catalog) as InventoryCatalog;
}
function code(fn: () => unknown, status: number) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return;
  }
  throw new Error(`Expected ApiError ${status}, but operation succeeded.`);
}
function count(expectedVersion: string) {
  return {
    kind: 'record-count' as const, operationId: 'count-op', itemId: 'part-a',
    siteId: 'north', binId: 'north-bin', expectedVersion,
    quantity: { minor: 2, unit: 'each', scale: 0 },
    countEvidence: { countedAt: sourceAt, reference: 'physical-sheet-7' },
  };
}
function version(result: ReturnType<typeof preview>) { return result.catalog.balances[0].version; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('MI02.R independent scope, identity and immutable catalog', () => {
  test.each(['organizationId', 'tenantId', 'projectId'] as const)('isolates every catalog API and count preparation by %s', key => {
    const data = fixture();
    const host = { ...scope };
    const index = createInventoryCatalog(data, host);
    const foreign = { ...scope, [key]: 'foreign-scope' };
    code(() => createInventoryCatalog(data, foreign), 403);
    const reads = [
      () => index.snapshot(foreign), () => index.getItem(foreign, 'part-a'),
      () => index.getItemByBarcode(foreign, '00001042'), () => index.getSite(foreign, 'north'),
      () => index.getBin(foreign, 'north', 'north-bin'),
      () => index.getBalance(foreign, 'part-a', 'north', 'north-bin'),
      () => index.lookup(foreign, { by: 'item', value: 'part-a' }, policy),
      () => prepareOpeningCount(index, foreign, count(data.balances[0].version), now),
    ];
    for (const read of reads) code(read, 403);
    host[key] = 'mutated-host';
    data.scope[key] = 'mutated-input';
    expect(index.snapshot(scope).scope[key]).toBe(scope[key]);
    code(() => index.snapshot(host), 403);
  });

  test('does not confuse independent tenants sharing the same barcode', () => {
    const a = fixture(); const b = fixture();
    b.scope.tenantId = 'tenant-b'; b.items[0].name = 'Tenant B part';
    const ai = createInventoryCatalog(a, scope); const bi = createInventoryCatalog(b, b.scope);
    expect(ai.getItemByBarcode(scope, '00001042')?.name).toBe('Same visible name');
    expect(bi.getItemByBarcode(b.scope, '00001042')?.name).toBe('Tenant B part');
    code(() => ai.getItemByBarcode(b.scope, '00001042'), 403);
  });

  test('detaches and deeply freezes every nested source, scope, item and evidence record', () => {
    const data = fixture();
    Object.assign(data.balances[0], { lastPhysicalCountAt: old, countEvidence: { countedAt: old, reference: 'count-ref' } });
    const index = createInventoryCatalog(data, scope);
    const saved = JSON.stringify(index.snapshot(scope));
    data.items[0].barcodes.push('another'); data.balances[0].source.revision = 'later';
    data.balances[0].countEvidence!.reference = 'replaced'; data.bins[0].siteId = 'other';
    const recurse = (value: unknown) => {
      if (value && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) recurse(child);
        expect(Reflect.set(value, 'reviewMutation', true)).toBe(false);
      }
    };
    recurse(index.snapshot(scope));
    const result = index.lookup(scope, { by: 'item', value: 'part-a' }, policy);
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('missing');
    result.locations.splice(0);
    expect(JSON.stringify(index.snapshot(scope))).toBe(saved);
    expect(index.getItemByBarcode(scope, 'another')).toBeNull();
    expect(index.lookup(scope, { by: 'item', value: 'part-a' }, policy)).toMatchObject({ locations: [{ countLabel: 'Count stale' }] });
  });

  test('preserves duplicate-looking variants, leading zeros, case and literal Map keys', () => {
    const rows = [row({ itemId: 'constructor' }), row({ itemId: 'toString', variant: 'right', barcode: '1042' })];
    const data = preview(csv(rows)).catalog;
    const index = createInventoryCatalog(data, scope);
    expect(index.getItemByBarcode(scope, '00001042')?.id).toBe('constructor');
    expect(index.getItemByBarcode(scope, '1042')?.id).toBe('toString');
    expect(index.getItemByBarcode(scope, ' 1042')).toBeNull();
    expect(index.getItem(scope, 'CONSTRUCTOR')).toBeNull();
    expect(index.getItem(scope, 'toString')?.variant).toBe('right');
  });

  test.each(['items', 'sites', 'bins', 'balances'] as const)('refuses duplicate %s even with identical contents', collection => {
    const data = fixture();
    (data[collection] as unknown[]).push(structuredClone(data[collection][0]));
    code(() => createInventoryCatalog(data, scope), 422);
  });

  test.each([
    (d: InventoryCatalog) => { d.bins[0].siteId = 'south'; },
    (d: InventoryCatalog) => { d.balances[0].siteId = 'south'; },
    (d: InventoryCatalog) => { d.balances[0].itemId = 'missing'; },
    (d: InventoryCatalog) => { d.balances[0].scale = 1; },
    (d: InventoryCatalog) => { d.items[0].barcodes.push('00001042'); },
  ])('rejects invalid cross-record references (%#)', mutate => {
    const data = fixture(); mutate(data); code(() => createInventoryCatalog(data, scope), 422);
  });

  test.each([
    [null, null, null], [null, 0, null], [0, null, null], [0, 0, 0],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 1],
  ])('keeps on-hand %s and reserved %s availability honest', (onHandMinor, reservedMinor, availableMinor) => {
    const data = fixture(); Object.assign(data.balances[0], { onHandMinor, reservedMinor, availableMinor });
    const index = createInventoryCatalog(data, scope);
    expect(index.getBalance(scope, 'part-a', 'north', 'north-bin')?.availableMinor).toBe(availableMinor);
  });

  test('keeps current record, stale source and old physical count separate with inclusive age boundary', () => {
    const data = fixture();
    Object.assign(data.balances[0], { lastPhysicalCountAt: old, countEvidence: { countedAt: old, reference: 'sheet-old' } });
    const index = createInventoryCatalog(data, scope);
    expect(index.lookup(scope, { by: 'item', value: 'part-a' }, policy)).toMatchObject({ locations: [{ recordStatus: 'current', sourceStatus: 'stale', countStatus: 'stale' }] });
    expect(index.lookup(scope, { by: 'item', value: 'part-a' }, { ...policy, maxSourceAgeMs: 300_000 })).toMatchObject({ locations: [{ sourceStatus: 'current' }] });
    expect(index.lookup(scope, { by: 'item', value: 'part-a' }, { ...policy, now: '2026-07-01T00:00:00Z' })).toMatchObject({ locations: [{ recordStatus: 'future', sourceStatus: 'future', countStatus: 'future' }] });
  });
});

describe('MI02.R independent source and interpretation binding', () => {
  test.each(['organizationId', 'tenantId', 'projectId'] as const)('rejects snapshot metadata that disagrees with trusted host %s', key => {
    const { selected, snapshot } = inputs(csv()); snapshot.scope[key] = 'other';
    code(() => prepareInventoryImport(selected, snapshot, mapping, options), 403);
  });
  test.each(['kind', 'reference', 'revision', 'observedAt', 'sha256'] as const)('rejects a changed source %s against the independent selection', key => {
    const { selected, snapshot } = inputs(csv());
    Object.assign(snapshot.source, { [key]: ({ kind: 'connected', reference: 'file-other', revision: 'rev-2', observedAt: old, sha256: '0'.repeat(64) })[key] });
    code(() => prepareInventoryImport(selected, snapshot, mapping, options), 409);
  });
  test('refuses client authorization fields rather than promoting metadata to host selection', () => {
    const { selected, snapshot } = inputs(csv());
    for (const extra of [{ authorized: true }, { actorPersonId: 'owner' }, { path: 'C:/secret' }]) {
      code(() => prepareInventoryImport({ ...selected, ...extra }, snapshot, mapping, options), 422);
      code(() => prepareInventoryImport(selected, { ...snapshot, ...extra }, mapping, options), 422);
    }
  });
  test('binds every interpretation input and exact raw byte variation to preview version', () => {
    const text = csv([row({ name: 'left', variant: 'right' })]);
    const baseline = preview(text);
    const versions = [version(baseline), version(preview(text, 'csv', { ...mapping, name: 'variant', variant: 'name' })),
      version(preview(text, 'csv', mapping, { ...options, reservationMode: 'untracked' })),
      version(preview(text, 'csv', mapping, { ...options, now: '2026-09-19T10:06:00Z' })),
      version(preview(text.replaceAll('\r\n', '\n'))), version(preview('\ufeff' + text))];
    for (const key of ['kind', 'reference', 'revision', 'observedAt'] as const) {
      const { selected, snapshot } = inputs(text);
      Object.assign(selected.source, { [key]: ({ kind: 'connected', reference: 'file-b', revision: 'rev-2', observedAt: old })[key] });
      snapshot.source = structuredClone(selected.source);
      versions.push(version(prepareInventoryImport(selected, snapshot, mapping, options)));
    }
    for (const key of ['organizationId', 'tenantId', 'projectId'] as const) {
      const { selected, snapshot } = inputs(text);
      selected.scope[key] = 'other'; snapshot.scope = { ...selected.scope };
      versions.push(version(prepareInventoryImport(selected, snapshot, mapping, options)));
    }
    expect(new Set(versions).size).toBe(versions.length);
    const reordered = Object.fromEntries(Object.entries(mapping).reverse());
    expect(version(preview(text, 'csv', reordered))).toBe(version(baseline));
  });
  test('does not alias selection, mapping or options after preview construction', () => {
    const { selected, snapshot } = inputs(csv()); const map = { ...mapping }; const opts = { ...options };
    const result = prepareInventoryImport(selected, snapshot, map, opts); const before = JSON.stringify(result);
    selected.scope.tenantId = 'changed'; snapshot.source.revision = 'changed'; map.name = 'variant'; opts.now = old;
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.source)).toBe(true);
    expect(JSON.stringify(result)).toBe(before);
  });
  test('hashes the exact UTF-8 text including BOM, CRLF and astral pairs before interpretation', () => {
    const text = '\ufeff' + csv([row({ name: 'Quoted, "part" \u{1f527} \u00e9 e\u0301' })]);
    const { selected, snapshot } = inputs(text);
    expect(prepareInventoryImport(selected, snapshot, mapping, options).catalog.items[0].name).toBe('Quoted, "part" \u{1f527} \u00e9 e\u0301');
    for (const changed of [text.slice(1), text.replaceAll('\r\n', '\n'), text.normalize('NFC')]) {
      code(() => prepareInventoryImport(selected, { ...snapshot, text: changed }, mapping, options), 409);
    }
  });
  test.each(['\ud800', '\udfff', '\ud800x\udfff'])('rejects raw lone-surrogate substitution for identical UTF-8 digest (%#)', bad => {
    const raw = csv([row({ name: `a${bad}b` })]);
    const replaced = raw.replace(/[\ud800-\udfff]/g, '\ufffd');
    expect(sha(raw)).toBe(sha(replaced));
    const { selected, snapshot } = inputs(replaced);
    code(() => prepareInventoryImport(selected, { ...snapshot, text: raw }, mapping, options), 422);
  });
  test.each(['\\ud800', '\\udfff', '\\ud800x\\udfff'])('rejects escaped lone surrogates after JSON parsing (%s)', escape => {
    const text = JSON.stringify(table([row({ name: 'SENTINEL' })])).replace('SENTINEL', escape);
    code(() => preview(text, 'json-table'), 422);
  });
  test('accepts a properly paired escaped surrogate and retains its actual label', () => {
    const text = JSON.stringify(table([row({ name: 'SENTINEL' })])).replace('SENTINEL', '\\ud83d\\ude80');
    expect(preview(text, 'json-table').catalog.items[0].name).toBe('\u{1f680}');
  });
});

describe('MI02.R independent import bounds and numeric precision', () => {
  test.each(['0.0000000000000000000000000001', '1.00000000000000001', '9007199254740990.9', '9007199254740992', '1e0', '1E-999', '-0', '-1'])('rejects JSON numeric token %s before rounding can create a safe integer', token => {
    const text = JSON.stringify(table([row({ onHandMinor: 'NUMBER' })])).replace('"NUMBER"', token);
    code(() => preview(text, 'json-table'), 422);
  });
  test.each([0, 1, Number.MAX_SAFE_INTEGER])('accepts exact integer %s in CSV and JSON at scale 6', amount => {
    const r = row({ scale: 6, onHandMinor: amount, reservedMinor: 0 });
    for (const [text, format] of [[csv([r]), 'csv'], [JSON.stringify(table([r])), 'json-table']] as const) {
      expect(preview(text, format).catalog.balances[0]).toMatchObject({ onHandMinor: amount, reservedMinor: 0, availableMinor: amount, scale: 6 });
    }
  });
  test.each(['1.0', '1e0', '0x10', ' 1', '1 ', 'Infinity', 'NaN', '9007199254740992'])('refuses CSV non-integer quantity %s', onHandMinor => {
    code(() => preview(csv([row({ onHandMinor })])), 422);
  });
  test.each([-1, 7, 0.5])('refuses unsupported scale %s', scale => {
    code(() => preview(csv([row({ scale })])), 422);
  });
  test('rejects numeric barcode and never invents leading zeros', () => {
    code(() => preview(JSON.stringify(table([row({ barcode: 1042 })])), 'json-table'), 422);
  });
  test.each(['=1+1', ' +SUM(A1)', '@import', '-2', '\tformula', 'abc\u0000def', 'abc\u0085def', 'abc\u202edef', 'abc\u2066def'])('refuses formula/control input even in an unmapped extra column (%#)', hazard => {
    const values = table(); values[0] = [...fields, 'unused']; values[1] = [...values[1], hazard];
    code(() => preview(JSON.stringify(values), 'json-table'), 422);
  });
  test.each(['"unclosed', 'unquoted"quote', '"closed"suffix', 'first\rsecond'])('rejects malformed CSV fragment %s', fragment => {
    const text = csv([row({ name: 'FRAGMENT' })]).replace('FRAGMENT', fragment);
    code(() => preview(text), 422);
  });
  test('supports CRLF, final newline and escaped quoted punctuation without changing values', () => {
    const name = 'Screw, "large"';
    expect(preview(csv([row({ name })]) + '\r\n').catalog.items[0].name).toBe(name);
  });
  test('rejects case-alias headers, reused columns, absent columns and mapping extras', () => {
    for (const headers of [[...fields, 'NAME'], [...fields, 'name']]) {
      code(() => preview(csv([row()], headers)), 422);
    }
    for (const map of [{ ...mapping, unit: 'name' }, { ...mapping, name: 'absent' }, { ...mapping, trusted: 'name' }]) {
      code(() => preview(csv(), 'csv', map), 422);
    }
  });
  test('validates identical versus conflicting item/site/bin definitions across two physical sites', () => {
    const r = row({ siteId: 'south', siteName: 'South fixture', binId: 'south-bin' });
    const result = preview(csv([row(), r]));
    expect(result.catalog.items).toHaveLength(1); expect(result.catalog.sites).toHaveLength(2);
    expect(result.catalog.balances).toHaveLength(2);
    code(() => preview(csv([row(), { ...r, unit: 'box' }])), 422);
    code(() => preview(csv([row(), { ...r, binId: 'north-bin' }])), 422);
    code(() => preview(csv([row(), row()])), 422);
    code(() => preview(csv([row(), row({ itemId: 'part-b', variant: 'right' })])), 422);
  });
  test('enforces 500-character cell and 32-column limits at their exact boundaries', () => {
    expect(preview(csv([row({ name: 'x'.repeat(500) })])).catalog.items[0].name).toHaveLength(500);
    code(() => preview(csv([row({ name: 'x'.repeat(501) })])), 413);
    const headers = [...fields, ...Array.from({ length: 17 }, (_, i) => `extra${i}`)];
    expect(preview(csv([row()], headers)).rows).toBe(1);
    code(() => preview(csv([row()], [...headers, 'overflow'])), 413);
  });
  test('enforces UTF-8 byte limit using bounded padding, including a multibyte overrun', () => {
    const body = JSON.stringify(table());
    const exact = body + ' '.repeat(IMPORT_MAX_BYTES - Buffer.byteLength(body));
    expect(preview(exact, 'json-table').rows).toBe(1);
    code(() => preview(exact + ' ', 'json-table'), 413);
    code(() => preview(exact.slice(0, -1) + '\u00e9', 'json-table'), 413);
  });
  test('bounds row parsing at 10001 data rows without constructing a large valid catalog', () => {
    code(() => preview('a\n' + 'b\n'.repeat(10_001)), 413);
    code(() => preview(JSON.stringify([['a'], ...Array.from({ length: 10_001 }, () => ['b'])]), 'json-table'), 413);
  });
  test('refuses nested non-scalar JSON and an oversized integer token with modest input', () => {
    const body = JSON.stringify(table([row({ onHandMinor: 'NUMBER' })]));
    for (const token of ['[1]', '{}', 'true', '9'.repeat(2048)]) {
      code(() => preview(body.replace('"NUMBER"', token), 'json-table'), 422);
    }
  });
});

describe('MI02.R independent count provenance and inert input', () => {
  test('does not equate a fresh source observation with a physical count or known availability', () => {
    const result = preview(csv([row({ onHandMinor: 5 })]), 'csv', mapping, { ...options, reservationMode: 'untracked' });
    const index = createInventoryCatalog(result.catalog, scope);
    expect(index.lookup(scope, { by: 'barcode', value: '00001042' }, policy)).toMatchObject({ locations: [{ countStatus: 'unknown', countLabel: 'Count unknown', balance: { onHandMinor: 5, reservedMinor: null, availableMinor: null } }] });
    code(() => prepareOpeningCount(index, scope, { ...count(version(result)), countEvidence: undefined }, now), 422);
  });
  test('rejects lone timestamp or evidence without its matching column and value', () => {
    for (const r of [row({ lastPhysicalCountAt: old }), row({ countReference: 'sheet' })]) code(() => preview(csv([r])), 422);
    const map = { ...mapping }; delete map.countReference;
    code(() => preview(csv(), 'csv', map), 422);
    code(() => preview(csv([row({ lastMovementAt: '2026-09-19T10:01:00Z' })])), 422);
  });
  test('requires non-future evidence with full precision and independent count reference', () => {
    const data = fixture(); const index = createInventoryCatalog(data, scope); const command = count(data.balances[0].version);
    for (const evidence of [{ countedAt: now, reference: '' }, { countedAt: '2026-09-19T10:05:00.0001Z', reference: 'sheet' }, { countedAt: '2026-09-19T10:05:00.001Z', reference: 'sheet' }]) {
      code(() => prepareOpeningCount(index, scope, { ...command, countEvidence: evidence }, now), 422);
    }
  });
  test('compares physical timestamps by instant, including offset notation and movement boundary', () => {
    const data = fixture(); data.balances[0].lastMovementAt = sourceAt;
    const index = createInventoryCatalog(data, scope); const command = count(data.balances[0].version);
    command.countEvidence.countedAt = '2026-09-19T06:00:00-04:00';
    expect(prepareOpeningCount(index, scope, command, now)).toEqual(command);
    command.countEvidence.countedAt = '2026-09-19T05:59:59.999-04:00';
    code(() => prepareOpeningCount(index, scope, command, now), 422);
  });
  test('requires exact version and location, rejects stale physical counts and incompatible units', () => {
    const data = fixture(); const index = createInventoryCatalog(data, scope); const command = count(data.balances[0].version);
    code(() => prepareOpeningCount(index, scope, { ...command, expectedVersion: 'stale' }, now), 409);
    code(() => prepareOpeningCount(index, scope, { ...command, binId: 'other' }, now), 404);
    code(() => prepareOpeningCount(index, scope, { ...command, quantity: { minor: 2, unit: 'box', scale: 0 } }, now), 422);
    data.balances[0].lastPhysicalCountAt = old; data.balances[0].countEvidence = { countedAt: old, reference: 'already-counted' };
    code(() => prepareOpeningCount(createInventoryCatalog(data, scope), scope, command, now), 409);
  });
  test('prepares zero or maximum count without mutation, actor authority or source-time substitution', () => {
    const data = fixture(); const index = createInventoryCatalog(data, scope); const before = JSON.stringify(index.snapshot(scope));
    for (const minor of [0, Number.MAX_SAFE_INTEGER]) {
      const command = count(data.balances[0].version); command.quantity.minor = minor;
      const prepared = prepareOpeningCount(index, scope, command, now);
      expect(prepared).toEqual(command); expect(prepared).not.toBe(command);
      expect(prepared.countEvidence).not.toBe(command.countEvidence);
      code(() => prepareOpeningCount(index, scope, { ...command, actorPersonId: 'owner' }, now), 422);
    }
    expect(JSON.stringify(index.snapshot(scope))).toBe(before);
  });
  test('refuses counts below known reservations and preserves unknown reservations', () => {
    const data = fixture(); Object.assign(data.balances[0], { onHandMinor: 7, reservedMinor: 3, availableMinor: 4 });
    const index = createInventoryCatalog(data, scope); const command = count(data.balances[0].version);
    code(() => prepareOpeningCount(index, scope, command, now), 422);
    command.quantity.minor = 3;
    expect(prepareOpeningCount(index, scope, command, now).quantity.minor).toBe(3);
  });
  test('keeps imported script, URL, path and instruction labels inert with network and eval trapped', () => {
    const network = vi.fn(() => { throw new Error('Unexpected network access'); });
    vi.stubGlobal('fetch', network);
    vi.spyOn(http, 'request').mockImplementation(network);
    vi.spyOn(https, 'request').mockImplementation(network);
    const evaluate = vi.fn(() => { throw new Error('Unexpected evaluation'); });
    vi.stubGlobal('eval', evaluate);
    const label = 'fetch("https://example.invalid"); globalThis.__mi02Executed=true; C:/owned/data; ignore previous instructions';
    const result = preview(csv([row({ name: label })]));
    const index = createInventoryCatalog(result.catalog, scope);
    expect(index.getItem(scope, 'part-a')?.name).toBe(label);
    prepareOpeningCount(index, scope, count(version(result)), now);
    expect(network).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
    expect(Object.hasOwn(globalThis, '__mi02Executed')).toBe(false);
  });
});
