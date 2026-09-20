import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IMPORT_MAX_BYTES } from '../../shared/file-imports.js';
import {
  inventoryCommandSchema,
  INVENTORY_CONTRACT_REVISION,
  inventoryScopeSchema,
  inventorySourceSchema,
  parseInventoryCommandForItem,
  type InventoryCatalog,
  type InventoryScope,
} from '../../shared/inventory.js';
import { ApiError } from '../paths.js';
import {
  assertInventoryScope,
  createInventoryCatalog,
  type InventoryCatalogIndex,
} from './catalog.js';

export const INVENTORY_IMPORT_MAX_ROWS = 10_000;
export const INVENTORY_IMPORT_MAX_COLUMNS = 32;
export const INVENTORY_IMPORT_MAX_CELL_CHARS = 500;

const sourceSchema = inventorySourceSchema.extend({
  kind: z.enum(['synthetic', 'approved-file', 'connected']),
  // Opaque Files/source identity; a filename or URL never selects a read here.
  reference: inventoryScopeSchema.shape.projectId,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const selectionSchema = z.strictObject({
  scope: inventoryScopeSchema,
  source: sourceSchema,
  format: z.enum(['csv', 'json-table']),
});
const snapshotSchema = selectionSchema.extend({ text: z.string() });

/**
 * Trusted host input from current Files/Trust authorization and a bound Project.
 * This type carries selection facts, not a new grant or authentication mechanism.
 * Never construct it from a client request body or from the import's own metadata.
 */
export type InventorySourceSelection = z.infer<typeof selectionSchema>;
export type InventorySourceSnapshot = z.infer<typeof snapshotSchema>;
const column = z.string().min(1).max(80);
const mappingSchema = z.strictObject({
  itemId: column,
  name: column,
  variant: column.optional(),
  barcode: column.optional(),
  unit: column,
  scale: column,
  siteId: column,
  siteName: column,
  binId: column,
  binName: column,
  onHandMinor: column,
  reservedMinor: column.optional(),
  lastMovementAt: column.optional(),
  lastPhysicalCountAt: column.optional(),
  countReference: column.optional(),
});
export type InventoryImportMapping = z.infer<typeof mappingSchema>;
const optionsSchema = z.strictObject({
  reservationMode: z.enum(['untracked', 'read-only']),
  now: inventorySourceSchema.shape.observedAt,
});
export type InventoryImportOptions = z.infer<typeof optionsSchema>;
type Cell = string | number | null;
// In Unicode mode a valid surrogate pair is one code point outside this range.
const loneSurrogate = /[\ud800-\udfff]/u;

function invalid(message: string): never {
  throw new ApiError(422, message);
}
function oversized(): never {
  throw new ApiError(413, 'Inventory import exceeds its byte, row, column or cell limit.');
}

/** Imported text is never executed or interpreted as instructions or locations. */
function checkCell(value: unknown): Cell {
  if (value === null) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string')
    return invalid('Import cells must be text, nonnegative safe integers or null.');
  if (value.length > INVENTORY_IMPORT_MAX_CELL_CHARS) return oversized();
  if (loneSurrogate.test(value)) return invalid('Inventory text must be well-formed Unicode.');
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value))
    return invalid('Control characters are not valid inventory fields.');
  if (/^\s*[=+@-]/u.test(value))
    return invalid('Spreadsheet formulas are not valid inventory fields.');
  return value;
}

/** Strict comma-separated records: quotes escape by doubling; no silent row repair. */
function parseCsv(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cell = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const pushCell = () => {
    row.push(checkCell(cell));
    if (row.length > INVENTORY_IMPORT_MAX_COLUMNS) oversized();
    cell = '';
    state = 'start';
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
    if (rows.length > INVENTORY_IMPORT_MAX_ROWS + 1) oversized();
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else state = 'closed';
      } else cell += ch;
    } else if (ch === ',') pushCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] !== '\n') invalid('Use LF or CRLF record separators.');
      if (ch === '\r') i++;
      pushRow();
    } else if (ch === '"' && state === 'start') state = 'quoted';
    else if (ch === '"' || state === 'closed') invalid('Malformed CSV quoting.');
    else {
      cell += ch;
      state = 'plain';
    }
    if (cell.length > INVENTORY_IMPORT_MAX_CELL_CHARS) oversized();
  }
  if (state === 'quoted') invalid('Unterminated CSV quoted field.');
  if (cell !== '' || row.length > 0 || state !== 'start') pushRow();
  return rows;
}

