// The chart spec: the one JSON shape a ```chart fence may hold. Frozen for v1
// (docs/product/2026-09-22-model-artifacts.md); the v2 model instruction will
// teach exactly this. Validation is strict and every refusal names the problem,
// because an error card that says "invalid chart" teaches nobody anything.
// Pure: no React, no DOM.

import { DECLARED_ID } from './artifacts';
import type { SegmentState } from './segment-bar-model';

export const CHART_TYPES = ['bar', 'line', 'area', 'donut', 'progress', 'segments'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const STEP_STATES = ['done', 'active', 'pending', 'failed', 'blocked'] as const;

export interface ChartSeries {
  name: string;
  values: number[];
}
export interface ChartSlice {
  label: string;
  value: number;
}
export interface ChartStep {
  label: string;
  state: SegmentState;
}

export interface ChartSpec {
  type: ChartType;
  id?: string;
  title?: string;
  unit?: string;
  caption?: string;
  /** bar, line, area: the category labels. */
  x?: string[];
  /** bar, line, area: at most six series, one value per label. */
  series?: ChartSeries[];
  /** donut: at most eight slices. */
  slices?: ChartSlice[];
  /** segments: the steps exactly as the record lists them. */
  steps?: ChartStep[];
  /** progress: counted units. */
  done?: number;
  total?: number;
  /** progress: the record's own words for what is counted. */
  label?: string;
}

export type ChartParse = { ok: true; spec: ChartSpec } | { ok: false; problem: string };

export const LIMITS = {
  series: 6,
  slices: 8,
  points: 100,
  steps: 50,
  total: 1000,
  title: 120,
  caption: 280,
  unit: 16,
  label: 60,
} as const;

const COMMON = ['type', 'id', 'title', 'unit', 'caption'] as const;
const FIELDS: Record<ChartType, readonly string[]> = {
  bar: [...COMMON, 'x', 'series'],
  line: [...COMMON, 'x', 'series'],
  area: [...COMMON, 'x', 'series'],
  donut: [...COMMON, 'slices'],
  segments: [...COMMON, 'steps'],
  progress: [...COMMON, 'done', 'total', 'label'],
};
/** Which chart types a field belongs to, for the refusal that names the right one. */
const OWNERS: Record<string, string> = {
  x: 'bar, line and area charts',
  series: 'bar, line and area charts',
  slices: 'donut charts',
  steps: 'segments charts',
  done: 'progress charts',
  total: 'progress charts',
  label: 'progress charts',
};

class Refusal extends Error {}
const refuse = (problem: string): never => {
  throw new Refusal(problem);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, what: string, limit: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) refuse(`${what} must be text that is not empty.`);
  const trimmed = (value as string).trim();
  if (trimmed.length > limit) refuse(`${what} is longer than ${limit} characters.`);
  return trimmed;
}

function list(value: unknown, what: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) refuse(`"${what}" must be a list.`);
  const items = value as unknown[];
  if (items.length < min || items.length > max)
    refuse(`"${what}" must hold ${min === max ? min : `${min} to ${max}`} entries; it holds ${items.length}.`);
  return items;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse(`${what} is not a finite number.`);
  return value as number;
}

function whole(value: unknown, what: string, min: number, max: number): number {
  const number = finite(value, what);
  if (!Number.isInteger(number) || number < min || number > max)
    refuse(`${what} must be a whole number from ${min} to ${max}.`);
  return number;
}

function cartesian(record: Record<string, unknown>): Pick<ChartSpec, 'x' | 'series'> {
  if (record.x === undefined) refuse('"x" is missing: list the category labels.');
  if (record.series === undefined) refuse('"series" is missing: give at least one series of values.');
  const x = list(record.x, 'x', 1, LIMITS.points).map((label, index) =>
    text(label, `x label ${index + 1}`, LIMITS.label, true)!,
  );
  const series = list(record.series, 'series', 1, LIMITS.series).map((entry, index) => {
    const where = `series ${index + 1}`;
    if (!isRecord(entry)) refuse(`${where} must be an object with "name" and "values".`);
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item))
      if (key !== 'name' && key !== 'values') refuse(`${where} has an unknown field "${key}".`);
    const name = text(item.name, `${where} "name"`, LIMITS.label, true)!;
    if (!Array.isArray(item.values)) refuse(`${where} ("${name}") must give "values" as a list of numbers.`);
    const values = (item.values as unknown[]).map((value, at) =>
      finite(value, `${where} ("${name}") value ${at + 1}`),
    );
    if (values.length !== x.length)
      refuse(`${where} ("${name}") has ${values.length} values; "x" has ${x.length} labels.`);
    return { name, values };
  });
  return { x, series };
}

