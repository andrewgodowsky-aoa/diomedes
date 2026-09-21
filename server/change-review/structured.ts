/**
 * The structured change source: a mechanical before/after differ for ordinary
 * records — the same mechanism whether the record is a restaurant's weekly
 * report, a salon's reminder automation, or a governed configuration.
 *
 * The differ knows no domain. A `StructuredRecord` is a labelled bag of fields;
 * each field descriptor supplies a stable `path`, a human `label`, a `kind`
 * (`value` scalars, `list` collections, `set` unordered collections) and
 * optional attention `flagCodes` the review raises when that field moves. A
 * field marked `sensitive` reports that it changed and never what it holds.
 *
 * Output feeds the same `ChangeEntry`/`StructuredFieldChange` contract every
 * other source produces, so rules, flags, checks, the renderer and the UI treat
 * a business setting exactly like a file.
 */

import {
  EMPTY_TEXT_EVIDENCE,
  escapeVisible,
  MASKED_VALUE,
  type ChangeEvidenceRef,
  type ChangeEntry,
  type StructuredFieldChange,
} from '../../shared/change-manifest.js';

export interface StructuredField {
  /** Stable machine path, unique within the record — the fact's anchor. */
  readonly path: string;
  /** The words a person reads for this field. */
  readonly label: string;
  readonly kind: 'value' | 'list' | 'set';
  /** Attention codes the review raises when this field changes. */
  readonly flagCodes?: readonly string[];
  /** Values are never stored or rendered — only that the field changed. */
  readonly sensitive?: boolean;
}

export interface StructuredRecord {
  readonly id: string;
  /** What the record is, in words a person reads. */
  readonly label: string;
  readonly fields: readonly StructuredField[];
  /** The record's values, keyed by field path. */
  readonly values: Readonly<Record<string, unknown>>;
}

/** Member names stored per side of a collection diff — display, not the count. */
const MAX_MEMBERS = 64;
/** Members inspected for the diff; `*Total` fields still carry the raw count. */
const MEMBER_SCAN_MAX = 8192;
/** Characters of a scalar display value stored in the manifest. */
const SCALAR_DISPLAY_MAX = 256;

interface MemberList {
  readonly items: readonly string[];
  /** The raw member count — honest even when `items` stopped at the scan cap. */
  readonly total: number;
  readonly truncated: boolean;
}

function members(value: unknown): MemberList {
  const raw: readonly unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.keys(value as Record<string, unknown>)
      : [];
  const items: string[] = [];
  for (const item of raw.slice(0, MEMBER_SCAN_MAX))
    if (['string', 'number', 'boolean'].includes(typeof item)) items.push(String(item));
  return { items, total: raw.length, truncated: raw.length > MEMBER_SCAN_MAX };
}

interface ScalarValue {
  readonly text: string | null;
  readonly truncated: boolean;
}

function scalarText(value: unknown): ScalarValue {
  let text: string | null;
  if (value === undefined || value === null) text = null;
  else if (typeof value === 'boolean') text = value ? 'On' : 'Off';
  else if (typeof value === 'number') text = String(value);
  else if (typeof value === 'string') text = value;
  else text = JSON.stringify(value) ?? null;
  if (text !== null && text.length > SCALAR_DISPLAY_MAX)
    return { text: `${text.slice(0, SCALAR_DISPLAY_MAX)}…`, truncated: true };
  return { text, truncated: false };
}

/**
 * Compare two states of one record, field by field, in descriptor order.
 * `before`/`after` may be null (record did not exist then); every field then
 * reports added/removed rather than changed.
 */