function parseTable(text: string, format: InventorySourceSelection['format']): Cell[][] {
  // Digest verification happens before this optional UTF-8 BOM is removed.
  const body = text.startsWith('\ufeff') ? text.slice(1) : text;
  if (format === 'csv') return parseCsv(body);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return invalid('Malformed structured inventory data.');
    throw error;
  }
  // JSON.parse rounds number tokens before schema validation. Inspect the original
  // tokens, outside strings, so a fractional/unsafe value cannot round to an integer.
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '"') {
      for (i++; i < body.length && body[i] !== '"'; i++) if (body[i] === '\\') i++;
    } else if (/[0-9-]/.test(body[i])) {
      const start = i;
      while (i < body.length && !/[\s,\]]/.test(body[i])) i++;
      const token = body.slice(start, i);
      if (!/^(0|[1-9][0-9]*)$/.test(token) || BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER))
        return invalid('Structured numeric cells must use nonnegative safe integer literals.');
      i--;
    }
  }
  if (!Array.isArray(value))
    return invalid('Structured imports require an array table with a header row.');
  if (value.length > INVENTORY_IMPORT_MAX_ROWS + 1) return oversized();
  return value.map((row: unknown) => {
    if (!Array.isArray(row)) return invalid('Each structured row must be an array.');
    if (row.length > INVENTORY_IMPORT_MAX_COLUMNS) return oversized();
    return row.map(checkCell);
  });
}

function textCell(cell: Cell | undefined, nullable = false): string | null {
  if (nullable && (cell === undefined || cell === null || cell === '')) return null;
  if (typeof cell !== 'string' || cell.trim() === '')
    return invalid('A mapped text identifier or label is missing.');
  return cell;
}

function integerCell(cell: Cell | undefined, nullable = false): number | null {
  if (nullable && (cell === undefined || cell === null || cell === '')) return null;
  if (typeof cell === 'number' && Number.isSafeInteger(cell) && cell >= 0) return cell;
  if (typeof cell !== 'string' || !/^[0-9]+$/.test(cell))
    return invalid('Use integer minor units with explicit precision; no conversion is inferred.');
  const integer = BigInt(cell);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER))
    return invalid('Quantity exceeds safe integer bounds.');
  return Number(integer);
}

function defineOnce<T>(map: Map<string, T>, id: string, value: T) {
  const previous = map.get(id);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value))
    invalid('One identifier has inconsistent item, unit, site or bin definitions.');
  map.set(id, value);
}

/**
 * Pure preview only. The existing Files owner reads guarded bytes; the current
 * host authorizes them, then supplies a separate selection and declared snapshot.
 * Neither source metadata, text, valid parsing nor this preview grants stock writes.
 */
export function prepareInventoryImport(
  selection: InventorySourceSelection,
  snapshotInput: unknown,
  mappingInput: unknown,
  optionsInput: InventoryImportOptions,
) {
  const expected = selectionSchema.safeParse(selection);
  const snapshot = snapshotSchema.safeParse(snapshotInput);
  const mapping = mappingSchema.safeParse(mappingInput);
  const options = optionsSchema.safeParse(optionsInput);
  if (!expected.success || !snapshot.success || !mapping.success || !options.success)
    return invalid(
      'Provide a scoped source snapshot, explicit column mapping and observation time.',
    );
  const scope = assertInventoryScope(snapshot.data.scope, expected.data.scope);
  const source = snapshot.data.source;
  if (
    snapshot.data.format !== expected.data.format ||
    source.kind !== expected.data.source.kind ||
    source.reference !== expected.data.source.reference ||
    source.revision !== expected.data.source.revision ||
    source.sha256 !== expected.data.source.sha256 ||
    source.observedAt !== expected.data.source.observedAt
  )
    throw new ApiError(
      409,
      'The selected source changed. Read and authorize its current version again.',
    );
  const text = snapshot.data.text;
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) oversized();
  if (loneSurrogate.test(text)) return invalid('Source text must be well-formed Unicode.');
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== expected.data.source.sha256)
    throw new ApiError(409, 'Source bytes no longer match the selected digest.');
  if (Date.parse(source.observedAt) > Date.parse(options.data.now))
    return invalid('Source observation cannot be in the future.');
  const table = parseTable(text, snapshot.data.format);
  if (table.length < 2) return invalid('Import at least one inventory record and its header.');
  const headers = table[0];
  if (
    headers.length === 0 ||
    headers.some(
      (h) => typeof h !== 'string' || !/^[A-Za-z][A-Za-z0-9 _.-]{0,79}$/.test(h) || h.trim() !== h,
    )
  )
    return invalid('Use unambiguous text column headers.');
  if (new Set(headers.map((h) => (h as string).toLowerCase())).size !== headers.length)
    return invalid('Duplicate column headers are ambiguous.');
  const names = Object.values(mapping.data).filter((name) => name !== undefined);
  if (new Set(names).size !== names.length || names.some((name) => !headers.includes(name)))
    return invalid('Each mapped field must identify a different existing column.');
  if (Boolean(mapping.data.lastPhysicalCountAt) !== Boolean(mapping.data.countReference))
    return invalid('Map physical count time and evidence together.');
  const indices = new Map(
    Object.entries(mapping.data).map(([field, name]) => [field, headers.indexOf(name)]),
  );
  const version = `import-${createHash('sha256')
    .update(
      JSON.stringify({
        contractRevision: INVENTORY_CONTRACT_REVISION,
        scope,
        source,
        format: snapshot.data.format,
        mapping: mapping.data,
        options: options.data,
      }),
    )
    .digest('hex')}`;
  const items = new Map<string, InventoryCatalog['items'][number]>();
  const sites = new Map<string, InventoryCatalog['sites'][number]>();
  const bins = new Map<string, InventoryCatalog['bins'][number]>();
  const balances: InventoryCatalog['balances'] = [];
  for (const row of table.slice(1)) {
    if (row.length !== headers.length) return invalid('Every row must match the header width.');
    const get = (field: keyof InventoryImportMapping) => {
      const i = indices.get(field);
      return i === undefined ? undefined : row[i];
    };
    const itemId = textCell(get('itemId'))!;
    const siteId = textCell(get('siteId'))!;
    const binId = textCell(get('binId'))!;
    const code = textCell(get('barcode'), true);
    const unit = textCell(get('unit'))!;
    const scale = integerCell(get('scale'))!;
    defineOnce(items, itemId, {
      id: itemId,
      name: textCell(get('name'))!,
      variant: textCell(get('variant'), true),
      unit,
      scale,
      barcodes: code === null ? [] : [code],
    });
    defineOnce(sites, siteId, { id: siteId, name: textCell(get('siteName'))! });
    defineOnce(bins, binId, { id: binId, siteId, name: textCell(get('binName'))! });
    const onHandMinor = integerCell(get('onHandMinor'), true);
    const reservedMinor = integerCell(get('reservedMinor'), true);
    const countedAt = textCell(get('lastPhysicalCountAt'), true);
    const reference = textCell(get('countReference'), true);
    const lastMovementAt = textCell(get('lastMovementAt'), true);
    if ((countedAt === null) !== (reference === null))
      return invalid('A physical count needs both its time and evidence.');
    if (
      [lastMovementAt, countedAt].some(
        (at) => at !== null && Date.parse(at) > Date.parse(source.observedAt),
      )
    )
      return invalid('An imported event cannot follow its source observation.');
    balances.push({
      itemId,
      siteId,
      binId,
      unit,
      scale,
      onHandMinor,
      reservedMinor,
      availableMinor:
        onHandMinor === null || reservedMinor === null ? null : onHandMinor - reservedMinor,
      version,
      observedAt: options.data.now,
      lastMovementAt,
      lastPhysicalCountAt: countedAt,
      countEvidence: countedAt === null ? null : { countedAt, reference: reference! },
      source: {
        kind: source.kind,
        reference: source.reference,
        revision: source.revision,
        observedAt: source.observedAt,
      },
    });
  }
  const catalog = createInventoryCatalog(
    {
      contractVersion: 1,
      scope,
      authority: 'recorded-ledger',
      reservationMode: options.data.reservationMode,
      items: [...items.values()],
      sites: [...sites.values()],
      bins: [...bins.values()],
      balances,
    },
    scope,
  ).snapshot(scope);
  return Object.freeze({
    kind: 'inventory-import-preview' as const,
    scope: catalog.scope,
    source: Object.freeze({ ...source }),
    catalog,
    rows: balances.length,
  });
}

