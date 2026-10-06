/**
 * The Usage screen in Settings (Andrew, 2026-10-01, DIO-161 slice 2).
 *
 * An owner or an admin of the selected business sees how much of the month's included credits are
 * used, a bar that changes colour at the warning points the usage panel already has, the credits the
 * business bought, and a way to buy more. Anyone else sees nothing new. Customers see credits
 * everywhere; the one place a dollar figure appears is the price of a purchase, before it and after.
 * Views are rendered statically from each state they can be in. Every figure here is invented.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  creditAmount,
  micro,
  projectUsage,
  type PeriodTotals,
  type PurchasedUsageState,
  type TopUpTotals,
  type UsageProjection,
  type UsageState,
} from '../shared/managed-usage';
import type { Membership, WorkspaceView } from '../shared/workspaces';
import {
  USAGE_DANGER_PERCENT,
  USAGE_EXHAUSTED_PERCENT,
  USAGE_WARNING_PERCENT,
  usageBarModel,
} from '../client/console/nectovia-usage-model';
import {
  BuyCreditsView,
  PersonalUsageView,
  UsageCenter,
  UsageCenterBar,
  UsageCenterView,
  usageCenterTarget,
  usageMeterText,
} from '../client/console/UsageCenter';
import type { FlowState } from '../client/console/credit-purchase-flow';
import {
  MemberUsageView,
  loadMyUsage,
  memberUsageState,
  memberUsageTarget,
  type MyUsageRead,
} from '../client/console/MemberUsage';
import type { MyCreditUsage } from '../shared/credit-allotments';
import { BOUGHT_CREDITS_LAST, BUSINESS_CREDITS_NEED_PLAN } from '../shared/access';

const c = (credits: number) => creditAmount(credits);
const observedAt = '2026-10-15T12:00:00.000Z';
const now = Date.parse(observedAt) + 60_000;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

const zero: PeriodTotals = {
  settledMonthlyMicroUsd: micro(0),
  pendingMonthlyMicroUsd: micro(0),
  uncertainMonthlyMicroUsd: micro(0),
  correctionGrantsMicroUsd: micro(0),
  correctionWithdrawalsMicroUsd: micro(0),
  settledTopUpMicroUsd: micro(0),
};
const noTopUp: TopUpTotals = { purchasedMicroUsd: micro(0), heldMicroUsd: micro(0), settledMicroUsd: micro(0) };

/** A month granting `granted` credits, with `used` settled and `held` pending. */
function projection(used: number, held = 0, granted = 1000): UsageProjection {
  return projectUsage({
    organizationId: 'org_a',
    period: {
      periodId: '2026-10',
      planId: 'business',
      grantedMicroUsd: c(granted),
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
      rateCardVersion: 'rate-card-2026-09-10.1',
    },
    totals: { ...zero, settledMonthlyMicroUsd: c(used), pendingMonthlyMicroUsd: c(held) },
    topUp: noTopUp,
    lastReceipt: null,
    observedAt,
  });
}
const ready = (used: number, held = 0, granted = 1000): UsageState => ({
  state: 'ready',
  organizationId: 'org_a',
  projection: projection(used, held, granted),
});
const bar = (state: UsageState, at = now) => renderToStaticMarkup(createElement(UsageCenterBar, { state, now: at }));

describe('the warning points are the ones the usage panel already has', () => {
  it('names 75, 90 and 100 once, and the panel’s alert still reads from them', () => {
    expect([USAGE_WARNING_PERCENT, USAGE_DANGER_PERCENT, USAGE_EXHAUSTED_PERCENT]).toEqual([75, 90, 100]);
    const source = read('client/console/nectovia-usage-model.ts');
    expect(source).not.toMatch(/>=\s*(75|90|100)\b/);
    expect(source).toContain('USAGE_WARNING_PERCENT');
    expect(source).toContain('USAGE_DANGER_PERCENT');
  });

  it.each([
    [0, 'ok'],
    [74, 'ok'],
    [74.9, 'ok'],
    [75, 'warning'],
    [89, 'warning'],
    [89.9, 'warning'],
    [90, 'danger'],
    [99, 'danger'],
    [100, 'danger'],
    [130, 'danger'],
  ] as const)('%s%% of the month used reads as %s', (used, tone) => {
    const model = usageBarModel(ready(used * 10), now);
    expect(model.tone).toBe(tone);
  });

  it('counts held credits as the existing alert does, though the fill follows what is settled', () => {
    // Half settled and a quarter held: the fill says 50, the warning point says 75.
    const model = usageBarModel(ready(500, 250), now);
    expect(model.meter).toBe(50);
    expect(model.tone).toBe('warning');
    expect(model.alert).toMatch(/At least 75%/);
  });

  it('no credits left available is the danger tone however the percentages fall', () => {
    const state = ready(100);
    if (state.state !== 'ready') throw new Error('fixture');
    const empty: UsageState = { ...state, projection: { ...state.projection, availableMicroUsd: micro(0) } };
    expect(usageBarModel(empty, now).tone).toBe('danger');
  });

  it('a month with no grant has no tone, and neither does anything that is not ready', () => {
    expect(usageBarModel(ready(0, 0, 0), now).tone).toBeNull();
    expect(usageBarModel({ state: 'loading', organizationId: 'org_a' }, now).tone).toBeNull();
    expect(usageBarModel({ state: 'unavailable', organizationId: 'org_a', reason: 'x' }, now).tone).toBeNull();
  });

  it('the tone is still drawn when the figures are old, though the alert text is not', () => {
    const model = usageBarModel(ready(800), now + 60 * 60_000);
    expect(model.stale).toBe(true);
    expect(model.alert).toBeNull();
    expect(model.tone).toBe('warning');
  });
});

