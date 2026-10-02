import { useEffect, useState } from 'react';
import { micro, projectUsage, type UsageState } from '../../shared/managed-usage';
import type { MyCreditUsage } from '../../shared/credit-allotments';
import { isActiveMember, type Membership, type WorkspaceView } from '../../shared/workspaces';
import { api } from '../api';
import { UsageCenterBar, creditsText } from './UsageCenter';
import { formatUtc } from './nectovia-usage-model';

/**
 * Settings, Usage, for a member of the selected business (Andrew, 2026-10-01, DIO-161 slice 3).
 *
 * A member sees their own use this month against their own limit, and nothing else: no business total,
 * no credits the business bought, nothing about anyone else, and nothing to buy. The numbers are the
 * account service's answer for the signed-in person, and this file only draws them with the bar an owner
 * or admin has, so the wording and the warning points can't drift apart. If the owner has turned off
 * members seeing their own usage, or the service can't or won't say, there is no entry at all: the rail
 * offers Usage only on a ready answer. A limit that is unlimited, or absent, shows what was used and no
 * bar, because there is nothing to measure it against.
 */

/** The selected business and the signed-in person's place in it, when that place is an active member's. */
export function memberUsageTarget(
  view: WorkspaceView | null,
): { organizationId: string; membership: Membership } | null {
  if (!view || view.active.kind !== 'business') return null;
  const id = view.active.organizationId;
  const found = view.organizations.find((item) => item.organization.id === id);
  if (!found || !isActiveMember(found.membership) || found.membership.role !== 'member') return null;
  return { organizationId: id, membership: found.membership };
}

/** What the screen knows: the service's answer for this person, or that it is still on its way. */
export type MyUsageRead = MyCreditUsage | { readonly state: 'loading'; readonly organizationId: string };

type Read = <T>(path: string) => Promise<T>;

const UNAVAILABLE = 'Usage isn’t available right now.';
const unavailable = (organizationId: string, reason = UNAVAILABLE): MyCreditUsage => ({ state: 'unavailable', organizationId, reason });

const isMoney = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isMyCreditUsage(value: unknown, organizationId: string): value is MyCreditUsage {
  if (!value || typeof value !== 'object') return false;
  const answer = value as Record<string, unknown>;
  if (answer.organizationId !== organizationId) return false;
  if (answer.state === 'hidden' || answer.state === 'unavailable') return true;
  if (answer.state !== 'ready') return false;
  const usage = answer.usage as Record<string, unknown> | null | undefined;
  return (
    typeof answer.periodId === 'string' &&
    typeof answer.resetsAt === 'string' &&
    !!usage &&
    isMoney(usage.usedMicroUsd) &&
    isMoney(usage.heldMicroUsd) &&
    (answer.limitMicroUsd === null || isMoney(answer.limitMicroUsd)) &&
    isMoney(answer.raisedByMicroUsd)
  );
}

/**
 * One read of the signed-in person's own usage. It never throws: a refused or failed read, an answer
 * for another business and one that isn't shaped as promised are all "unavailable", which has no figures
 * to draw as a zero and no entry to show.
 */
export async function loadMyUsage(organizationId: string, read: Read = api): Promise<MyCreditUsage> {
  try {
    const answer = await read<unknown>(`/workspace/organizations/${encodeURIComponent(organizationId)}/credit-usage/mine`);
    return isMyCreditUsage(answer, organizationId) ? answer : unavailable(organizationId);
  } catch {
    return unavailable(organizationId);
  }
}

/** The month a period id names, when it names one; the answer's own end of month otherwise. */
const startOf = (periodId: string, endsAt: string) => (/^\d{4}-\d{2}$/.test(periodId) ? `${periodId}-01T00:00:00.000Z` : endsAt);

/**
 * A limited member's month as the usage the business bar draws: the limit (and what an approval added to
 * it) is the grant, and what the person used is measured against it. What is held for work in flight is
 * part of what the service counts as used, so it is split out of the settled figure rather than added to it.
 */
export function memberUsageState(answer: Extract<MyCreditUsage, { state: 'ready' }>, observedAt: string): UsageState {
  const gone: UsageState = { state: 'unavailable', organizationId: answer.organizationId, reason: UNAVAILABLE };
  if (answer.limitMicroUsd === null) return gone;
  try {
    const held = Math.min(answer.usage.heldMicroUsd, answer.usage.usedMicroUsd);
    return {
      state: 'ready',
      organizationId: answer.organizationId,
      projection: projectUsage({
        organizationId: answer.organizationId,
        period: {
          periodId: answer.periodId,
          planId: 'member',
          grantedMicroUsd: micro(answer.limitMicroUsd + answer.raisedByMicroUsd),
          startsAt: startOf(answer.periodId, answer.resetsAt),
          endsAt: answer.resetsAt,
          rateCardVersion: 'member',
        },
        totals: {
          settledMonthlyMicroUsd: micro(answer.usage.usedMicroUsd - held),
          pendingMonthlyMicroUsd: micro(held),
          uncertainMonthlyMicroUsd: micro(0),
          correctionGrantsMicroUsd: micro(0),
          correctionWithdrawalsMicroUsd: micro(0),
          settledTopUpMicroUsd: micro(0),
        },
        topUp: { purchasedMicroUsd: micro(0), heldMicroUsd: micro(0), settledMicroUsd: micro(0) },
        lastReceipt: null,
        observedAt,
      }),
    };
  } catch {
    return gone;
  }
}

export function MemberUsageView({ usage, readAt, now }: { usage: MyUsageRead; readAt: number; now: number }) {
  if (usage.state === 'loading') return <UsageCenterBar state={{ state: 'loading', organizationId: usage.organizationId }} now={now} />;
  if (usage.state !== 'ready') return <UsageCenterBar state={{ state: 'unavailable', organizationId: usage.organizationId, reason: UNAVAILABLE }} now={now} />;
  if (usage.limitMicroUsd === null) {
    // No limit, or an unlimited one: what was used, and when the month resets. There is no bar to fill.
    const used = micro(usage.usage.usedMicroUsd);
    return (
      <section className="uc-section" aria-label="Agent usage">
        <h2>Agent usage</h2>
        <p className="uc-meter-text">{creditsText(used)} used this month</p>
        <p className="caption uc-when">Resets {formatUtc(usage.resetsAt)}</p>
      </section>
    );
  }
  return <UsageCenterBar state={memberUsageState(usage, new Date(readAt).toISOString())} now={now} />;
}

/**
 * The signed-in member's own usage, read now and every half minute while the page is open. A failed
 * read after a good one keeps the good one, which then says it may be out of date; a turned-off answer
 * replaces it at once. Null when there is no member screen to read for.
 */
export function useMyCreditUsage(organizationId: string | null) {
  const [held, setHeld] = useState<{ read: MyCreditUsage; readAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setHeld(null);
    if (!organizationId) return;
    let live = true;
    const load = () =>
      void loadMyUsage(organizationId).then((read) => {
        if (!live) return;
        const at = Date.now();
        setNow(at);
        setHeld((previous) =>
          read.state === 'unavailable' && previous?.read.state === 'ready' && previous.read.organizationId === organizationId
            ? previous
            : { read, readAt: at },
        );
      });
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [organizationId]);
  if (!organizationId) return null;
  const shown: { read: MyUsageRead; readAt: number } =
    held && held.read.organizationId === organizationId ? held : { read: { state: 'loading', organizationId }, readAt: now };
  return { usage: shown.read, readAt: shown.readAt, now };
}
