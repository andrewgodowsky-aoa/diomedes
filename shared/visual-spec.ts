/**
 * Inline visuals in a reply: the spec a model may write and the parser that
 * finds it in the reply text.
 *
 * Transport is a fenced block tagged `visual` holding one JSON object, so it
 * works on every provider and model: nothing here depends on a tool call, a
 * structured-output mode or a particular engine. The client renders a valid
 * spec as a chart, a KPI row, a table or a progress bar, and anything else as
 * a short plain-text note. Nothing here throws on model output.
 *
 * A spec is display only. It never authorizes, starts or changes anything. An
 * `app` spec is a request for a live card by a fixed key; its data always comes
 * from the client's own state, never from the model, so the spec carries no
 * data fields at all and one that tries to is refused.
 */
import { z } from 'zod';

export const VISUAL_FENCE_TAG = 'visual';
/** A JSON body longer than this is refused before it is parsed. */
export const VISUAL_MAX_JSON_BYTES = 32 * 1024;
/** More visual blocks than this in one reply are refused, the rest of the reply still reads. */
export const VISUAL_MAX_PER_REPLY = 8;
export const VISUAL_MAX_SERIES = 8;
export const VISUAL_MAX_POINTS = 200;
export const VISUAL_MAX_PIE_SLICES = 12;
export const VISUAL_MAX_STATS = 6;
export const VISUAL_MAX_COLUMNS = 12;
export const VISUAL_MAX_ROWS = 50;

export const VISUAL_KINDS = ['bar', 'line', 'area', 'pie', 'stat', 'table', 'progress', 'app'] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];
export const APP_VISUAL_KEYS = ['update-progress', 'run-status'] as const;
export type AppVisualKey = (typeof APP_VISUAL_KEYS)[number];
export const VISUAL_FORMATS = ['number', 'currency', 'percent'] as const;
export type VisualFormat = (typeof VISUAL_FORMATS)[number];

// Plain text only: no control characters, so a label can never carry a line
// break, an escape sequence or anything a renderer might read as structure.
const PLAIN = /^[^\u0000-\u001f\u007f]*$/;
const plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(PLAIN, 'must be plain text');
const finite = z.number().refine(Number.isFinite, 'must be a finite number');
const title = plain(120).optional();
const format = z.enum(VISUAL_FORMATS).optional();
/** ISO 4217 code, for example USD. Only meaningful with format "currency". */
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be a three-letter currency code')
  .optional();

const series = z.strictObject({
  name: plain(60),
  values: z.array(finite).min(1).max(VISUAL_MAX_POINTS),
});

function seriesMatchLabels(
  spec: { labels: string[]; series: { values: number[] }[] },
  ctx: z.RefinementCtx,
) {
  spec.series.forEach((s, index) => {
    if (s.values.length !== spec.labels.length)
      ctx.addIssue({
        code: 'custom',
        path: ['series', index, 'values'],
        message: 'must have one value per label',
      });
  });
}

const cartesian = <K extends 'bar' | 'line' | 'area'>(kind: K) =>
  z
    .strictObject({
      kind: z.literal(kind),
      title,
      labels: z.array(plain(60)).min(1).max(VISUAL_MAX_POINTS),
      series: z.array(series).min(1).max(VISUAL_MAX_SERIES),
      format,
      currency,
    })
    .superRefine(seriesMatchLabels);

const pie = z
  .strictObject({
    kind: z.literal('pie'),
    title,
    labels: z.array(plain(60)).min(1).max(VISUAL_MAX_PIE_SLICES),
    series: z
      .array(
        z.strictObject({
          name: plain(60),
          values: z.array(finite.refine((v) => v >= 0, 'must not be negative')).min(1),
        }),
      )
      .length(1, 'a pie has exactly one series'),
    format,
    currency,
  })
  .superRefine(seriesMatchLabels)
  .refine((spec) => spec.series[0].values.some((v) => v > 0), {
    message: 'a pie needs at least one value above zero',
    path: ['series', 0, 'values'],
  });

const stat = z.strictObject({
  kind: z.literal('stat'),
  title,
  items: z
    .array(
      z.strictObject({
        label: plain(60),
        value: finite,
        /** Percent change, for example 4.2 for +4.2%. */
        delta: finite.optional(),
        deltaLabel: plain(40).optional(),
        format,
        currency,
      }),
    )
    .min(1)
    .max(VISUAL_MAX_STATS),
});

const cell = z.union([plain(200), finite, z.null()]);
const table = z
  .strictObject({
    kind: z.literal('table'),
    title,
    columns: z.array(plain(60)).min(1).max(VISUAL_MAX_COLUMNS),
    rows: z.array(z.array(cell)).max(VISUAL_MAX_ROWS),
    /** One per column; applies to that column's numeric cells. */
    formats: z.array(z.enum(VISUAL_FORMATS)).optional(),
    currency,
  })
  .superRefine((spec, ctx) => {
    spec.rows.forEach((row, index) => {
      if (row.length !== spec.columns.length)
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index],
          message: 'must have one cell per column',
        });
    });
    if (spec.formats && spec.formats.length !== spec.columns.length)
      ctx.addIssue({ code: 'custom', path: ['formats'], message: 'must have one per column' });
  });