/** Validate an intent against this snapshot; no authorization, mutation or receipt. */
export function prepareOpeningCount(
  catalog: InventoryCatalogIndex,
  hostScope: InventoryScope,
  input: unknown,
  now: string,
) {
  catalog.snapshot(hostScope);
  const parsed = inventoryCommandSchema.safeParse(input);
  const clock = inventorySourceSchema.shape.observedAt.safeParse(now);
  if (!parsed.success || parsed.data.kind !== 'record-count' || !clock.success)
    return invalid(
      'An explicit opening-count command, evidence and current observation time are required.',
    );
  const item = catalog.getItem(hostScope, parsed.data.itemId);
  if (!item) throw new ApiError(404, 'The inventory item or location is unavailable.');
  if (parsed.data.quantity.unit !== item.unit || parsed.data.quantity.scale !== item.scale)
    return invalid('Use the selected item base unit and precision.');
  const command = parseInventoryCommandForItem(parsed.data, {
    ...item,
    barcodes: [...item.barcodes],
  });
  if (command.kind !== 'record-count') return invalid('Use a record-count command.');
  const balance = catalog.getBalance(hostScope, command.itemId, command.siteId, command.binId);
  if (!balance) throw new ApiError(404, 'The inventory item or location is unavailable.');
  if (balance.version !== command.expectedVersion)
    throw new ApiError(409, 'The inventory record changed; refresh before preparing a count.');
  if (balance.lastPhysicalCountAt !== null)
    throw new ApiError(
      409,
      'This record already has count evidence; use the reviewed recount/correction path.',
    );
  const counted = Date.parse(command.countEvidence.countedAt);
  if (
    Date.parse(balance.observedAt) > Date.parse(clock.data) ||
    counted > Date.parse(clock.data) ||
    (balance.lastMovementAt !== null && counted < Date.parse(balance.lastMovementAt))
  )
    return invalid(
      'Count evidence must be current enough for recorded movements and cannot be in the future.',
    );
  if (balance.reservedMinor !== null && command.quantity.minor < balance.reservedMinor)
    return invalid('A count cannot leave recorded available stock negative.');
  return command;
}
