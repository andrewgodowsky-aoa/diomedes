import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageState } from '../../shared/managed-usage';
import { ApiError, api } from '../api';
import { Button } from '../components';
import { USAGE_LABEL, acceptsUsage, usageBarModel } from './nectovia-usage-model';

/**
 * Nectovia usage for the active business, in the account area.
 *
 * The figures come only from the host's usage state. Tenant credit usage is
 * owned by the control plane; a host without an authenticated control-plane
 * session answers `not-connected`, and this section says exactly that. It never
 * estimates, and it never draws an unknown balance as 0%.
 */

/**
 * The one piece that draws the fill. Kept apart so the skin branch's
 * SegmentBar can replace it without touching the text, which is the real
 * record: the meter is supplementary and caps at a full bar, the text does not.
 */
export function UsageMeter({ value, label }: { value: number; label: string }) {
  return (
    <div
      className="nu-meter"
      role="progressbar"
      aria-label="Monthly credits used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={label}
    >
      <span className="nu-fill" style={{ width: `${value}%` }} />
    </div>
  );
}

export function NectoviaUsageView({
  state,
  now,
  onRefresh,
  refreshing,
}: {
  state: UsageState;
  now: number;
  onRefresh(): void;
  refreshing: boolean;
}) {
  const model = usageBarModel(state, now);
  return (
    <section className="ws-section nu">
      <div className="nu-head">
        <h3>{USAGE_LABEL}</h3>
        {state.state !== 'loading' && (
          <Button tone="quiet" disabled={refreshing} onClick={onRefresh}>
            Refresh
          </Button>
        )}
      </div>
      <p className={model.status === 'ready' ? 'nu-summary' : 'nu-summary nu-unknown'} role="status">
        {model.summary}
      </p>
      {model.meter !== null && <UsageMeter value={model.meter} label={model.summary} />}
      {model.detail && <p className="caption ws-boundary">{model.detail}</p>}
      {model.alert && <p className="caption ws-boundary" role="alert">{model.alert}</p>}
      {model.facts.length > 0 && (
        <dl className="ws-facts nu-facts">
          {model.facts.map((fact) => (
            <div key={fact.term}>
              <dt>{fact.term}</dt>
              <dd className="mono">{fact.value}</dd>
              {fact.machine && (
                <dd className="mono nu-machine" title={fact.machine}>
                  {fact.machine}
                </dd>
              )}
              {fact.note && <dd className="ws-why">{fact.note}</dd>}
            </div>
          ))}
        </dl>
      )}
      {model.reconciliation && <p className="caption nu-reconcile">{model.reconciliation}</p>}
      {(model.resets || model.freshness) && (
        <p className={model.stale ? 'caption nu-when nu-stale' : 'caption nu-when'}>
          {[model.resets, model.freshness].filter(Boolean).join(' · ')}
        </p>
      )}
    </section>
  );
}

/**
 * The usage state for one business, read now and again every half minute, with a way to read it on demand.
 * The Usage screen in Settings reads it through this too, so both show the same answer the same way.
 */
export function useNectoviaUsage(organizationId: string, report: (error: unknown) => void) {
  const [state, setState] = useState<UsageState>({ state: 'loading', organizationId });
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The organization this section currently shows. A response that arrives
  // after a workspace switch is checked against it and dropped.
  const current = useRef(organizationId);
  current.current = organizationId;
  const reportRef = useRef(report);
  reportRef.current = report;

  const load = useCallback((id: string) => {
    setRefreshing(true);
    return api<UsageState>(`/workspace/organizations/${id}/usage`)
      .then((next) => {
        if (current.current !== id) return;
        if (!acceptsUsage(id, next)) {
          setState({ state: 'unavailable', organizationId: id, reason: 'The usage answer named a different business, so it was not shown.' });
          return;
        }
        setState(next);
      })
      .catch((error) => {
        if (current.current !== id) return;
        // A host without this route is a fact about the build, not an error
        // to report; anything else is reported and still shown as unknown.
        if (!(error instanceof ApiError && error.status === 404)) reportRef.current(error);
        setState({ state: 'unavailable', organizationId: id, reason: 'Usage could not be read just now.' });
      })
      .finally(() => {
        if (current.current === id) {
          setRefreshing(false);
          setNow(Date.now());
        }
      });
  }, []);

  useEffect(() => {
    setState({ state: 'loading', organizationId });
    void load(organizationId);
  }, [organizationId, load]);

  // Freshness still advances if a refresh is slow or cannot finish.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Refresh while the panel is open, waiting for the current read to finish before scheduling
  // another. A failed read becomes unavailable; it never invents remaining funds.
  useEffect(() => {
    if (refreshing) return;
    const timer = setTimeout(() => void load(organizationId), 30_000);
    return () => clearTimeout(timer);
  }, [organizationId, load, refreshing]);

  const shown: UsageState = state.organizationId === organizationId ? state : { state: 'loading', organizationId };
  const refresh = useCallback(() => void load(organizationId), [load, organizationId]);
  return { state: shown, now, refreshing, refresh };
}

export function NectoviaUsage({
  organizationId,
  report,
}: {
  organizationId: string;
  report(error: unknown): void;
}) {
  const { state, now, refreshing, refresh } = useNectoviaUsage(organizationId, report);
  return <NectoviaUsageView state={state} now={now} refreshing={refreshing} onRefresh={refresh} />;
}