describe('the agent usage bar', () => {
  it('says "800 of 1,000 credits used this month" and is a meter with real values', () => {
    const html = bar(ready(800));
    expect(usageMeterText(projection(800))).toBe('800 of 1,000 credits used this month');
    expect(text(html)).toContain('800 of 1,000 credits used this month');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="1000"');
    expect(html).toContain('aria-valuenow="800"');
    expect(html).toContain('aria-valuetext="800 of 1,000 credits used this month"');
    expect(html).toMatch(/aria-label="[^"]+"/);
    expect(html).toContain('width:80%');
  });

  it('writes credits the way the rest of the app does: grouped, two decimals at most, singular for one', () => {
    expect(usageMeterText(projection(1234.5, 0, 12000))).toBe('1,234.5 of 12,000 credits used this month');
    expect(usageMeterText(projection(0, 0, 1))).toBe('0 of 1 credit used this month');
    expect(usageMeterText(projection(0.004, 0, 1000))).toBe('less than 0.01 of 1,000 credits used this month');
  });

  it.each([
    [0, 'ok', ''],
    [740, 'ok', ''],
    [750, 'warning', 'signal'],
    [890, 'warning', 'signal'],
    [900, 'danger', 'fault'],
    [1000, 'danger', 'fault'],
  ] as const)('with %s of 1,000 used the fill is %s', (used, tone, fillClass) => {
    const html = bar(ready(used));
    expect(html).toContain(`data-tone="${tone}"`);
    const fill = html.match(/<span class="([^"]*)" style="width:[^"]*"/);
    expect(fill).not.toBeNull();
    const classes = fill![1]!.split(' ');
    expect(classes).toContain('uc-fill');
    expect(classes.includes('signal')).toBe(fillClass === 'signal');
    expect(classes.includes('fault')).toBe(fillClass === 'fault');
  });

  it('says in words how the month stands as it winds down, and nothing while it is fine', () => {
    expect(text(bar(ready(500)))).not.toMatch(/running low|almost gone|used up/);
    expect(text(bar(ready(800)))).toContain('Your monthly credits are running low.');
    expect(text(bar(ready(950)))).toContain('Your monthly credits are almost gone.');
    expect(text(bar(ready(1000)))).toContain('Your monthly credits are used up.');
  });

  it('draws a month used past its grant as a full bar, and says the true figure', () => {
    const html = bar(ready(1300));
    expect(html).toContain('width:100%');
    expect(html).toContain('aria-valuenow="1000"');
    expect(text(html)).toContain('1,300 of 1,000 credits used this month');
  });

  it('says what is held for work in flight, and when the month resets', () => {
    const page = text(bar(ready(500, 40)));
    expect(page).toContain('40 credits are reserved for work in flight.');
    expect(page).toContain('Resets Nov 1, 2026');
    expect(text(bar(ready(500)))).not.toContain('reserved');
  });

  it('a month with no grant draws no bar and no percentage', () => {
    const html = bar(ready(0, 0, 0));
    expect(html).not.toContain('role="meter"');
    expect(text(html)).toContain('No monthly credits this month.');
  });

  it.each([
    [{ state: 'loading', organizationId: 'org_a' } as UsageState, 'Checking usage.'],
    [{ state: 'not-connected', organizationId: 'org_a', reason: 'Not signed in. 12 of 40.' } as UsageState, 'Usage can’t be shown until you’re signed in.'],
    [{ state: 'unavailable', organizationId: 'org_a', reason: 'Down. 3 of 9.' } as UsageState, 'Usage isn’t available right now.'],
  ])('%#: one plain line and no numbers when the service can’t say', (state, line) => {
    const html = bar(state);
    expect(text(html)).toContain(line);
    expect(text(html)).not.toMatch(/\d/);
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain('<dl');
  });
});

