import type { ReactNode } from 'react';
import type { Session } from '../../shared/types';
import type { UpdateStatusSnapshot } from '../../shared/app-updates';
import type {
  AppSpec,
  ChartSpec,
  ProgressSpec,
  StatSpec,
  TableSpec,
  VisualFormat,
  VisualSpec,
} from '../../shared/visual-spec';
import { formatOrigin, originForSession } from '../../shared/attribution';
import { useUpdateStatus } from '../use-update-status';
import './inline-visual.css';

/*
 * Inline visuals in a reply. Every chart is an SVG with role="img", a one-line
 * aria-label summary and a visually hidden data table carrying every number,
 * so nothing a chart shows is only visible. Colours come from the theme's own
 * tokens (inline-visual.css), so a chart reads in every scheme, light or dark.
 * Nothing here animates under reduced motion.
 *
 * Display only: no visual starts, changes or sends anything.
 */

const LOCALE = 'en-US';

/** Formats a number by the spec's hint. Unknown currency codes fall back to a plain number. */
export function formatValue(
  value: number,
  format: VisualFormat | undefined,
  currency: string | undefined,
  compact = false,
): string {
  const notation = compact && Math.abs(value) >= 10_000 ? ('compact' as const) : undefined;
  if (format === 'percent')
    return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, notation }).format(value)}%`;
  if (format === 'currency' && currency) {
    try {
      return new Intl.NumberFormat(LOCALE, {
        style: 'currency',
        currency,
        notation,
        ...(compact || Number.isInteger(value)
          ? { maximumFractionDigits: 0 }
          : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      }).format(value);
    } catch {
      // A malformed code falls through to a plain number rather than a wrong symbol.
    }
  }
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2, notation }).format(value);
}

const KIND_WORD: Record<ChartSpec['kind'], string> = {
  bar: 'Bar chart',
  line: 'Line chart',
  area: 'Area chart',
  pie: 'Donut chart',
};

/** One sentence a screen reader hears for a chart; the hidden table carries the rest. */
export function chartSummary(spec: ChartSpec): string {
  const head = `${KIND_WORD[spec.kind]}${spec.title ? `: ${spec.title}` : ''}.`;
  const fmt = (v: number) => formatValue(v, spec.format, spec.currency);
  if (spec.kind === 'pie') {
    const values = spec.series[0].values;
    const total = values.reduce((a, b) => a + b, 0);
    let top = 0;
    values.forEach((v, i) => {
      if (v > values[top]) top = i;
    });
    const share = total > 0 ? Math.round((values[top] / total) * 100) : 0;
    return `${head} ${values.length} ${values.length === 1 ? 'slice' : 'slices'}, total ${fmt(total)}. Largest: ${spec.labels[top]}, ${share}%.`;
  }
  const n = spec.labels.length;
  const span = n === 1 ? spec.labels[0] : `${spec.labels[0]} to ${spec.labels[n - 1]}`;
  const parts = spec.series.map((s) => {
    const lo = Math.min(...s.values);
    const hi = Math.max(...s.values);
    return lo === hi ? `${s.name} ${fmt(lo)}` : `${s.name} from ${fmt(lo)} to ${fmt(hi)}`;
  });
  return `${head} ${n} ${n === 1 ? 'point' : 'points'}, ${span}. ${parts.join('; ')}.`;
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** A zero-anchored domain with round ticks. */
export function niceDomain(values: number[]): { min: number; max: number; ticks: number[] } {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { min: lo, max: hi, ticks };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function short(label: string, max = 12): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function DataTable({ spec }: { spec: ChartSpec }) {
  const fmt = (v: number) => formatValue(v, spec.format, spec.currency);
  return (
    <table className="iv-data">
      <caption>{spec.title ?? KIND_WORD[spec.kind]}</caption>
      <thead>
        <tr>
          <th scope="col">Label</th>
          {spec.series.map((s, i) => (
            <th scope="col" key={i}>
              {s.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {spec.labels.map((label, row) => (
          <tr key={row}>
            <th scope="row">{label}</th>
            {spec.series.map((s, i) => (
              <td key={i}>{fmt(s.values[row])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Legend({ names }: { names: string[] }) {
  return (
    <ul className="iv-legend" aria-hidden="true">
      {names.map((name, i) => (
        <li key={i} className={`iv-s${i % 8}`}>
          <span className="iv-swatch" />
          {name}
        </li>
      ))}
    </ul>
  );
}

function Frame({
  kind,
  title,
  children,
}: {
  kind: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <figure className={`iv iv-${kind}`}>
      {title && <figcaption className="iv-title">{title}</figcaption>}
      {children}
    </figure>
  );
}

const W = 640;
const H = 240;
const M = { top: 12, right: 12, bottom: 28, left: 60 };

function CartesianChart({ spec }: { spec: Extract<ChartSpec, { kind: 'bar' | 'line' | 'area' }> }) {
  const all = spec.series.flatMap((s) => s.values);
  const { min, max, ticks } = niceDomain(all);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const y = (v: number) => r1(M.top + plotH - ((v - min) / (max - min)) * plotH);
  const n = spec.labels.length;
  const band = plotW / n;
  const xCenter = (i: number) =>
    r1(
      spec.kind === 'bar'
        ? M.left + band * (i + 0.5)
        : n === 1
          ? M.left + plotW / 2
          : M.left + (plotW * i) / (n - 1),
    );
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const zero = y(Math.max(min, Math.min(0, max)));
  const tick = (v: number) => formatValue(v, spec.format, spec.currency, true);

  return (
    <Frame kind={spec.kind} title={spec.title}>
      <svg
        className="iv-svg"
        role="img"
        aria-label={chartSummary(spec)}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <g className="iv-grid" aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {tick(t)}
              </text>
            </g>
          ))}
          <line className="iv-zero" x1={M.left} x2={W - M.right} y1={zero} y2={zero} />
          {spec.labels.map((label, i) =>
            i % labelEvery === 0 ? (
              <text key={i} x={xCenter(i)} y={H - 8} textAnchor="middle">
                {short(label)}
              </text>
            ) : null,
          )}
        </g>
        {spec.series.map((s, si) => {
          if (spec.kind === 'bar') {
            const inner = band * 0.72;
            const w = inner / spec.series.length;
            return (
              <g key={si} className={`iv-s${si % 8}`}>
                {s.values.map((v, i) => {
                  const x = M.left + band * i + (band - inner) / 2 + w * si;
                  const top = y(Math.max(v, 0));
                  const bottom = y(Math.min(v, 0));
                  return (
                    <rect
                      key={i}
                      className="iv-mark"
                      x={r1(x)}
                      y={top}
                      width={r1(Math.max(1, w - (spec.series.length > 1 ? 1 : 0)))}
                      height={r1(Math.max(0.5, bottom - top))}
                      rx={r1(Math.min(2, w / 4))}
                    />
                  );
                })}
              </g>
            );
          }
          const points = s.values.map((v, i) => `${xCenter(i).toFixed(1)},${y(v).toFixed(1)}`);
          return (
            <g key={si} className={`iv-s${si % 8}`}>
              {spec.kind === 'area' && (
                <path
                  className="iv-fill"
                  d={`M${xCenter(0).toFixed(1)},${zero.toFixed(1)} L${points.join(' L')} L${xCenter(n - 1).toFixed(1)},${zero.toFixed(1)} Z`}
                />
              )}
              <polyline className="iv-line" points={points.join(' ')} />
              {n <= 31 &&
                s.values.map((v, i) => (
                  <circle key={i} className="iv-mark" cx={xCenter(i)} cy={y(v)} r={2.5} />
                ))}
            </g>
          );
        })}
      </svg>
      {spec.series.length > 1 && <Legend names={spec.series.map((s) => s.name)} />}
      <DataTable spec={spec} />
    </Frame>
  );
}

function DonutChart({ spec }: { spec: Extract<ChartSpec, { kind: 'pie' }> }) {
  const values = spec.series[0].values;
  const total = values.reduce((a, b) => a + b, 0);
  const r = 78;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const fmt = (v: number) => formatValue(v, spec.format, spec.currency);
  return (
    <Frame kind="pie" title={spec.title}>
      <div className="iv-donut">
        <svg className="iv-svg" role="img" aria-label={chartSummary(spec)} viewBox="0 0 240 240">
          <g transform="rotate(-90 120 120)">
            {values.map((v, i) => {
              const len = total > 0 ? (v / total) * c : 0;
              const slice = (
                <circle
                  key={i}
                  className={`iv-slice iv-s${i % 8}${i >= 8 ? ' iv-alt' : ''}`}
                  cx={120}
                  cy={120}
                  r={r}
                  strokeDasharray={`${len.toFixed(2)} ${(c - len).toFixed(2)}`}
                  strokeDashoffset={(-offset).toFixed(2)}
                />
              );
              offset += len;
              return slice;
            })}
          </g>
          <text className="iv-total" x={120} y={120} dy="0.32em" textAnchor="middle" aria-hidden="true">
            {formatValue(total, spec.format, spec.currency, true)}
          </text>
        </svg>
        <ul className="iv-legend iv-legend-col" aria-hidden="true">
          {spec.labels.map((label, i) => (
            <li key={i} className={`iv-s${i % 8}${i >= 8 ? ' iv-alt' : ''}`}>
              <span className="iv-swatch" />
              <span className="iv-legend-label">{label}</span>
              <span className="iv-num">{fmt(values[i])}</span>
              <span className="iv-num iv-dim">
                {total > 0 ? `${Math.round((values[i] / total) * 100)}%` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <DataTable spec={spec} />
    </Frame>
  );
}

function StatRow({ spec }: { spec: StatSpec }) {
  return (
    <Frame kind="stat" title={spec.title}>
      <ul className="iv-stats">
        {spec.items.map((item, i) => (
          <li key={i} className="iv-stat">
            <span className="iv-stat-label">{item.label}</span>
            <b className="iv-stat-value iv-num">{formatValue(item.value, item.format, item.currency)}</b>
            {item.delta !== undefined && (
              <span
                className={`iv-delta ${item.delta > 0 ? 'up' : item.delta < 0 ? 'down' : 'flat'}`}
              >
                <span aria-hidden="true">{item.delta > 0 ? '▲' : item.delta < 0 ? '▼' : '■'} </span>
                <span className="iv-sr">{item.delta > 0 ? 'up ' : item.delta < 0 ? 'down ' : 'unchanged '}</span>
                {`${formatValue(Math.abs(item.delta), 'percent', undefined)}`}
                {item.deltaLabel ? ` ${item.deltaLabel}` : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Frame>
  );
}

function DataGrid({ spec }: { spec: TableSpec }) {
  return (
    <Frame kind="table">
      <div className="iv-table-wrap">
        <table className="iv-table">
          {spec.title && <caption>{spec.title}</caption>}
          <thead>
            <tr>
              {spec.columns.map((column, i) => (
                <th scope="col" key={i}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) =>
                  typeof cell === 'number' ? (
                    <td key={i} className="iv-num">
                      {formatValue(cell, spec.formats?.[i], spec.currency)}
                    </td>
                  ) : (
                    <td key={i}>{cell ?? '—'}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

/** One labelled bar. `value` null is indeterminate: a busy bar with no number. */
export function ProgressBar({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail?: string;
}) {
  const pct = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="iv-progress">
      <div className="iv-progress-head">
        <span>{label}</span>
        {pct !== null && <span className="iv-num iv-dim">{pct}%</span>}
      </div>
      <div
        className={`iv-track${pct === null ? ' indeterminate' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct === null ? { 'aria-busy': true } : { 'aria-valuenow': pct })}
      >
        <span className="iv-fillbar" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      {detail && <p className="iv-detail">{detail}</p>}
    </div>
  );
}