const progress = z.strictObject({
  kind: z.literal('progress'),
  label: plain(80),
  /** 0 to 1. Absent or null is indeterminate. */
  value: finite
    .refine((v) => v >= 0 && v <= 1, 'must be between 0 and 1')
    .nullable()
    .optional(),
  detail: plain(120).optional(),
});

/** A live app card by key. No data fields: the client supplies every number. */
const app = z.strictObject({
  kind: z.literal('app'),
  key: z.enum(APP_VISUAL_KEYS),
  title,
});

export const visualSpecSchema = z.discriminatedUnion('kind', [
  cartesian('bar'),
  cartesian('line'),
  cartesian('area'),
  pie,
  stat,
  table,
  progress,
  app,
]);

export type VisualSpec = z.infer<typeof visualSpecSchema>;
export type ChartSpec = Extract<VisualSpec, { kind: 'bar' | 'line' | 'area' | 'pie' }>;
export type StatSpec = Extract<VisualSpec, { kind: 'stat' }>;
export type TableSpec = Extract<VisualSpec, { kind: 'table' }>;
export type ProgressSpec = Extract<VisualSpec, { kind: 'progress' }>;
export type AppSpec = Extract<VisualSpec, { kind: 'app' }>;

export type VisualParse = { ok: true; spec: VisualSpec } | { ok: false; reason: string };

/** A value that is a spec, or a short plain reason why not. Never throws. */
export function parseVisualSpec(value: unknown): VisualParse {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'the block is not a JSON object' };
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(VISUAL_KINDS as readonly string[]).includes(kind))
    return {
      ok: false,
      reason:
        typeof kind === 'string'
          ? `"${kind.slice(0, 20)}" is not a kind of visual`
          : 'the block names no kind',
    };
  let result: ReturnType<typeof visualSpecSchema.safeParse>;
  try {
    result = visualSpecSchema.safeParse(value);
  } catch {
    return { ok: false, reason: 'the block could not be read' };
  }
  if (result.success) return { ok: true, spec: result.data };
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')} ` : '';
  const what =
    issue?.code === 'unrecognized_keys'
      ? `has a field it does not take (${issue.keys.slice(0, 3).join(', ')})`
      : (issue?.message ?? 'is not valid');
  return { ok: false, reason: `${where}${what}`.slice(0, 160) };
}

export type ReplySegment =
  | { type: 'text'; text: string }
  | { type: 'visual'; spec: VisualSpec }
  | { type: 'invalid'; reason: string }
  /** A visual block still being written while the reply streams. Never half-parsed. */
  | { type: 'pending' };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;

/**
 * Splits a reply into ordered text and visual segments.
 *
 * Only a fence whose info string is exactly `visual` is read. Every other
 * fence, and anything inside one (including a `visual` example quoted inside
 * a Markdown block), stays text, byte for byte. A visual fence still open at
 * the end is `pending` while the reply streams and `invalid` once it is
 * final. Whitespace-only text between blocks is dropped.
 */
export function splitVisuals(text: string, options: { streaming?: boolean } = {}): ReplySegment[] {
  const lines = text.split('\n');
  const segments: ReplySegment[] = [];
  let buffer: string[] = [];
  let visuals = 0;
  const flush = () => {
    const joined = buffer.join('\n');
    if (joined.trim()) segments.push({ type: 'text', text: joined });
    buffer = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const open = FENCE.exec(line);
    if (!open) {
      buffer.push(line);
      index++;
      continue;
    }
    const marker = open[1];
    const info = open[2];
    // The last line of a streaming reply may be a fence still being typed:
    // "```vis" is a visual block that has not finished its first line yet.
    if (
      options.streaming &&
      index === lines.length - 1 &&
      info !== VISUAL_FENCE_TAG &&
      VISUAL_FENCE_TAG.startsWith(info)
    ) {
      flush();
      segments.push({ type: 'pending' });
      break;
    }
    // The close is the same character, at least as long, with no info string.
    let close = -1;
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = FENCE.exec(lines[next]);
      if (
        candidate &&
        candidate[2] === '' &&
        candidate[1][0] === marker[0] &&
        candidate[1].length >= marker.length
      ) {
        close = next;
        break;
      }
    }
    if (info !== VISUAL_FENCE_TAG) {
      // Another language's block, or a bare fence: kept as text, whole.
      const end = close < 0 ? lines.length : close + 1;
      buffer.push(...lines.slice(index, end));
      index = end;
      continue;
    }
    flush();
    if (close < 0) {
      segments.push(
        options.streaming
          ? { type: 'pending' }
          : { type: 'invalid', reason: 'the block was never closed' },
      );
      break;
    }
    visuals++;
    segments.push(readBlock(lines.slice(index + 1, close).join('\n'), visuals));
    index = close + 1;
  }
  flush();
  return segments;
}

function readBlock(body: string, ordinal: number): ReplySegment {
  if (ordinal > VISUAL_MAX_PER_REPLY)
    return { type: 'invalid', reason: `a reply shows at most ${VISUAL_MAX_PER_REPLY} visuals` };
  if (new TextEncoder().encode(body).length > VISUAL_MAX_JSON_BYTES)
    return { type: 'invalid', reason: 'the block is too large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { type: 'invalid', reason: 'the block is not valid JSON' };
  }
  const result = parseVisualSpec(parsed);
  return result.ok ? { type: 'visual', spec: result.spec } : { type: 'invalid', reason: result.reason };
}