const owner = { id: 'm_1', organizationId: 'org_a', personId: 'p_1', role: 'owner', state: 'active' } as unknown as Membership;
const asRole = (role: Membership['role'], state: Membership['state'] = 'active') => ({ ...owner, role, state }) as Membership;
const idle: FlowState = { input: '1000', quote: { state: 'ready', credits: 1000, amountCents: 12000 }, purchase: { phase: 'idle' }, step: { credits: 100, cents: 1200 }, onPlan: true, planStep: null };
const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3';
const buyView = (state: FlowState) =>
  renderToStaticMarkup(createElement(BuyCreditsView, { state, onInput: () => {}, onBuy: () => {}, onReset: () => {} }));
const bought: PurchasedUsageState = {
  state: 'ready',
  organizationId: 'org_a',
  balance: { purchasedMicroUsd: c(1000), heldMicroUsd: c(40), settledMicroUsd: c(250), availableMicroUsd: c(710) },
};
const whole = (usage: UsageState, purchased: PurchasedUsageState | null, buy: FlowState = idle) =>
  renderToStaticMarkup(
    createElement(UsageCenterView, { usage, now, purchased, buy, onInput: () => {}, onBuy: () => {}, onReset: () => {} }),
  );

describe('who sees the Usage screen', () => {
  it('an owner and an admin do; a member, a pending invitee and nobody do not', () => {
    const view = (m: Membership | null) =>
      ({
        active: m ? { kind: 'business', organizationId: 'org_a' } : { kind: 'personal' },
        organizations: m ? [{ organization: { id: 'org_a', name: 'Juniper Street Bakery' }, membership: m }] : [],
      }) as unknown as WorkspaceView;
    expect(usageCenterTarget(view(asRole('owner')))).toEqual({ organizationId: 'org_a', membership: asRole('owner') });
    expect(usageCenterTarget(view(asRole('admin')))?.organizationId).toBe('org_a');
    expect(usageCenterTarget(view(asRole('member')))).toBeNull();
    expect(usageCenterTarget(view(asRole('admin', 'invited' as Membership['state'])))).toBeNull();
    expect(usageCenterTarget(view(null))).toBeNull();
    expect(usageCenterTarget(null)).toBeNull();
  });

  it('draws nothing at all for a member, and starts for an owner and an admin', () => {
    const render = (membership: Membership) =>
      renderToStaticMarkup(createElement(UsageCenter, { organizationId: 'org_a', membership, report: () => {} }));
    expect(render(asRole('member'))).toBe('');
    expect(text(render(asRole('owner')))).toContain('Checking usage.');
    expect(text(render(asRole('admin')))).toContain('Checking usage.');
  });

  it('the Settings rail offers Usage only to someone who may see it', () => {
    const settings = read('client/Settings.tsx');
    expect(settings).toMatch(/usageCenterTarget\(/);
    expect(settings).toMatch(/usage\s*\?\s*\['Usage'\]|\.\.\.\(usage/);
    expect(settings).toMatch(/section === 'Usage' && usageScreen/);
  });
});

describe('the whole screen', () => {
  it('shows the bar, the bought credits, and the way to buy more, in that order', () => {
    const html = whole(ready(800), bought);
    const page = text(html);
    expect(page).toContain('Agent usage');
    expect(page).toContain('800 of 1,000 credits used this month');
    expect(page).toContain('Credits you bought');
    expect(page).toContain('Available 710 credits');
    expect(page).toContain('Buy credits');
    const at = (needle: string) => page.indexOf(needle);
    expect(at('800 of 1,000')).toBeLessThan(at('Credits you bought'));
    expect(at('Credits you bought')).toBeLessThan(at('Buy credits'));
  });

  it('reuses the bought-credits view, not a copy of it', () => {
    expect(read('client/console/UsageCenter.tsx')).toMatch(/import\s*\{[^}]*PurchasedCreditsView[^}]*\}\s*from\s*'\.\/PurchasedCredits'/);
  });

  it.each([
    { state: 'loading', organizationId: 'org_a' } as UsageState,
    { state: 'not-connected', organizationId: 'org_a', reason: 'r' } as UsageState,
    { state: 'unavailable', organizationId: 'org_a', reason: 'r' } as UsageState,
  ])('%#: when usage can’t be read, one line and nothing to buy', (usage) => {
    const html = whole(usage, bought);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(text(html)).not.toMatch(/\d/);
    expect(text(html)).not.toContain('Credits you bought');
  });

  it('a bought balance the service could not read shows its own plain line, never a zero', () => {
    const page = text(whole(ready(10), { state: 'unavailable', organizationId: 'org_a', reason: 'The account service couldn’t say what this business has bought.' }));
    expect(page).toContain('couldn’t say what this business has bought');
  });
});