function Progress({ spec }: { spec: ProgressSpec }) {
  return (
    <Frame kind="progress">
      <ProgressBar label={spec.label} value={spec.value ?? null} detail={spec.detail} />
    </Frame>
  );
}

/**
 * What the host's update record says, as one card. Every number and word here
 * comes from the snapshot; the spec that asked for the card supplies none.
 */
export function UpdateProgressView({
  title,
  status,
  failed,
  loading,
}: {
  title?: string;
  status: UpdateStatusSnapshot | null;
  failed: boolean;
  loading: boolean;
}) {
  let body: ReactNode;
  if (loading && !status) body = <p className="iv-detail">Reading the update status.</p>;
  else if (!status || failed)
    body = <p className="iv-detail">The update status could not be read here.</p>;
  else {
    const latest = status.check.latestVersion;
    const installed = `Installed ${status.installedVersion}`;
    if (status.install.phase === 'launched')
      body = (
        <ProgressBar
          label={`Installer for ${status.install.version ?? latest ?? 'the update'} started`}
          value={1}
          detail="The app closes and the installer opens after it exits."
        />
      );
    else if (status.install.phase === 'installing')
      body = <ProgressBar label="Starting the installer" value={null} detail={installed} />;
    else if (status.check.phase === 'checking')
      body = <ProgressBar label="Checking for updates" value={null} detail={installed} />;
    else if (status.check.outcome === 'available' && status.download.ready)
      body = (
        <ProgressBar
          label={`Version ${status.download.version ?? latest} downloaded and verified`}
          value={0.75}
          detail={`${installed}. Install from Settings, App updates.`}
        />
      );
    else if (status.check.outcome === 'available')
      body = (
        <ProgressBar
          label={`Version ${latest} is available`}
          value={0.25}
          detail={`${installed}. Download from Settings, App updates.`}
        />
      );
    else
      body = (
        <p className="iv-detail">
          {status.check.outcome === 'current'
            ? `This installation is current. ${installed}.`
            : status.check.outcome === null
              ? `No update check yet. ${installed}.`
              : (status.check.detail ?? `No stable update is published. ${installed}.`)}
        </p>
      );
  }
  return (
    <Frame kind="app" title={title ?? 'App update'}>
      {body}
    </Frame>
  );
}

