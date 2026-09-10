import type { UsageSnapshot } from '../shared/types';

/**
 * Presentation policy for the Settings usage blocks.
 *
 * Server truth: `UsageSnapshot.detail` is the allowance-missing fallback
 * (e.g. "Codex has not reported its allowance yet..."). The usage service
 * merges partial records, so a snapshot can gain `windows` (poll/push) while
 * `detail` still holds that stale fallback and `thread` is still null. The
 * Settings page must not render that fallback alongside real windows.
 */
export function hasReportedAllowance(snapshot: UsageSnapshot): boolean {
  return snapshot.windows.length > 0;
}

/**
 * Show the server's `detail` sentence only when there is truly nothing else
 * to show: no allowance windows and no thread meter. Anywhere else it would
 * contradict the numbers on screen.
 */
export function shouldShowEmptyDetail(snapshot: UsageSnapshot): boolean {
  return !hasReportedAllowance(snapshot) && !snapshot.thread;
}

const SOURCE_LABELS: Record<UsageSnapshot['source'], string | null> = {
  poll: 'checked',
  push: 'live update',
  turn: 'last run',
  none: null,
};

/**
 * Freshness line derived only from the snapshot itself (`at` + `source`).
 * Null when the snapshot was never reported (`source: 'none'`) or `at` is
 * not a valid date, so an empty snapshot never claims to be fresh.
 */
export function freshnessLine(snapshot: UsageSnapshot): string | null {
  const sourceLabel = SOURCE_LABELS[snapshot.source];
  if (!sourceLabel) return null;
  if (!snapshot.at) return null;
  const at = new Date(snapshot.at);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const clock = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Updated ${day}, ${clock} · ${sourceLabel}.`;
}

/**
 * Plan line derived only from the snapshot itself. Null when the service
 * reported no plan, so no plan is ever invented.
 */
export function planLine(snapshot: UsageSnapshot): string | null {
  if (typeof snapshot.plan !== 'string') return null;
  const plan = snapshot.plan.trim();
  return plan ? `Plan: ${plan}.` : null;
}