describe('the buy form', () => {
  it('is a number field in steps of 100 from 100, with a live total that is only what the quote said', () => {
    const html = buyView(idle);
    expect(html).toMatch(/<input[^>]*type="number"/);
    expect(html).toMatch(/<input[^>]*min="100"/);
    expect(html).toMatch(/<input[^>]*step="100"/);
    expect(html).toMatch(/<input[^>]*max="100000"/);
    expect(html).toMatch(/<input[^>]*value="1000"/);
    expect(text(html)).toContain('1,000 credits for $120.00 at the current usage rate');
    expect(html).toMatch(/<button[^>]*>Buy<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it('takes its step and bounds from the quote: a plan step of 110 is a field in steps of 110 up to 99,990, and before any quote it takes any whole number', () => {
    const plan = buyView({ ...idle, input: '990', quote: { state: 'ready', credits: 990, amountCents: 9000 }, step: { credits: 110, cents: 1000 } });
    expect(plan).toMatch(/<input[^>]*min="110"/);
    expect(plan).toMatch(/<input[^>]*step="110"/);
    expect(plan).toMatch(/<input[^>]*max="99990"/);
    const unknown = buyView({ ...idle, quote: { state: 'loading' }, step: null });
    expect(unknown).toMatch(/<input[^>]*min="1"/);
    expect(unknown).toMatch(/<input[^>]*step="1"/);
    expect(unknown).toMatch(/<input[^>]*max="100000"/);
  });

  it('shows whatever total the quote gave, because the client never works one out', () => {
    const page = text(buyView({ ...idle, quote: { state: 'ready', credits: 1000, amountCents: 999 } }));
    expect(page).toContain('1,000 credits for $9.99 at the current usage rate');
    // The headline above it is the published price, ten of the quoted steps; the total for the amount is never worked out.
    expect(page).not.toContain('for $120');
  });

  it('holds Buy until there is a total, and says why in plain words', () => {
    const loading = buyView({ ...idle, quote: { state: 'loading' } });
    expect(loading).toMatch(/<button[^>]*disabled[^>]*>Buy<\/button>/);
    expect(text(loading)).toContain('Working out the total.');
    expect(text(loading)).not.toContain('$');

    const invalid = buyView({ input: '150', quote: { state: 'invalid', message: 'Enter 100 credits or more, in steps of 100, up to 100,000.' }, purchase: { phase: 'idle' }, step: { credits: 100, cents: 1200 }, onPlan: true, planStep: null });
    expect(invalid).toMatch(/<button[^>]*disabled/);
    expect(text(invalid)).toContain('Enter 100 credits or more, in steps of 100, up to 100,000.');

    const down = buyView({ ...idle, quote: { state: 'unavailable', message: 'Buying credits isn’t available right now. Try again later.' } });
    expect(down).toMatch(/<button[^>]*disabled/);
    expect(text(down)).toContain('Buying credits isn’t available right now. Try again later.');
    expect(text(down)).not.toContain('$');
  });

  it('while payment is waiting: says so, offers the payment page again, keeps the amount, shows no dollars', () => {
    const html = buyView({
      input: '1000',
      quote: { state: 'ready', credits: 1000, amountCents: 12000 },
      purchase: { phase: 'waiting', purchaseId: 'cp_0123456789abcdef', credits: 1000, amountCents: 12000, checkoutUrl: STRIPE_URL },
      step: { credits: 100, cents: 1200 }, onPlan: true, planStep: null,
    });
    const page = text(html);
    expect(page).toContain('Waiting for your payment for 1,000 credits.');
    expect(html).toContain(`<a href="${STRIPE_URL}" target="_blank" rel="noreferrer">Open the payment page</a>`);
    expect(page).toContain('Stop waiting');
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(page).not.toContain('$');
  });

  it('after payment: says what was added and what it cost, and lets another be bought', () => {
    const html = buyView({ ...idle, purchase: { phase: 'paid', credits: 1000, amountCents: 12000 } });
    expect(text(html)).toContain('Paid $120.00. 1,000 credits were added.');
    expect(html).toMatch(/<button[^>]*>Buy more<\/button>/);
  });

  it('after a window that closed, a payment that failed, or a start that was refused: plain words, credits only, a way to try again', () => {
    const expired = buyView({ ...idle, purchase: { phase: 'expired' } });
    expect(text(expired)).toContain('That payment window closed before it was paid.');
    const failed = buyView({ ...idle, purchase: { phase: 'failed' } });
    expect(text(failed)).toContain('The payment didn’t go through.');
    const refused = buyView({ ...idle, purchase: { phase: 'error', message: 'That payment page can’t be opened from here. Try again in a moment.' } });
    expect(text(refused)).toContain('That payment page can’t be opened from here. Try again in a moment.');
    for (const html of [expired, failed, refused]) {
      expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
      expect(text(html)).not.toContain('$');
    }
  });

  it('while starting, holds the form', () => {
    const html = buyView({ ...idle, purchase: { phase: 'starting' } });
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(text(html)).toContain('Starting your payment.');
  });
});

/** The published prices (Model B section 1): on a plan $100 buys 1,100 credits, in steps of 110; without one $130 buys 1,000, in steps of 100. */
const onPlan: FlowState = { input: '990', quote: { state: 'ready', credits: 990, amountCents: 9000 }, purchase: { phase: 'idle' },
  step: { credits: 110, cents: 1000 }, onPlan: true, planStep: null };
const noPlan: FlowState = { input: '1000', quote: { state: 'ready', credits: 1000, amountCents: 13000 }, purchase: { phase: 'idle' },
  step: { credits: 100, cents: 1300 }, onPlan: false, planStep: { credits: 110, cents: 1000 } };
const buyFor = (state: FlowState, payer: 'business' | 'person') =>
  renderToStaticMarkup(createElement(BuyCreditsView, { state, onInput: () => {}, onBuy: () => {}, onReset: () => {}, payer }));
const personal = (purchased: PurchasedUsageState | null, buy: FlowState = noPlan) =>
  renderToStaticMarkup(createElement(PersonalUsageView, { purchased, buy, onInput: () => {}, onBuy: () => {}, onReset: () => {} }));
const personalBought: PurchasedUsageState = { ...bought, organizationId: 'personal' };

describe('the buy box lines (Model B section 7)', () => {
  it('on a plan: the plan price and how long credits last, and nothing about a plan', () => {
    const page = text(buyFor(onPlan, 'business'));
    expect(page).toContain('$100 buys 1,100 credits.');
    expect(page).toContain(BOUGHT_CREDITS_LAST);
    expect(page).not.toContain('On a plan');
    expect(page).not.toContain(BUSINESS_CREDITS_NEED_PLAN);
  });

  it('a business without a plan: the no-plan price, the plan price under it, and that the credits wait for a plan', () => {
    const page = text(buyFor(noPlan, 'business'));
    expect(page).toContain('$130 buys 1,000 credits. On a plan, $100 buys 1,100 credits.');
    expect(page).toContain('This business can use these credits once it has a plan.');
    expect(page).toContain('Credits you buy last 12 months.');
    // Buying stays open: the form and its Buy button are there.
    expect(buyFor(noPlan, 'business')).toMatch(/<button[^>]*>Buy<\/button>/);
  });

  it('a person without a plan: the same prices, and no business sentence', () => {
    const page = text(buyFor(noPlan, 'person'));
    expect(page).toContain('$130 buys 1,000 credits.');
    expect(page).toContain('On a plan, $100 buys 1,100 credits.');
    expect(page).toContain(BOUGHT_CREDITS_LAST);
    expect(page).not.toContain('business');
  });

  it('shows prices only beside a quote that answered: never while loading, waiting or after a failure', () => {
    for (const state of [{ ...noPlan, quote: { state: 'loading' } }, { ...noPlan, purchase: { phase: 'failed' } }] as FlowState[])
      expect(text(buyFor(state, 'person'))).not.toContain('$');
    // How long credits last is said whatever the state.
    expect(text(buyFor({ ...noPlan, quote: { state: 'loading' } }, 'person'))).toContain(BOUGHT_CREDITS_LAST);
  });
});

describe('Usage in Personal (pay as you go)', () => {
  it('shows the credits the person bought and a way to buy more, with no monthly usage line', () => {
    const html = personal(personalBought);
    const page = text(html);
    expect(page).toContain('Credits you bought');
    expect(page).toContain('Buy credits');
    expect(page).toContain('$130 buys 1,000 credits.');
    expect(page).not.toContain('included monthly usage');
    expect(page).not.toContain('business');
  });

  it('shows one plain line and nothing to buy while the balance can’t be read', () => {
    const signedOut = text(personal({ state: 'not-connected', organizationId: 'personal', reason: 'Sign in to see the credits you bought.' }));
    expect(signedOut).toContain('Sign in to see the credits you bought.');
    expect(signedOut).not.toContain('Buy credits');
    expect(text(personal(null))).toBe('Checking your credits.');
  });

  it('the Settings rail offers Usage in Personal, and the screen buys for the person, never a business', () => {
    const settings = read('client/Settings.tsx');
    expect(settings).toMatch(/const personalScreen = workspace\?\.active\.kind === 'personal'/);
    expect(settings).toMatch(/section === 'Usage' && personalScreen && <PersonalUsage/);
    const screen = read('client/console/UsageCenter.tsx');
    expect(screen).toMatch(/useCreditPurchase\(null, paid\)/);
    expect(screen).toMatch(/payer="person"/);
  });
});

describe('what customers read here', () => {
  const states: [string, string][] = [
    ['buy on a plan', buyFor(onPlan, 'business')],
    ['buy no plan, business', buyFor(noPlan, 'business')],
    ['buy no plan, person', buyFor(noPlan, 'person')],
    ['personal usage', personal(personalBought)],
    ['bar ok', bar(ready(100))],
    ['bar warning', bar(ready(800))],
    ['bar danger', bar(ready(950))],
    ['bar out', bar(ready(1000))],
    ['bar loading', bar({ state: 'loading', organizationId: 'org_a' })],
    ['bar not connected', bar({ state: 'not-connected', organizationId: 'org_a', reason: 'r' })],
    ['whole screen', whole(ready(800), bought)],
    ['buy idle', buyView(idle)],
    ['buy loading', buyView({ ...idle, quote: { state: 'loading' } })],
    ['buy invalid', buyView({ input: '1', quote: { state: 'invalid', message: 'Enter 100 credits or more, in steps of 100, up to 100,000.' }, purchase: { phase: 'idle' }, step: { credits: 100, cents: 1200 }, onPlan: true, planStep: null })],
    ['buy starting', buyView({ ...idle, purchase: { phase: 'starting' } })],
    ['buy waiting', buyView({ ...idle, purchase: { phase: 'waiting', purchaseId: 'cp_0123456789abcdef', credits: 1000, amountCents: 12000, checkoutUrl: STRIPE_URL } })],
    ['buy paid', buyView({ ...idle, purchase: { phase: 'paid', credits: 1000, amountCents: 12000 } })],
    ['buy expired', buyView({ ...idle, purchase: { phase: 'expired' } })],
    ['buy failed', buyView({ ...idle, purchase: { phase: 'failed' } })],
  ];

  it.each(states)('%s: no italics, dashes, exclamations, vendor or model names, markup talk or reassurance tails', (_name, html) => {
    const page = text(html);
    expect(html).not.toMatch(/<(i|em)[ >]/);
    expect(html).not.toMatch(/font-style/);
    expect(page).not.toMatch(/[–—]/);
    expect(page).not.toContain('!');
    expect(page).not.toMatch(/Nothing was (charged|sent|held|changed)/);
    expect(page).not.toMatch(/stripe|claude|anthropic|openai|gpt|gemini|llama|mistral|deepseek|bedrock|vertex/i);
    expect(page).not.toMatch(/markup|mark-up|margin|percent|%|cost price|at cost|wholesale/i);
  });

  it('dollars appear only in the price of a purchase, before it and after it', () => {
    for (const [name, html] of states) {
      const priced = ['buy idle', 'buy paid', 'whole screen', 'buy on a plan', 'buy no plan, business', 'buy no plan, person', 'personal usage'].includes(name);
      expect(/\$/.test(html), name).toBe(priced);
    }
  });

  it('the rate wording is "at the current usage rate" and nothing about a percentage', () => {
    expect(text(buyView(idle))).toMatch(/at the current usage rate/);
    expect(read('client/console/UsageCenter.tsx')).not.toMatch(/\b(20|1\.2|120)\s*%|markup|1\.2\b/i);
    expect(read('client/console/credit-purchase-flow.ts')).not.toMatch(/\b(20|1\.2|120)\s*%|markup|1\.2\b|\* ?12\b|1200/i);
  });
});

describe('the look', () => {
  const css = read('client/console/usage-center.css');

  it('takes its colours from the theme’s own ok, warning and danger tokens and invents none', () => {
    const base = read('client/styles.css');
    expect(base).toMatch(/\.usage-fill\.signal\s*\{[^}]*var\(--dm-signal\)/);
    expect(base).toMatch(/\.usage-fill\.fault\s*\{[^}]*var\(--dm-fault\)/);
    expect(base).toMatch(/\.usage-fill\s*\{[^}]*var\(--dm-glacier\)/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|lab)\(/);
  });

  it('stops moving under every way of asking for less motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/html\[data-motion='reduced'\]/);
    expect(css).toMatch(/html\[data-motion-preset='none'\]/);
    expect(css).toMatch(/transition:\s*none/);
  });
});

describe('opening the payment page from the shipped app', () => {
  it('the desktop shell lets a checkout address out, and only through the service’s own check', () => {
    const main = read('desktop/main.mjs');
    expect(main).toMatch(/allowsCheckoutReference\?\.\(destination\)/);
    const app = read('server/app.ts');
    expect(app).toMatch(/app\.locals\.allowsCheckoutReference\s*=\s*\(destination: string\)\s*=>/);
    expect(app).toMatch(/isAllowedCheckoutUrl\(destination,\s*accountSession\.localCheckoutOrigin\(\)\)/);
  });
});

// ---- a member's own usage (DIO-161 slice 3) -------------------------------------------------------------

type MineReady = Extract<MyCreditUsage, { state: 'ready' }>;
/** A member's own month: `used` credits against `limit` (null: no limit), `held` of the used still in flight. */
const mine = (used: number, limit: number | null, held = 0, raised = 0): MineReady => ({
  state: 'ready',
  organizationId: 'org_a',
  periodId: '2026-10',
  resetsAt: '2026-11-01T00:00:00.000Z',
  usage: { usedMicroUsd: c(used), includedMicroUsd: c(used), purchasedMicroUsd: c(0), heldMicroUsd: c(held) },
  limitMicroUsd: limit === null ? null : c(limit),
  raisedByMicroUsd: c(raised),
  requests: [],
});
const memberHtml = (answer: MyUsageRead) =>
  renderToStaticMarkup(createElement(MemberUsageView, { usage: answer, readAt: Date.parse(observedAt), now }));
const worldOf = (m: Membership | null, active: 'business' | 'personal' = 'business') =>
  ({
    active: active === 'business' ? { kind: 'business', organizationId: 'org_a' } : { kind: 'personal' },
    organizations: m ? [{ organization: { id: 'org_a', name: 'Juniper Street Bakery' }, membership: m }] : [],
  }) as unknown as WorkspaceView;

describe('who gets the member view', () => {
  it('an active member of the selected business does; an owner, an admin, an invitee, Personal and nobody do not', () => {
    expect(memberUsageTarget(worldOf(asRole('member')))).toEqual({ organizationId: 'org_a', membership: asRole('member') });
    expect(memberUsageTarget(worldOf(asRole('owner')))).toBeNull();
    expect(memberUsageTarget(worldOf(asRole('admin')))).toBeNull();
    expect(memberUsageTarget(worldOf(asRole('member', 'invited' as Membership['state'])))).toBeNull();
    expect(memberUsageTarget(worldOf(asRole('member', 'revoked' as Membership['state'])))).toBeNull();
    expect(memberUsageTarget(worldOf(asRole('member'), 'personal'))).toBeNull();
    expect(memberUsageTarget(worldOf(null))).toBeNull();
    expect(memberUsageTarget(null)).toBeNull();
  });

  it('the two views never overlap: whoever has the business screen has no member one', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const world = worldOf(asRole(role));
      expect(Boolean(usageCenterTarget(world)) !== Boolean(memberUsageTarget(world))).toBe(true);
    }
  });
});

