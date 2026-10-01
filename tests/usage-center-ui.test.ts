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
  UsageCenter,
  UsageCenterBar,
  UsageCenterView,
  usageCenterTarget,
  usageMeterText,
} from '../client/console/UsageCenter';
import type { FlowState } from '../client/console/credit-purchase-flow';

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
const idle: FlowState = { input: '1000', quote: { state: 'ready', credits: 1000, amountCents: 12000 }, purchase: { phase: 'idle' } };
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

  it('shows whatever total the quote gave, because the client never works one out', () => {
    const page = text(buyView({ ...idle, quote: { state: 'ready', credits: 1000, amountCents: 999 } }));
    expect(page).toContain('1,000 credits for $9.99 at the current usage rate');
    expect(page).not.toContain('$120');
  });

  it('holds Buy until there is a total, and says why in plain words', () => {
    const loading = buyView({ ...idle, quote: { state: 'loading' } });
    expect(loading).toMatch(/<button[^>]*disabled[^>]*>Buy<\/button>/);
    expect(text(loading)).toContain('Working out the total.');
    expect(text(loading)).not.toContain('$');

    const invalid = buyView({ input: '150', quote: { state: 'invalid', message: 'Enter 100 credits or more, in steps of 100, up to 100,000.' }, purchase: { phase: 'idle' } });
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

describe('what customers read here', () => {
  const states: [string, string][] = [
    ['bar ok', bar(ready(100))],
    ['bar warning', bar(ready(800))],
    ['bar danger', bar(ready(950))],
    ['bar out', bar(ready(1000))],
    ['bar loading', bar({ state: 'loading', organizationId: 'org_a' })],
    ['bar not connected', bar({ state: 'not-connected', organizationId: 'org_a', reason: 'r' })],
    ['whole screen', whole(ready(800), bought)],
    ['buy idle', buyView(idle)],
    ['buy loading', buyView({ ...idle, quote: { state: 'loading' } })],
    ['buy invalid', buyView({ input: '1', quote: { state: 'invalid', message: 'Enter 100 credits or more, in steps of 100, up to 100,000.' }, purchase: { phase: 'idle' } })],
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
      const priced = ['buy idle', 'buy paid', 'whole screen'].includes(name);
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
