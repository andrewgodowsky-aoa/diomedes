/**
 * What a member and an owner or admin see when a member's own monthly credit limit holds a message back
 * (Andrew, 2026-10-01): the stop dialog in the Console, the one line after asking, and the panel where an
 * owner or admin answers. Every figure and person here is invented. Credits, never dollars.
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client/api';
import {
  MEMBER_LIMIT_ASKED,
  isMemberLimitStop,
  memberLimitPrompt,
  settleMemberLimitStop,
  type MemberLimitChoice,
  type MemberLimitPrompt,
} from '../client/job-cap-gate';
import {
  CreditAsksView,
  canSeeCreditAsks,
  decideCreditAsk,
  loadCreditAsks,
  type CreditAsk,
} from '../client/console/CreditAsks';
import { MemberLimitStop } from '../client/console/MemberLimitStop';
import { askRequestId } from '../server/credit-ask-routes';
import { MEMBER_LIMIT_REACHED } from '../shared/credit-allotments';
import { creditAmount } from '../shared/managed-usage';
import type { Membership } from '../shared/workspaces';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const SAID = 'This step needs up to 2 credits, and you’ve used 9 of the 10 set for you this month. An owner or admin can approve more.';
const member = (role: Membership['role'], state: Membership['state'] = 'active') =>
  ({ id: 'm_1', organizationId: 'org_a', personId: 'p_1', role, state }) as unknown as Membership;
const plainWords = (value: string) => {
  expect(value).not.toMatch(/[–—$]/);
  expect(value).not.toMatch(/dollar/i);
  expect(value).not.toMatch(/nothing was/i);
};

describe('the stop dialog', () => {
  const prompt = memberLimitPrompt(SAID);
  const html = renderToStaticMarkup(
    createElement(MemberLimitStop, { prompt, inline: true, onAskJob: () => {}, onAskMonth: () => {}, onCancel: () => {} }),
  );

  it('is an alert dialog that says what the service said and offers the two asks and Cancel', () => {
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-describedby');
    const page = text(html);
    expect(page).toContain(prompt.title);
    expect(page).toContain(SAID);
    for (const label of ['Cancel', prompt.job, prompt.month]) expect(page).toContain(label);
  });

  it('adds no figure, dash or dollar of its own', () => {
    for (const own of [prompt.title, prompt.job, prompt.month]) {
      expect(own).not.toMatch(/\d/);
      plainWords(own);
    }
  });

  it('is what the Console shows when a send comes back as the member-limit stop', () => {
    // The Home conversation catches exactly this refusal and shows this dialog; nothing else opens it.
    expect(isMemberLimitStop(new ApiError(SAID, 402, { code: MEMBER_LIMIT_REACHED }))).toBe(true);
    const home = readFileSync('client/console/DiomedesHome.tsx', 'utf8');
    expect(home).toMatch(/isMemberLimitStop\(error\)/);
    expect(home).toMatch(/<MemberLimitStop/);
    expect(home).toMatch(/settleMemberLimitStop\(/);
  });
});

describe('asking from the stop', () => {
  const stop = { projectId: 'proj-1', commandId: 'cmd-1', message: SAID };
  const choosing = (choice: MemberLimitChoice) => {
    const shown: MemberLimitPrompt[] = [];
    return { shown, ask: async (next: MemberLimitPrompt) => (shown.push(next), choice) };
  };

  it('shows the dialog with the service’s words, and sends one ask for the kind chosen', async () => {
    for (const kind of ['job', 'month'] as const) {
      const person = choosing(kind);
      const send = vi.fn(async () => ({ requestId: 'r', state: 'pending' }));
      const line = await settleMemberLimitStop(stop, { ask: person.ask, send });
      expect(person.shown).toHaveLength(1);
      expect(person.shown[0].body).toBe(SAID);
      expect(send).toHaveBeenCalledExactlyOnceWith('proj-1', 'cmd-1', kind);
      expect(line).toBe(MEMBER_LIMIT_ASKED);
    }
  });

  it('says one plain line once asked, and the words of the stop when the person cancels', async () => {
    plainWords(MEMBER_LIMIT_ASKED);
    expect(MEMBER_LIMIT_ASKED).toBe('Asked. An owner or admin will see it under Change workspace.');
    const send = vi.fn(async () => undefined);
    expect(await settleMemberLimitStop(stop, { ask: choosing('cancel').ask, send })).toBe(SAID);
    expect(send).not.toHaveBeenCalled();
  });

  it('says why in the host’s own words when the ask is refused', async () => {
    const send = vi.fn(async () => {
      throw new ApiError('That message wasn’t found, so the ask can’t name its job. Ask for the month instead.', 404, { code: 'unknown_message' });
    });
    expect(await settleMemberLimitStop(stop, { ask: choosing('job').ask, send })).toMatch(/Ask for the month instead\.$/);
  });

  it('makes one request id for one ask, so a second press is the same ask', () => {
    expect(askRequestId('proj-1', 'cmd-1', 'job')).toBe(askRequestId('proj-1', 'cmd-1', 'job'));
    const ids = new Set([
      askRequestId('proj-1', 'cmd-1', 'job'),
      askRequestId('proj-1', 'cmd-1', 'month'),
      askRequestId('proj-1', 'cmd-2', 'job'),
      askRequestId('proj-2', 'cmd-1', 'job'),
    ]);
    expect(ids.size).toBe(4);
    expect(askRequestId('proj-1', 'cmd-1', 'job')).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });
});

describe('the panel where an owner or admin answers', () => {
  const ask = (over: Partial<CreditAsk>): CreditAsk => ({
    requestId: 'ask_1', personId: 'p_member', kind: 'job', jobId: 'job-1', state: 'pending', requestedAt: '2026-10-01T12:00:00.000Z', ...over,
  });

  it('is for an owner and an admin; a member makes no request at all, and an owner makes exactly one', async () => {
    expect(canSeeCreditAsks(member('owner'))).toBe(true);
    expect(canSeeCreditAsks(member('admin'))).toBe(true);
    expect(canSeeCreditAsks(member('member'))).toBe(false);
    expect(canSeeCreditAsks(null)).toBe(false);
    const asked: string[] = [];
    const read = async (path: string) => {
      asked.push(path);
      return { requests: [ask({}), ask({ requestId: 'ask_2', state: 'approved' }), ask({ requestId: 'ask_3', state: 'denied' })] };
    };
    expect(await loadCreditAsks('org_a', member('member'), read as never)).toBeNull();
    expect(asked).toEqual([]);
    const pending = await loadCreditAsks('org_a', member('admin'), read as never);
    expect(asked).toEqual(['/workspace/organizations/org_a/credit-limit-requests']);
    expect(pending?.map((row) => row.requestId)).toEqual(['ask_1']);
  });

  it('lists each pending ask with Approve and Decline, by role and never by name', () => {
    const html = renderToStaticMarkup(
      createElement(CreditAsksView, {
        asks: [ask({}), ask({ requestId: 'ask_m', personId: 'p_admin', kind: 'month', jobId: null })],
        roles: { p_member: 'member', p_admin: 'admin' },
        onDecide: () => {},
      }),
    );
    const page = text(html);
    expect(page).toContain('Asks for more credits');
    expect(page).toContain('A member asked for more on one job.');
    expect(page).toContain('An admin asked for more this month.');
    expect(page.match(/Approve/g)).toHaveLength(2);
    expect(page.match(/Decline/g)).toHaveLength(2);
    // Only the month's ask names an amount to add, and that is the approver's own to fill in.
    expect(page.match(/Credits to add/g)).toHaveLength(1);
    plainWords(page);
  });

  it('says so plainly when no one is waiting', () => {
    const page = text(renderToStaticMarkup(createElement(CreditAsksView, { asks: [], roles: {}, onDecide: () => {} })));
    expect(page).toContain("No credit requests.");
    plainWords(page);
  });

  it('answers a job as it stands, a month with the credits the approver chose, and a decline with no figure', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const send = (async (path: string, _method: 'POST', body: unknown) => {
      sent.push({ path, body });
      return {};
    }) as never;
    await decideCreditAsk('org_a', 'ask_1', { approve: true }, send);
    await decideCreditAsk('org_a', 'ask_m', { approve: true, credits: 5, allowPurchased: true }, send);
    await decideCreditAsk('org_a', 'ask_n', { approve: false }, send);
    expect(sent).toEqual([
      { path: '/workspace/organizations/org_a/credit-limit-requests/ask_1/decision', body: { approve: true } },
      { path: '/workspace/organizations/org_a/credit-limit-requests/ask_m/decision', body: { approve: true, extraMicroUsd: creditAmount(5), allowPurchased: true } },
      { path: '/workspace/organizations/org_a/credit-limit-requests/ask_n/decision', body: { approve: false } },
    ]);
  });
});