describe('a member’s own usage bar', () => {
  it('says "120 of 300 credits used this month" with the same meter the business bar has', () => {
    const html = memberHtml(mine(120, 300));
    expect(text(html)).toContain('120 of 300 credits used this month');
    expect(html).toContain('role="meter"');
    expect(html).toContain('data-tone="ok"');
    expect(html).toMatch(/uc-fill[^>]*style="width:40%"/);
    expect(html).toContain('aria-valuemax="300"');
    expect(html).toContain('aria-valuenow="120"');
  });

  it('is the business bar itself, so the wording and the warning points can’t drift apart', () => {
    const state = memberUsageState(mine(120, 300), observedAt);
    expect(state.state).toBe('ready');
    expect(memberHtml(mine(120, 300))).toBe(renderToStaticMarkup(createElement(UsageCenterBar, { state, now })));
    expect(read('client/console/MemberUsage.tsx')).toMatch(/import\s*\{[^}]*UsageCenterBar[^}]*\}\s*from\s*'\.\/UsageCenter'/);
  });

  it.each([
    [USAGE_WARNING_PERCENT - 1, 'ok', null],
    [USAGE_WARNING_PERCENT, 'warning', 'Your monthly credits are running low.'],
    [USAGE_DANGER_PERCENT, 'danger', 'Your monthly credits are almost gone.'],
    [USAGE_EXHAUSTED_PERCENT, 'danger', 'Your monthly credits are used up.'],
  ] as const)('at %i percent of the member’s limit the bar is %s', (percent, tone, note) => {
    const html = memberHtml(mine(percent * 3, 300));
    expect(html).toContain(`data-tone="${tone}"`);
    expect(text(html)).toContain(`${percent * 3} of 300 credits used this month`);
    if (note) expect(text(html)).toContain(note);
    else expect(html).not.toContain('uc-note');
  });

  it('measures against the limit plus what an approval added to the month', () => {
    expect(text(memberHtml(mine(120, 300, 0, 100)))).toContain('120 of 400 credits used this month');
  });

  it('counts held credits as used against the limit, shows what settled, and says what is reserved', () => {
    const page = text(memberHtml(mine(150, 300, 30)));
    expect(page).toContain('120 of 300 credits used this month');
    expect(page).toContain('30 credits are reserved for work in flight.');
  });

  it('says when the month resets', () => {
    expect(text(memberHtml(mine(10, 300)))).toContain('Resets Nov 1, 2026, 00:00 UTC');
  });

  it('with no limit, says what was used and draws no bar and no fill', () => {
    const html = memberHtml(mine(120, null));
    expect(text(html)).toContain('120 credits used this month');
    expect(text(html)).not.toMatch(/ of \d/);
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain('usage-fill');
    expect(text(html)).toContain('Resets Nov 1, 2026, 00:00 UTC');
    expect(text(memberHtml(mine(1, null)))).toContain('1 credit used this month');
  });

  it('shows no business total, bought credits, pool, anyone else’s use, or way to buy', () => {
    for (const answer of [mine(120, 300), mine(120, null), mine(300, 300)]) {
      const html = memberHtml(answer);
      expect(html).not.toMatch(/<(form|input|button|a)[ >]/);
      expect(html).not.toContain('$');
      expect(text(html)).not.toMatch(/Credits you bought|Buy credits|Buy more|pool|business|your team|everyone/i);
    }
  });

  it('while the answer is coming, one plain line; and a read it can’t use says so with no numbers', () => {
    expect(text(memberHtml({ state: 'loading', organizationId: 'org_a' }))).toContain('Checking usage.');
    for (const answer of [
      { state: 'unavailable', organizationId: 'org_a', reason: 'Down. 3 of 9.' },
      { state: 'hidden', organizationId: 'org_a', reason: 'Off. 4 of 8.' },
    ] as MyUsageRead[]) {
      const html = memberHtml(answer);
      expect(text(html)).toContain('Usage isn’t available right now.');
      expect(text(html)).not.toMatch(/\d/);
      expect(html).not.toContain('role="meter"');
    }
  });

  it('a figure it can’t trust is not drawn', () => {
    const odd = { ...mine(1, 300), usage: { ...mine(1, 300).usage, usedMicroUsd: -5 } } as MineReady;
    expect(memberUsageState(odd, observedAt).state).toBe('unavailable');
  });

  it.each([
    ['limited', mine(120, 300)],
    ['warning', mine(240, 300)],
    ['used up', mine(300, 300)],
    ['unlimited', mine(120, null)],
    ['reserved', mine(150, 300, 30)],
  ] as const)('%s: no italics, dashes, exclamations, vendor or model names, markup talk or reassurance tails', (_name, answer) => {
    const html = memberHtml(answer);
    const page = text(html);
    expect(html).not.toMatch(/<(i|em)[ >]/);
    expect(html).not.toMatch(/font-style/);
    expect(page).not.toMatch(/[–—]/);
    expect(page).not.toContain('!');
    expect(page).not.toMatch(/Nothing was (charged|sent|held|changed)/);
    expect(page).not.toMatch(/stripe|claude|anthropic|openai|gpt|gemini|llama|mistral|deepseek|bedrock|vertex/i);
  });
});

