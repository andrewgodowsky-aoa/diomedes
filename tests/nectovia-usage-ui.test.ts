/**
 * NC-2026-09-22.1 Phase G: the Nectovia usage bar in the Console account area.
 *
 * The view is rendered statically from each state it can be in. Loading,
 * not-connected and unavailable must carry no figure and no meter, so none of
 * them can read as 0%. Figures are fixtures, not a plan anybody can buy.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  creditAmount,
  micro,
  projectUsage,
  type PeriodTotals,
  type TopUpTotals,
  type UsageState,
} from '../shared/managed-usage';
import { NectoviaUsageView } from '../client/console/NectoviaUsage';
import { acceptsPersonalUsage, acceptsUsage, usageBarModel } from '../client/console/nectovia-usage-model';
import type { PersonalUsageView } from '../shared/individual-plan';

const c = (credits: number) => creditAmount(credits);
const observedAt = '2026-10-15T12:00:00.000Z';
const now = Date.parse(observedAt) + 60_000;
const zero: PeriodTotals = {
  settledMonthlyMicroUsd: micro(0),
  pendingMonthlyMicroUsd: micro(0),
  uncertainMonthlyMicroUsd: micro(0),
  correctionGrantsMicroUsd: micro(0),
  correctionWithdrawalsMicroUsd: micro(0),
  settledTopUpMicroUsd: micro(0),
};
const noTopUp: TopUpTotals = { purchasedMicroUsd: micro(0), heldMicroUsd: micro(0), settledMicroUsd: micro(0) };

function ready(totals: Partial<PeriodTotals> = {}, topUp: Partial<TopUpTotals> = {}, over: { observedAt?: string; receipt?: boolean } = {}): UsageState {
  return {
    state: 'ready',
    organizationId: 'org_a',
    projection: projectUsage({
      organizationId: 'org_a',
      period: {
        periodId: '2026-10',
        planId: 'business',
        grantedMicroUsd: c(1000),
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-11-01T00:00:00.000Z',
        rateCardVersion: 'rate-card-2026-09-10.1',
      },
      totals: { ...zero, ...totals },
      topUp: { ...noTopUp, ...topUp },
      lastReceipt: over.receipt
        ? { receiptRef: 'receipt_aws_0001', settledAt: '2026-10-15T11:58:00.000Z', allowanceDebitMicroUsd: c(1.5) }
        : null,
      observedAt: over.observedAt ?? observedAt,
    }),
  };
}

const render = (state: UsageState, at = now) =>
  renderToStaticMarkup(createElement(NectoviaUsageView, { state, now: at, onRefresh: () => {}, refreshing: false }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the Nectovia usage bar', () => {
  it('settled 300 of a 1,000 grant reads 30%, in text and on the meter', () => {
    const html = render(ready({ settledMonthlyMicroUsd: c(300) }));
    expect(html).toContain('Nectovia usage');
    expect(text(html)).toContain('30% of this month’s 1,000 credits used');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toMatch(/aria-valuetext="30% of this month’s 1,000 credits used"/);
  });

  it('pending 100 and uncertain 50 are shown apart and leave 550 available', () => {
    const page = text(render(ready({ settledMonthlyMicroUsd: c(300), pendingMonthlyMicroUsd: c(100), uncertainMonthlyMicroUsd: c(50) })));
    expect(page).toContain('Available this month 550 credits');
    expect(page).toContain('Held for work in flight 100 credits');
    expect(page).toContain('Held, outcome not yet known 50 credits');
    expect(page).toContain('30%');
  });

  it('shows top-ups as a separate balance that leaves the monthly percentage alone', () => {
    const page = text(render(ready({ settledMonthlyMicroUsd: c(300), settledTopUpMicroUsd: c(40) }, { purchasedMicroUsd: c(500), settledMicroUsd: c(40) })));
    expect(page).toContain('30% of this month’s 1,000 credits used');
    expect(page).toContain('Top-up balance 460 credits');
    expect(page).toMatch(/separate from the monthly grant/);
  });

  it('never draws loading, not-connected or unavailable as 0%', () => {
    const states: UsageState[] = [
      { state: 'loading', organizationId: 'org_a' },
      { state: 'not-connected', organizationId: 'org_a', reason: 'This app is not signed in to a Nectovia account.' },
      { state: 'unavailable', organizationId: 'org_a', reason: 'No credit grant is recorded for this month.' },
    ];
    for (const state of states) {
      const html = render(state);
      expect(html).not.toContain('role="progressbar"');
      expect(html).not.toMatch(/\b0%/);
      expect(html).not.toMatch(/\b0 credits/);
      expect(usageBarModel(state, now).percent).toBeNull();
    }
    expect(text(render(states[0]))).toContain('Checking usage');
    expect(text(render(states[1]))).toContain('Not connected');
    expect(text(render(states[1]))).toContain('not signed in to a Nectovia account');
    expect(text(render(states[2]))).toContain('Unavailable');
  });

  it('a new month with nothing settled reads 0% as a real figure, not a placeholder', () => {
    const html = render(ready());
    expect(html).toContain('aria-valuenow="0"');
    expect(text(html)).toContain('0% of this month’s 1,000 credits used');
  });

  it('carries the reset time with its timezone, freshness and the last receipt', () => {
    const page = text(render(ready({ settledMonthlyMicroUsd: c(1.5) }, {}, { receipt: true })));
    expect(page).toContain('Resets Nov 1, 2026, 00:00 UTC');
    expect(page).toContain('Updated 1 minute ago');
    expect(page).toContain('receipt_aws_0001');
    expect(page).toContain('1.5 credits');
  });

  it('marks stale figures instead of presenting them as current', () => {
    const model = usageBarModel(ready({}, {}, { observedAt: '2026-10-15T11:00:00.000Z' }), now);
    expect(model.stale).toBe(true);
    expect(model.freshness).toMatch(/may be out of date/);
  });

  it('explains overspend instead of clamping it away', () => {
    const page = text(render(ready({ settledMonthlyMicroUsd: c(1000), uncertainMonthlyMicroUsd: c(20) })));
    expect(page).toContain('Over by 20 credits');
    expect(page).toMatch(/reconciled against provider records/);
  });

  it('says nothing about included chat while no entitlement exists', () => {
    const page = text(render(ready({ settledMonthlyMicroUsd: c(300) })));
    expect(page).not.toMatch(/included/i);
  });

  it('never equates a credit with a call, request or task', () => {
    const pages = [render(ready({ settledMonthlyMicroUsd: c(300) }, {}, { receipt: true })), render({ state: 'loading', organizationId: 'org_a' })];
    for (const page of pages) expect(text(page)).not.toMatch(/\b(request|call|task)s?\b/i);
  });

  it('refresh is a real keyboard-reachable button', () => {
    const html = render(ready());
    expect(html).toMatch(/<button[^>]*>Refresh<\/button>/);
  });

  it.each([749, 750, 899, 900, 999, 1000])('warns at the allowance thresholds: %s credits committed', (committed) => {
    const state = ready({ settledMonthlyMicroUsd: c(committed - 100), pendingMonthlyMicroUsd: c(60), uncertainMonthlyMicroUsd: c(40) });
    const model = usageBarModel(state, now);
    if (committed < 750) {
      expect(model.alert).toBeNull();
    } else {
      expect(model.alert).toContain(committed >= 1000 ? 'No monthly credits remain' : committed >= 900 ? '90%' : '75%');
      expect(render(state)).toContain('role="alert"');
      expect(model.alert).toContain('never starts automatically');
    }
  });

  it('purchased usage does not postpone the monthly allowance warning', () => {
    const model = usageBarModel(ready({ settledMonthlyMicroUsd: c(900) }, { purchasedMicroUsd: c(5000) }), now);
    expect(model.alert).toContain('90%');
  });

  it('never presents a stale or unknown allowance warning as current', () => {
    expect(usageBarModel(ready({ settledMonthlyMicroUsd: c(950) }, {}, { observedAt: '2026-10-15T11:00:00.000Z' }), now).alert).toBeNull();
    expect(usageBarModel({ state: 'unavailable', organizationId: 'org_a', reason: 'Offline' }, now).alert).toBeNull();
  });

  it('reports exhaustion after a withdrawal without claiming the withdrawn credits were spent', () => {
    const model = usageBarModel(ready({ settledMonthlyMicroUsd: c(100), correctionWithdrawalsMicroUsd: c(900) }), now);
    expect(model.alert).toContain('No monthly credits remain');
    expect(model.summary).toContain('10%');
  });

  it('keeps granted corrections available even when the original monthly grant is fully used', () => {
    const model = usageBarModel(ready({ settledMonthlyMicroUsd: c(1000), correctionGrantsMicroUsd: c(200) }), now);
    expect(model.alert).toContain('100%');
    expect(model.alert).not.toContain('No monthly credits remain');
    expect(model.facts.find((fact) => fact.term === 'Available this month')?.value).toBe('200 credits');
  });
});

describe('a usage response only paints the organization it was asked for', () => {
  it('drops a late response for another organization', () => {
    const late: UsageState = { state: 'not-connected', organizationId: 'org_old', reason: 'x' };
    expect(acceptsUsage('org_new', late)).toBe(false);
    expect(acceptsUsage('org_old', late)).toBe(true);
  });

  it('drops a ready response whose projection names another organization', () => {
    const state = ready();
    const forged: UsageState = { ...state, organizationId: 'org_b' } as UsageState;
    expect(acceptsUsage('org_b', forged)).toBe(false);
  });
});

describe('a person own Individual credits read as a billing period, not a calendar month (DIO-128)', () => {
  const period = { periodId: 'individual:2026-09-30T15:00:00.000Z', planId: 'individual', grantedMicroUsd: c(1000),
    startsAt: '2026-09-30T15:00:00.000Z', endsAt: '2026-10-30T15:00:00.000Z', rateCardVersion: 'rate-card-2026-09-10.1' };
  const personal = (allocation: 'pending' | 'recorded', totals: Partial<PeriodTotals> = {}): UsageState => ({ state: 'ready', organizationId: 'individual_a',
    projection: projectUsage({ organizationId: 'individual_a', period, totals: { ...zero, ...totals }, topUp: noTopUp, lastReceipt: null, observedAt, allocation }) });
  const view = (usage: UsageState, renewal: PersonalUsageView['renewal'] = null): PersonalUsageView =>
    ({ v: 1, personId: 'person_a', accountId: 'individual_a', usage, renewal, checkedAt: observedAt });

  it('uses period-neutral words and the exact UTC end, and says a new allowance needs a renewal', () => {
    const model = usageBarModel(personal('recorded', { settledMonthlyMicroUsd: c(250) }), now,
      { kind: 'individual', renewal: { state: 'not-renewed', nextStartsAt: period.endsAt, nextEndsAt: '2026-11-30T15:00:00.000Z' } });
    expect(model.summary).toBe('25% of this billing period’s 1,000 credits used');
    expect(model.facts.map(fact => fact.term)).toEqual(['Used this billing period', 'Available this billing period']);
    expect(model.resets).toBe('Current credits expire Oct 30, 2026, 15:00 UTC; a new allowance needs a renewal');
    expect(JSON.stringify(model)).not.toMatch(/this month|Resets/);
  });

  it('says a paid renewal starts at the end, and promises nothing when the renewal state is unknown', () => {
    expect(usageBarModel(personal('recorded'), now, { kind: 'individual', renewal: { state: 'renewed', nextStartsAt: period.endsAt, nextEndsAt: '2026-11-30T15:00:00.000Z' } }).resets)
      .toBe('Current credits expire Oct 30, 2026, 15:00 UTC; the next billing period is paid for and starts then');
    expect(usageBarModel(personal('recorded'), now, { kind: 'individual', renewal: null }).resets).toBe('Current credits expire Oct 30, 2026, 15:00 UTC');
  });

  it('shows a verified period before first use at its approved grant with nothing used', () => {
    const model = usageBarModel(personal('pending'), now, { kind: 'individual', renewal: null });
    expect(model).toMatchObject({ status: 'ready', percent: 0, summary: '0% of this billing period’s 1,000 credits used' });
    expect(model.facts[1]).toEqual({ term: 'Available this billing period', value: '1,000 credits' });
  });

  it('keeps business usage on its calendar month wording', () => {
    expect(usageBarModel(ready({ settledMonthlyMicroUsd: c(300) }), now).summary).toBe('30% of this month’s 1,000 credits used');
  });

  it('drops a Personal answer for another person, another account or an ended period', () => {
    const shown = view(personal('recorded'));
    expect(acceptsPersonalUsage(shown, 'person_a', now)).toBe(true);
    expect(acceptsPersonalUsage(shown, 'person_b', now)).toBe(false);
    expect(acceptsPersonalUsage({ ...shown, accountId: 'individual_b' }, 'person_a', now)).toBe(false);
    expect(acceptsPersonalUsage(shown, 'person_a', Date.parse(period.endsAt))).toBe(false);
    expect(acceptsPersonalUsage(view({ state: 'unavailable', organizationId: 'individual_a', reason: 'No plan.' }), 'person_a', now)).toBe(true);
  });
});

