import { useState, type ReactNode } from 'react';
import type { ChartSpec } from './chart-spec';
import { useElementSize } from './artifact-frames';
import { SegmentBar } from './SegmentBar';
import { TableView } from './TurnBody';
import type { TableBlock } from './turn-blocks';

// Charts drawn by the app itself, as SVG built from a validated chart spec
// (chart-spec.ts). Every label is a React text node; nothing the model wrote
// is ever markup here. Series colours lead with the seam's cyan, then violet,
// then coral, then the scheme's greys (artifacts.css `.art-s1`...`.art-s8`).
// Every chart carries a plain-words summary as its accessible name and a data
// table a person can open under it.

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const HEIGHT = 240;
const TOP = 22;
const BOTTOM = 30;
const RIGHT = 12;
/** Wider than this, a chart is harder to read, not easier. */
const MAX_WIDTH = 720;
const CHAR = 6.6;
const LABEL_LIMIT = 14;

/** A value with its unit, the way the data table and the tooltips write it. */
export function formatValue(value: number, unit?: string): string {
  if (!unit) return NUMBER.format(value);
  if (/^[$€£¥]$/.test(unit))
    return value < 0 ? `-${unit}${NUMBER.format(-value)}` : `${unit}${NUMBER.format(value)}`;
  if (unit === '%') return `${NUMBER.format(value)}%`;
  return `${NUMBER.format(value)} ${unit}`;
}

/** Round tick values that cover [min, max] in about `count` steps. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let low = Math.min(min, max);
  let high = Math.max(min, max);
  if (low === high) {
    if (low === 0) high = 1;
    else if (low > 0) low = 0;
    else high = 0;
  }
  const rough = (high - low) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const start = Math.floor(low / step + 1e-9) * step;
  const ticks: number[] = [];
  for (let value = start; value <= high + step * 1e-6; value += step) ticks.push(Number(value.toFixed(decimals)));
  if (ticks[ticks.length - 1] < high) ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(decimals)));
  return ticks;
}

function tickLabel(value: number, compact: boolean): string {
  return compact ? COMPACT.format(value) : NUMBER.format(value);
}

/** Two decimals are finer than a pixel; more only bloats the markup. */
const round = (value: number) => Math.round(value * 100) / 100;

