import { formatCredits, type MicroUsd, type UsageState } from '../../shared/managed-usage';

/**
 * What the Nectovia usage bar says, derived only from a usage state the host
 * returned. Loading, not-connected and unavailable produce no figures, so no
 * path through here can draw an unknown balance as 0%.
 */

export const USAGE_LABEL = 'Nectovia usage';
/** Older than this, a projection is shown with a warning rather than as current. */
export const USAGE_STALE_AFTER_MS = 5 * 60_000;

export interface UsageFact {
  readonly term: string;
  readonly value: string;
  readonly note?: string;
  /** A machine string (a receipt reference) that must truncate where it is written. */
  readonly machine?: string;
}

export interface UsageBarModel {
  readonly status: UsageState['state'];
  /** The real percentage, which can pass 100 when overspend is being reconciled. */
  readonly percent: number | null;
  /** The meter's fill, 0 to 100. The text always carries the real figure. */
  readonly meter: number | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly facts: readonly UsageFact[];
  readonly resets: string | null;
  readonly freshness: string | null;
  readonly stale: boolean;
  readonly reconciliation: string | null;
}

const credits = (amount: MicroUsd) => `${formatCredits(amount)} ${amount === 100_000 ? 'credit' : 'credits'}`;

const utc = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export const formatUtc = (iso: string) => `${utc.format(new Date(iso))} UTC`;

function freshnessOf(observedAt: string, now: number): { text: string; stale: boolean } {
  const age = Math.max(0, now - Date.parse(observedAt));
  const minutes = Math.floor(age / 60_000);
  const ago =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes} minute${minutes === 1 ? '' : 's'} ago`
        : `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? '' : 's'} ago`;
  const stale = age > USAGE_STALE_AFTER_MS;
  return { text: `Updated ${ago}${stale ? ', so these figures may be out of date' : ''}`, stale };
}

const percentText = (value: number) => (Number.isInteger(value) ? `${value}%` : `${value.toFixed(1).replace(/\.0$/, '')}%`);

export function usageBarModel(state: UsageState, now: number): UsageBarModel {
  const empty = { percent: null, meter: null, facts: [], resets: null, freshness: null, stale: false, reconciliation: null };
  if (state.state === 'loading') return { ...empty, status: 'loading', summary: 'Checking usage…', detail: null };
  if (state.state === 'not-connected') return { ...empty, status: 'not-connected', summary: 'Not connected', detail: state.reason };
  if (state.state === 'unavailable') return { ...empty, status: 'unavailable', summary: 'Unavailable', detail: state.reason };

  const usage = state.projection;
  const granted = formatCredits(usage.grantedMicroUsd);
  const summary =
    usage.usedPercent === null
      ? `${credits(usage.settledMicroUsd)} used; this month has no grant to measure against`
      : `${percentText(usage.usedPercent)} of this month’s ${granted} credits used`;
  const facts: UsageFact[] = [
    { term: 'Used this month', value: credits(usage.settledMicroUsd) },
    { term: 'Available this month', value: credits(usage.availableMicroUsd) },
  ];
  if (usage.pendingMicroUsd > 0) facts.push({ term: 'Held for work in flight', value: credits(usage.pendingMicroUsd) });
  if (usage.uncertainMicroUsd > 0)
    facts.push({
      term: 'Held, outcome not yet known',
      value: credits(usage.uncertainMicroUsd),
      note: 'This may already have cost money upstream. It stays held until the provider’s records say what happened, so nothing is charged twice.',
    });
  if (usage.overspentMicroUsd > 0) facts.push({ term: 'Over by', value: credits(usage.overspentMicroUsd) });
  if (usage.correctionsMicroUsd > 0)
    facts.push({ term: 'Returned by corrections', value: credits(usage.correctionsMicroUsd), note: 'Covered by us. Your usage history is unchanged.' });
  if (usage.correctionWithdrawalsMicroUsd > 0) facts.push({ term: 'Withdrawn by corrections', value: credits(usage.correctionWithdrawalsMicroUsd) });
  const topUp = usage.topUp;
  if (topUp.availableMicroUsd > 0 || topUp.heldMicroUsd > 0 || topUp.settledThisPeriodMicroUsd > 0)
    facts.push({
      term: 'Top-up balance',
      value: credits(topUp.availableMicroUsd),
      note: `Kept separate from the monthly grant and used only after it.${topUp.settledThisPeriodMicroUsd > 0 ? ` ${credits(topUp.settledThisPeriodMicroUsd)} used this month.` : ''}`,
    });
  if (usage.lastReceipt)
    facts.push({
      term: 'Last settled',
      value: `${formatUtc(usage.lastReceipt.settledAt)} · ${credits(usage.lastReceipt.allowanceDebitMicroUsd)}`,
      machine: usage.lastReceipt.receiptRef,
    });
  const fresh = freshnessOf(usage.observedAt, now);
  return {
    status: 'ready',
    percent: usage.usedPercent,
    meter: usage.usedPercent === null ? null : Math.min(100, Math.max(0, usage.usedPercent)),
    summary,
    detail: null,
    facts,
    resets: `Resets ${formatUtc(usage.resetsAt)}`,
    freshness: fresh.text,
    stale: fresh.stale,
    reconciliation: usage.reconciliation,
  };
}

/**
 * Whether a usage response may paint the organization currently shown. A late
 * response for a previous workspace, or one whose projection names another
 * organization, is dropped.
 */
export function acceptsUsage(currentOrganizationId: string, state: UsageState): boolean {
  if (state.organizationId !== currentOrganizationId) return false;
  if (state.state === 'ready' && state.projection.organizationId !== currentOrganizationId) return false;
  return true;
}