function donut(record: Record<string, unknown>): Pick<ChartSpec, 'slices'> {
  if (record.slices === undefined) refuse('"slices" is missing: give each slice a label and a value.');
  const slices = list(record.slices, 'slices', 1, LIMITS.slices).map((entry, index) => {
    const where = `slice ${index + 1}`;
    if (!isRecord(entry)) refuse(`${where} must be an object with "label" and "value".`);
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item))
      if (key !== 'label' && key !== 'value') refuse(`${where} has an unknown field "${key}".`);
    const label = text(item.label, `${where} "label"`, LIMITS.label, true)!;
    const value = finite(item.value, `${where} ("${label}") value`);
    if (value < 0) refuse(`${where} ("${label}") value is negative; a donut shows parts of a whole.`);
    return { label, value };
  });
  if (slices.reduce((sum, slice) => sum + slice.value, 0) <= 0)
    refuse('The slices add up to 0, so there is no whole to divide.');
  return { slices };
}

function segments(record: Record<string, unknown>): Pick<ChartSpec, 'steps'> {
  if (record.steps === undefined) refuse('"steps" is missing: list each step with its state.');
  const steps = list(record.steps, 'steps', 1, LIMITS.steps).map((entry, index) => {
    const where = `step ${index + 1}`;
    if (!isRecord(entry)) refuse(`${where} must be an object with "label" and "state".`);
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item))
      if (key !== 'label' && key !== 'state') refuse(`${where} has an unknown field "${key}".`);
    const label = text(item.label, `${where} "label"`, LIMITS.label, true)!;
    if (typeof item.state !== 'string' || !(STEP_STATES as readonly string[]).includes(item.state))
      refuse(`${where} ("${label}") state must be one of ${STEP_STATES.join(', ')}.`);
    return { label, state: item.state as SegmentState };
  });
  return { steps };
}

function progress(record: Record<string, unknown>): Pick<ChartSpec, 'done' | 'total' | 'label'> {
  if (record.total === undefined) refuse('"total" is missing: say how many units there are.');
  if (record.done === undefined) refuse('"done" is missing: say how many units are done.');
  const total = whole(record.total, '"total"', 1, LIMITS.total);
  const done = whole(record.done, '"done"', 0, total);
  const label = text(record.label, '"label"', LIMITS.label, false);
  return { done, total, ...(label ? { label } : {}) };
}

/** Validates a parsed value against the frozen spec. */
export function validateChart(value: unknown): ChartParse {
  try {
    if (!isRecord(value)) refuse('The chart must be one JSON object.');
    const record = value as Record<string, unknown>;
    if (typeof record.type !== 'string' || !(CHART_TYPES as readonly string[]).includes(record.type))
      refuse(`"type" must be one of ${CHART_TYPES.join(', ')}.`);
    const type = record.type as ChartType;
    for (const key of Object.keys(record)) {
      if (FIELDS[type].includes(key)) continue;
      refuse(
        OWNERS[key]
          ? `"${key}" is only used by ${OWNERS[key]}, not by a ${type} chart.`
          : `The chart has an unknown field "${key}".`,
      );
    }
    if (record.id !== undefined && (typeof record.id !== 'string' || !DECLARED_ID.test(record.id)))
      refuse('"id" must start with a letter or digit and use only letters, digits, ".", "_" and "-" (64 at most).');
    const spec: ChartSpec = {
      type,
      ...(record.id !== undefined ? { id: record.id as string } : {}),
      ...(record.title !== undefined ? { title: text(record.title, '"title"', LIMITS.title, false) } : {}),
      ...(record.unit !== undefined ? { unit: text(record.unit, '"unit"', LIMITS.unit, false) } : {}),
      ...(record.caption !== undefined
        ? { caption: text(record.caption, '"caption"', LIMITS.caption, false) }
        : {}),
      ...(type === 'bar' || type === 'line' || type === 'area' ? cartesian(record) : {}),
      ...(type === 'donut' ? donut(record) : {}),
      ...(type === 'segments' ? segments(record) : {}),
      ...(type === 'progress' ? progress(record) : {}),
    };
    return { ok: true, spec };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, problem: error.message };
    throw error;
  }
}

/** Parses a ```chart fence body and validates it. */
export function parseChart(source: string): ChartParse {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'it could not be read';
    return { ok: false, problem: `The chart is not valid JSON: ${detail}` };
  }
  return validateChart(value);
}