function clip(label: string): string {
  return label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT - 1)}…` : label;
}

const STATE_WORD: Record<string, string> = {
  done: 'Done',
  active: 'Active',
  pending: 'Pending',
  failed: 'Failed',
  blocked: 'Blocked',
};

/** The chart in plain words: its accessible name. */
export function chartSummary(spec: ChartSpec): string {
  const named = spec.title ? `: ${spec.title}` : '';
  if (spec.type === 'donut') {
    const slices = spec.slices ?? [];
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    const largest = slices.reduce((best, slice) => (slice.value > best.value ? slice : best), slices[0]);
    const share = total > 0 ? Math.round((largest.value / total) * 100) : 0;
    return `Donut chart${named}. ${slices.length} ${slices.length === 1 ? 'part' : 'parts'} totalling ${formatValue(total, spec.unit)}; the largest is ${largest.label} at ${share}%.`;
  }
  if (spec.type === 'segments') {
    const steps = spec.steps ?? [];
    const count = (state: string) => steps.filter((step) => step.state === state).length;
    const extra = [
      count('failed') ? `${count('failed')} failed` : '',
      count('blocked') ? `${count('blocked')} blocked` : '',
    ].filter(Boolean);
    return `Steps${named}. ${count('done')} of ${steps.length} done${extra.length ? `, ${extra.join(', ')}` : ''}.`;
  }
  if (spec.type === 'progress')
    return `Progress${named}. ${spec.done} of ${spec.total}${spec.label ? ` ${spec.label}` : ''}.`;
  const series = spec.series ?? [];
  const values = series.flatMap((entry) => entry.values);
  const kind = spec.type === 'bar' ? 'Bar' : spec.type === 'line' ? 'Line' : 'Area';
  const what =
    series.length === 1
      ? series[0].name
      : `${series.length} series (${series.map((entry) => entry.name).join(', ')})`;
  const count = spec.x?.length ?? 0;
  return `${kind} chart${named}. ${what} across ${count} ${count === 1 ? 'category' : 'categories'}, from ${formatValue(Math.min(...values), spec.unit)} to ${formatValue(Math.max(...values), spec.unit)}.`;
}

/** The numbers under a chart, as a table a person can read. */
export function chartTable(spec: ChartSpec): TableBlock {
  const table = (header: string[], rows: string[][]): TableBlock => ({
    type: 'table',
    header,
    align: header.map(() => null),
    rows,
  });
  if (spec.type === 'donut') {
    const slices = spec.slices ?? [];
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    return table(
      ['Part', spec.unit ? `Value (${spec.unit})` : 'Value', 'Share'],
      slices.map((slice) => [
        slice.label,
        NUMBER.format(slice.value),
        `${total > 0 ? NUMBER.format(Math.round((slice.value / total) * 1000) / 10) : 0}%`,
      ]),
    );
  }
  if (spec.type === 'segments')
    return table(
      ['Step', 'State'],
      (spec.steps ?? []).map((step) => [step.label, STATE_WORD[step.state] ?? step.state]),
    );
  if (spec.type === 'progress')
    return table(['Counted', 'Done', 'Total'], [[spec.label ?? 'Units', String(spec.done), String(spec.total)]]);
  const series = spec.series ?? [];
  return table(
    ['Category', ...series.map((entry) => (spec.unit ? `${entry.name} (${spec.unit})` : entry.name))],
    (spec.x ?? []).map((label, index) => [label, ...series.map((entry) => NUMBER.format(entry.values[index]))]),
  );
}

function Cartesian({ spec, width, summary }: { spec: ChartSpec; width: number; summary: string }) {
  const x = spec.x ?? [];
  const series = spec.series ?? [];
  const values = series.flatMap((entry) => entry.values);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 5);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
  const compact = Math.max(Math.abs(min), Math.abs(max)) >= 10000;
  const labels = ticks.map((tick) => tickLabel(tick, compact));
  const left = Math.ceil(Math.max(24, Math.max(...labels.map((label) => label.length)) * CHAR + 10));
  const plotWidth = Math.max(40, width - left - RIGHT);
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const y = (value: number) => round(TOP + plotHeight - ((value - min) / (max - min || 1)) * plotHeight);
  const band = plotWidth / Math.max(1, x.length);
  const center = (index: number) => round(left + band * index + band / 2);
  const widest = Math.max(...x.map((label) => clip(label).length)) * CHAR + 10;
  const every = Math.max(1, Math.ceil(widest / band));
  const base = y(Math.min(Math.max(0, min), max));
  const tip = (index: number, name: string, value: number) =>
    `${x[index]}, ${name}: ${formatValue(value, spec.unit)}`;

  let marks: ReactNode;
  if (spec.type === 'bar') {
    const group = band * 0.72;
    const bar = group / Math.max(1, series.length);
    marks = series.map((entry, s) => (
      <g key={s} className={`art-s${s + 1}`}>
        {entry.values.map((value, index) => {
          const top = y(Math.max(0, value));
          const bottom = y(Math.min(0, value));
          return (
            <rect
              key={index}
              className="art-bar"
              x={round(left + band * index + (band - group) / 2 + bar * s)}
              y={top}
              width={round(Math.max(1, bar - (series.length > 1 ? 1 : 0)))}
              height={round(Math.max(0, bottom - top))}
            >
              <title>{tip(index, entry.name, value)}</title>
            </rect>
          );
        })}
      </g>
    ));
  } else {
    const dots = x.length <= 30;
    marks = series.map((entry, s) => {
      const points = entry.values.map((value, index) => [center(index), y(value)] as const);
      const line = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
      const area =
        spec.type === 'area' && points.length
          ? `${line} L${points[points.length - 1][0].toFixed(1)} ${base.toFixed(1)} L${points[0][0].toFixed(1)} ${base.toFixed(1)} Z`
          : null;
      return (
        <g key={s} className={`art-s${s + 1}`}>
          {area && <path className="art-area" d={area} />}
          <path className="art-line" d={line} strokeDasharray={s >= 3 ? '5 4' : undefined} />
          {dots &&
            points.map(([px, py], index) => (
              <circle key={index} className="art-dot" cx={px} cy={py} r={3}>
                <title>{tip(index, entry.name, entry.values[index])}</title>
              </circle>
            ))}
        </g>
      );
    });
  }

  return (
    <svg
      className="art-chart-svg"
      role="img"
      aria-label={summary}
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
    >
      {spec.unit && (
        <text className="art-unit" x={0} y={11}>
          {spec.unit}
        </text>
      )}
      {ticks.map((tick, index) => (
        <g key={tick}>
          <line className={tick === 0 && min < 0 ? 'art-zero' : 'art-grid'} x1={left} x2={left + plotWidth} y1={y(tick)} y2={y(tick)} />
          <text className="art-tick" x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
            {labels[index]}
          </text>
        </g>
      ))}
      <line className="art-axis" x1={left} x2={left + plotWidth} y1={y(min)} y2={y(min)} />
      {x.map((label, index) =>
        index % every === 0 ? (
          <text key={index} className="art-tick" x={center(index)} y={HEIGHT - BOTTOM + 17} textAnchor="middle">
            {clip(label)}
          </text>
        ) : null,
      )}
      {marks}
    </svg>
  );
}

function arc(cx: number, cy: number, outer: number, inner: number, from: number, to: number): string {
  const point = (radius: number, angle: number) =>
    `${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`;
  const large = to - from > Math.PI ? 1 : 0;
  return `M${point(outer, from)} A${outer} ${outer} 0 ${large} 1 ${point(outer, to)} L${point(inner, to)} A${inner} ${inner} 0 ${large} 0 ${point(inner, from)} Z`;
}

function Donut({ spec, summary }: { spec: ChartSpec; summary: string }) {
  const slices = spec.slices ?? [];
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const size = 200;
  const middle = size / 2;
  const outer = 92;
  const inner = 58;
  let angle = -Math.PI / 2;
  const parts = slices.map((slice, index) => {
    const sweep = total > 0 ? (slice.value / total) * Math.PI * 2 : 0;
    const from = angle;
    angle += sweep;
    if (sweep <= 0) return null;
    // A whole ring cannot be one arc: draw it as two halves.
    const d =
      sweep >= Math.PI * 2 - 1e-6
        ? `${arc(middle, middle, outer, inner, from, from + Math.PI)} ${arc(middle, middle, outer, inner, from + Math.PI, from + Math.PI * 2)}`
        : arc(middle, middle, outer, inner, from, from + sweep);
    return (
      <path key={index} className={`art-slice art-s${index + 1}`} d={d}>
        <title>{`${slice.label}: ${formatValue(slice.value, spec.unit)} (${Math.round((slice.value / total) * 100)}%)`}</title>
      </path>
    );
  });
  return (
    <svg
      className="art-chart-svg donut"
      role="img"
      aria-label={summary}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      {parts}
      <text className="art-total" x={middle} y={middle - 2} textAnchor="middle">
        {formatValue(total, spec.unit)}
      </text>
      <text className="art-total-label" x={middle} y={middle + 18} textAnchor="middle">
        Total
      </text>
    </svg>
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  if (spec.type === 'donut') {
    const slices = spec.slices ?? [];
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    return (
      <ul className="art-legend" aria-hidden="true">
        {slices.map((slice, index) => (
          <li key={index} className={`art-s${index + 1}`}>
            <span className="art-swatch" />
            {slice.label}
            <span className="art-value">
              {formatValue(slice.value, spec.unit)} · {total > 0 ? Math.round((slice.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    );
  }
  const series = spec.series ?? [];
  if (series.length < 2) return null;
  return (
    <ul className="art-legend" aria-hidden="true">
      {series.map((entry, index) => (
        <li key={index} className={`art-s${index + 1}`}>
          <span className={`art-swatch${spec.type !== 'bar' && index >= 3 ? ' dashed' : ''}`} />
          {entry.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * One chart. `segments` and `progress` are the Console's own segment bar,
 * size "panel", drawn exactly from the record's steps or its done/total.
 */
export function Chart({ spec, showTitle = false }: { spec: ChartSpec; showTitle?: boolean }) {
  const [showData, setShowData] = useState(false);
  const [box, size] = useElementSize<HTMLDivElement>({ width: 560, height: 0 });
  const width = Math.min(MAX_WIDTH, size.width);
  const summary = chartSummary(spec);
  let figure: ReactNode;
  if (spec.type === 'segments')
    figure = <SegmentBar size="panel" label={summary} steps={spec.steps} running={false} />;
  else if (spec.type === 'progress')
    figure = (
      <SegmentBar size="panel" label={summary} done={spec.done} total={spec.total} noun={spec.label} running={false} />
    );
  else if (spec.type === 'donut') figure = <Donut spec={spec} summary={summary} />;
  else figure = <Cartesian spec={spec} width={width} summary={summary} />;
  return (
    <figure className="art-chart">
      {showTitle && spec.title && <p className="art-chart-heading">{spec.title}</p>}
      <div ref={box} className="art-chart-box">
        {figure}
      </div>
      <Legend spec={spec} />
      {spec.caption && <figcaption className="art-chart-caption">{spec.caption}</figcaption>}
      <div className="art-data">
        <button
          type="button"
          className="art-tool"
          aria-expanded={showData}
          onClick={() => setShowData((value) => !value)}
        >
          {showData ? 'Hide data' : 'Show data'}
        </button>
        {showData && <TableView table={chartTable(spec)} caption={`Data: ${spec.title ?? summary}`} />}
      </div>
    </figure>
  );
}
