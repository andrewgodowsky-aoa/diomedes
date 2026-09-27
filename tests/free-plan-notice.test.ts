import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountPlanNotice, FreePlanNotice, PlansLink } from '../client/console/FreePlanNotice.js';
import { FREE_ABILITIES, PAID_ABILITIES, PLANS_URL } from '../shared/access.js';
import type { AccountPlanView } from '../shared/accounts.js';

const plan: AccountPlanView = { agent: 'free', plansUrl: PLANS_URL, notice: true };
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');

describe('the free-version notice', () => {
  it('says the person is on the free version and lists what is free and what a plan adds', () => {
    const html = renderToStaticMarkup(createElement(FreePlanNotice, { plan, onChoice: () => undefined }));
    expect(html).toContain(escape("You're on the free version"));
    expect(html).toContain('The Nectovia Agent is part of a paid plan.');
    for (const item of [...FREE_ABILITIES, ...PAID_ABILITIES]) expect(html).toContain(escape(item));
  });

  it('offers the three choices, with sign-up opening the plans page outside the app', () => {
    const html = renderToStaticMarkup(createElement(FreePlanNotice, { plan, onChoice: () => undefined }));
    expect(html).toContain(`href="${PLANS_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Sign up for a plan');
    expect(html).toContain('Remind me later');
    expect(html).toContain(escape("Don't remind me again"));
  });

  it('keeps the choices and says why when a choice was not saved', () => {
    const html = renderToStaticMarkup(
      createElement(FreePlanNotice, { plan, busy: true, error: 'The account service could not be reached.', onChoice: () => undefined }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('The account service could not be reached.');
    expect(html).toContain('aria-disabled="true"');
  });

  it('shows nothing without an account (accounts off)', () => {
    expect(renderToStaticMarkup(createElement(AccountPlanNotice))).toBe('');
  });

  it('opens whatever address the host names', () => {
    const html = renderToStaticMarkup(
      createElement(PlansLink, { plan: { ...plan, plansUrl: 'https://example.test/checkout' } }, 'See plans'),
    );
    expect(html).toContain('href="https://example.test/checkout"');
    expect(html).toContain('See plans');
  });
});