export function compareStructured(
  recordId: string,
  fields: readonly StructuredField[],
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): StructuredFieldChange[] {
  const changes: StructuredFieldChange[] = [];
  for (const field of fields) {
    const had = before !== null && Object.prototype.hasOwnProperty.call(before, field.path);
    const has = after !== null && Object.prototype.hasOwnProperty.call(after, field.path);
    const flagCodes = field.flagCodes ?? [];
    if (field.sensitive) {
      const moved =
        JSON.stringify(before?.[field.path] ?? null) !==
        JSON.stringify(after?.[field.path] ?? null);
      changes.push({
        path: field.path,
        label: field.label,
        kind: moved ? 'changed' : 'unchanged',
        before: MASKED_VALUE,
        after: MASKED_VALUE,
        added: [],
        removed: [],
        addedTotal: 0,
        removedTotal: 0,
        valueTruncated: false,
        flagCodes: moved ? flagCodes : [],
        sensitive: true,
      });
      continue;
    }
    if (field.kind === 'list' || field.kind === 'set') {
      const beforeList = members(before?.[field.path]);
      const afterList = members(after?.[field.path]);
      const beforeSet = new Set(beforeList.items);
      const afterSet = new Set(afterList.items);
      const added = afterList.items.filter((item) => !beforeSet.has(item));
      const removed = beforeList.items.filter((item) => !afterSet.has(item));
      const sameOrder =
        field.kind === 'set' || beforeList.items.join('') === afterList.items.join('');
      if (!had && !has) continue;
      const moved = !had || !has || added.length > 0 || removed.length > 0 || !sameOrder;
      changes.push({
        path: field.path,
        label: field.label,
        kind: !moved ? 'unchanged' : !had ? 'added' : !has ? 'removed' : 'collection',
        before: had ? `${beforeList.total}` : null,
        after: has ? `${afterList.total}` : null,
        added: added.slice(0, MAX_MEMBERS),
        removed: removed.slice(0, MAX_MEMBERS),
        addedTotal: added.length,
        removedTotal: removed.length,
        valueTruncated:
          beforeList.truncated || afterList.truncated || added.length > MAX_MEMBERS ||
          removed.length > MAX_MEMBERS,
        flagCodes: moved ? flagCodes : [],
        sensitive: false,
      });
      continue;
    }
    const was = scalarText(before?.[field.path]);
    const now = scalarText(after?.[field.path]);
    const kind = !had ? 'added' : !has ? 'removed' : was.text !== now.text ? 'changed' : 'unchanged';
    if (!had && !has) continue;
    changes.push({
      path: field.path,
      label: field.label,
      kind,
      before: kind === 'added' ? null : was.text,
      after: kind === 'removed' ? null : now.text,
      added: [],
      removed: [],
      addedTotal: 0,
      removedTotal: 0,
      valueTruncated: was.truncated || now.truncated,
      flagCodes: kind === 'unchanged' ? [] : flagCodes,
      sensitive: false,
    });
  }
  return changes;
}

/**
 * Wrap one compared record in the `ChangeEntry` every source produces. The
 * entry's `kind` summarizes: any field that moved makes the record `modified`;
 * a record that exists only after is `added`, only before is `deleted`.
 */
export function structuredEntry(
  record: StructuredRecord,
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): ChangeEntry {
  const fields = compareStructured(record.id, record.fields, before, after);
  const kind = before === null ? 'added' : after === null ? 'deleted' : 'modified';
  const evidence: ChangeEvidenceRef[] = fields
    .filter((field) => field.kind !== 'unchanged')
    .map((field) => ({ kind: 'structured', recordId: record.id, fieldPath: field.path }));
  return {
    id: `structured:${record.id}`,
    path: record.label,
    kind,
    attribution: 'declared',
    source: 'structured',
    beforeSha: null,
    afterSha: null,
    sizeBefore: null,
    sizeAfter: null,
    addedLines: null,
    removedLines: null,
    binary: false,
    modeBefore: null,
    modeAfter: null,
    renamedFrom: null,
    textEvidence: EMPTY_TEXT_EVIDENCE,
    changeIds: [],
    settled: null,
    historyEntryIds: [],
    fields,
    evidence,
  };
}

/** Escape a structured display value for rendering. */
export function displayValue(value: string | null): string {
  return value === null ? '—' : escapeVisible(value);
}
