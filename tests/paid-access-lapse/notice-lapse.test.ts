import { afterEach, beforeEach, expect, test } from 'vitest';
import type { AccountStateView } from '../../shared/accounts.js';
import { reviewFixture, DEMO_ACCOUNTS } from './fixture.js';

let f: Awaited<ReturnType<typeof reviewFixture>>;
beforeEach(async () => { f = await reviewFixture(); });
afterEach(async () => { await f?.dispose(); });

test('the free notice returns after a subscription starts and lapses, as the branch promises', async () => {
  const initial = await f.signIn(DEMO_ACCOUNTS.harborOwner.email, true);
  const organizationId = initial.workspaces[0]!.organization.id;
  expect(initial.plan.agent).toBe('free');
  await f.api('/account/plan-notice', 'POST', { choice: 'never' });
  const billing = await f.staff();
  await f.cloud.commercial.issueGrant(billing, organizationId, { planId: null, features: ['nectovia-agent'],
    source: 'internal-test', reference: 'review-notice-lapse', note: 'Synthetic review only',
    validUntil: new Date(Date.now() + 86_400_000).toISOString() });
  expect((await f.api<AccountStateView>('/account/refresh', 'POST', {})).plan.agent).toBe('paid');
  await f.revoke(organizationId);
  const lapsed = await f.api<AccountStateView>('/account/refresh', 'POST', {});
  expect(lapsed.plan.agent).toBe('free');
  expect(lapsed.plan.notice).toBe(true);
  await f.restart();
  expect((await f.api<AccountStateView>('/account')).plan.notice).toBe(true);
});
