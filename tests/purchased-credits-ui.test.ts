/**
 * The credits a business bought outright, in the Workspaces allowance panel.
 *
 * Only an owner or an admin sees the section; for anyone else it draws nothing and the read is
 * never made. Amounts are credits, never dollars. A service that can't answer shows no numbers at
 * all, so a missing balance never reads as zero. Every figure here is invented.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { creditAmount, type PurchasedUsageState } from '../shared/managed-usage';
import type { Membership } from '../shared/workspaces';
import {
  PurchasedCreditsView,
  canSeePurchasedCredits,
  loadPurchasedUsage,
} from '../client/console/PurchasedCredits';

const c = (credits: number) => creditAmount(credits);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const member = (role: Membership['role'], state: Membership['state'] = 'active') =>
  ({ id: 'm_1', organizationId: 'org_a', personId: 'p_1', role, state }) as unknown as Membership;

const ready: PurchasedUsageState = {
  state: 'ready',
  organizationId: 'org_a',
  balance: {
    purchasedMicroUsd: c(1000),
    heldMicroUsd: c(40),
    settledMicroUsd: c(250),
    availableMicroUsd: c(710),
  },
};
const render = (state: PurchasedUsageState) => renderToStaticMarkup(createElement(PurchasedCreditsView, { state }));

describe('who sees the credits a business bought', () => {
  it('an owner and an admin do; a member, a pending invitee and nobody do not', () => {
    expect(canSeePurchasedCredits(member('owner'))).toBe(true);
    expect(canSeePurchasedCredits(member('admin'))).toBe(true);
    expect(canSeePurchasedCredits(member('member'))).toBe(false);
    expect(canSeePurchasedCredits(member('admin', 'invited' as Membership['state']))).toBe(false);
    expect(canSeePurchasedCredits(null)).toBe(false);
  });

  it('a member makes no request at all, and an owner makes exactly one', async () => {
    const asked: string[] = [];
    const read = async (path: string) => {
      asked.push(path);
      return ready;
    };
    expect(await loadPurchasedUsage('org_a', member('member'), read as never)).toBeNull();
    expect(asked).toEqual([]);
    expect(await loadPurchasedUsage('org_a', member('owner'), read as never)).toEqual(ready);
    expect(asked).toEqual(['/workspace/organizations/org_a/allowance/purchased']);
  });
});

describe('the credits you bought', () => {
  it('shows bought, reserved, used and available as credits', () => {
    const page = text(render(ready));
    expect(page).toContain('Credits you bought');
    expect(page).toContain('Bought 1,000 credits');
    expect(page).toContain('Reserved for work in flight 40 credits');
    expect(page).toContain('Used 250 credits');
    expect(page).toContain('Available 710 credits');
    expect(page).toMatch(/included monthly usage isn’t part of this/i);
  });

  it('an overdrawn balance shows Available as 0 credits and keeps the true figures', () => {
    const page = text(
      render({
        state: 'ready',
        organizationId: 'org_a',
        balance: {
          purchasedMicroUsd: c(100),
          heldMicroUsd: c(70),
          settledMicroUsd: c(70),
          availableMicroUsd: -c(40),
        },
      }),
    );
    expect(page).toContain('Bought 100 credits');
    expect(page).toContain('Reserved for work in flight 70 credits');
    expect(page).toContain('Used 70 credits');
    expect(page).toContain('Available 0 credits');
    expect(page).not.toMatch(/-\d/);
  });

  it('never shows a dollar sign or a dollar conversion', () => {
    expect(render(ready)).not.toMatch(/\$|USD|dollar/i);
  });

  it('uses no italics and no em or en dashes', () => {
    const html = render(ready);
    expect(html).not.toMatch(/<(i|em)[ >]/);
    expect(html).not.toMatch(/[–—]/);
  });

  it.each(['unavailable', 'not-connected'] as const)('%s says so plainly and shows no numbers', (state) => {
    const html = render({ state, organizationId: 'org_a', reason: 'The account service couldn’t say what this business has bought, so nothing is shown.' });
    const page = text(html);
    expect(page).toContain('Credits you bought');
    expect(page).toContain('nothing is shown');
    expect(page).not.toMatch(/\d/);
    expect(html).not.toContain('<dl');
  });
});