describe('reading a member’s own usage', () => {
  const stub = (answer: unknown) => {
    const asked: string[] = [];
    return {
      asked,
      reader: async <T,>(path: string): Promise<T> => {
        asked.push(path);
        return answer as T;
      },
    };
  };

  it('asks the one route that answers for the signed-in person, for the selected business', async () => {
    const { asked, reader } = stub(mine(120, 300));
    expect(await loadMyUsage('org_a', reader)).toMatchObject({ state: 'ready', organizationId: 'org_a' });
    expect(asked).toEqual(['/workspace/organizations/org_a/credit-usage/mine']);
  });

  it('keeps a hidden answer as hidden, so the entry stays away', async () => {
    const { reader } = stub({ state: 'hidden', organizationId: 'org_a', reason: 'This business doesn’t show members their usage.' });
    expect(await loadMyUsage('org_a', reader)).toMatchObject({ state: 'hidden' });
  });

  it('an answer for another business is not used', async () => {
    const { reader } = stub(mine(1, 10));
    expect(await loadMyUsage('org_b', reader)).toMatchObject({ state: 'unavailable', organizationId: 'org_b' });
  });

  it('a refused or failed read is an unavailable one, never a zero', async () => {
    const failing = async <T,>(): Promise<T> => {
      throw new Error('refused');
    };
    expect(await loadMyUsage('org_a', failing)).toMatchObject({ state: 'unavailable', organizationId: 'org_a' });
    expect(await loadMyUsage('org_a', stub({ state: 'ready', organizationId: 'org_a' }).reader)).toMatchObject({ state: 'unavailable' });
    expect(await loadMyUsage('org_a', stub(null).reader)).toMatchObject({ state: 'unavailable' });
  });
});

describe('the Settings rail for a member', () => {
  const settings = read('client/Settings.tsx');

  it('offers Usage only once the member’s own read says ready, and never while it is off, refused or failed', () => {
    expect(settings).toMatch(/memberUsageTarget\(/);
    expect(settings).toMatch(/useMyCreditUsage\(/);
    expect(settings).toMatch(/\.state === 'ready'/);
    expect(settings).toMatch(/usageScreen \|\| memberUsage \|\| personalScreen \? \['Usage'\]/);
    expect(settings).toMatch(/section === 'Usage' && !usageScreen && memberUsage/);
  });

  it('leaves the business screen to owners and admins', () => {
    expect(settings).toMatch(/section === 'Usage' && usageScreen/);
    expect(read('client/console/UsageCenter.tsx')).toMatch(/if \(!canSeePurchasedCredits\(membership\)\) return null/);
  });
});

describe('the sentences on the Usage screen', () => {
  it('are not set in tabular figures, which widen the full stop and read as a stray space before it', () => {
    const css = read('client/console/usage-center.css');
    const rule = css.match(/\.uc-line\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toMatch(/tabular-nums/);
  });
});