function UpdateProgressCard({ title }: { title?: string }) {
  const { status, failed, loading } = useUpdateStatus();
  return <UpdateProgressView title={title} status={status} failed={failed} loading={loading} />;
}

const RUN_WORD: Record<Session['state'], string> = {
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};

function clock(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

/** The thread's run, read from its own session record, or a plain note where there is none. */
export function RunStatusView({ title, session }: { title?: string; session: Session | null }) {
  if (!session)
    return (
      <Frame kind="app" title={title ?? 'Run status'}>
        <p className="iv-detail">Not available here.</p>
      </Frame>
    );
  const moving = session.state === 'queued' || session.state === 'working';
  const lastLine = [...session.log].reverse().find((line) => line.level === 'plain')?.sentence;
  const who = formatOrigin(originForSession(session)).label;
  const timing = session.endedAt
    ? `Started ${clock(session.startedAt)}, ended ${clock(session.endedAt)}`
    : `Started ${clock(session.startedAt)}`;
  const detail = [who, timing, lastLine].filter(Boolean).join(' · ');
  return (
    <Frame kind="app" title={title ?? 'Run status'}>
      {moving || session.state === 'done' ? (
        <ProgressBar label={RUN_WORD[session.state]} value={moving ? null : 1} detail={detail} />
      ) : (
        <div className="iv-progress">
          <div className="iv-progress-head">
            <span className={`iv-state ${session.state}`}>{RUN_WORD[session.state]}</span>
          </div>
          <p className="iv-detail">{detail}</p>
        </div>
      )}
    </Frame>
  );
}

function AppCard({ spec, session }: { spec: AppSpec; session: Session | null }) {
  if (spec.key === 'update-progress') return <UpdateProgressCard title={spec.title} />;
  return <RunStatusView title={spec.title} session={session} />;
}

/** A spec that could not be drawn, said once in plain words. The reply around it still reads. */
export function VisualNote({ reason }: { reason: string }) {
  return <p className="iv-note">A visual could not be shown: {reason}.</p>;
}

/** Shown while a visual block is still streaming. Its JSON is never shown half-written. */
export function VisualPending() {
  return (
    <p className="iv-note iv-pending" role="status">
      Drawing a chart…
    </p>
  );
}

export function InlineVisual({ spec, session = null }: { spec: VisualSpec; session?: Session | null }) {
  switch (spec.kind) {
    case 'bar':
    case 'line':
    case 'area':
      return <CartesianChart spec={spec} />;
    case 'pie':
      return <DonutChart spec={spec} />;
    case 'stat':
      return <StatRow spec={spec} />;
    case 'table':
      return <DataGrid spec={spec} />;
    case 'progress':
      return <Progress spec={spec} />;
    case 'app':
      return <AppCard spec={spec} session={session} />;
    default:
      return <VisualNote reason="this kind of visual is not supported" />;
  }
}
