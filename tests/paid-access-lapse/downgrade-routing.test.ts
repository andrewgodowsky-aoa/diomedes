import { afterEach, beforeEach, expect, test } from 'vitest';
import type { AccountStateView } from '../../shared/accounts.js';
import { reviewFixture, DEMO_ACCOUNTS } from './fixture.js';

let f: Awaited<ReturnType<typeof reviewFixture>>;
beforeEach(async () => { f = await reviewFixture(); });
afterEach(async () => { await f?.dispose(); });

test('a known downgrade releases a default thread to the free engine without manual account refresh', async () => {
  const account = await f.signIn(DEMO_ACCOUNTS.owner.email);
  const organizationId = account.workspaces[0]!.organization.id;
  const binding = await f.home();
  await f.ownEngine(binding);
  await f.api(`/workspace/organizations/${organizationId}/output`, 'POST', { projectId: binding.projectId });
  expect((await f.thread(binding)).engine).toBe('nectovia');
  await f.revoke(organizationId);
  const denied = await f.say(binding, 'learn-downgrade');
  expect(denied.status, await denied.clone().text()).toBe(403);
  expect(f.calls.direct + f.calls.model).toBe(0);
  // The service has just refused this exact business; repeated GETs and another window still
  // read the stale paid cache. The person cannot use the new free fallback on this thread.
  const accountAfter = await f.api<AccountStateView>('/account');
  const routeAfter = await f.api<{ route: string }>(`/projects/${binding.projectId}/threads/${binding.threadId}/work-style`);
  expect(accountAfter.plan.agent).toBe('free');
  expect(routeAfter.route).toBe('claude-code');
  // Control: a manual account refresh makes the already configured free engine usable.
  await f.api('/account/refresh', 'POST', {});
  const retried = await f.say(binding, 'after-manual-refresh');
  expect(retried.status, await retried.clone().text()).toBe(200);
  expect(f.calls.direct).toBe(1);
});

test('after a revoke and a re-grant the next admitted message reads the business as paid again without a manual refresh', async () => {
  const account = await f.signIn(DEMO_ACCOUNTS.owner.email);
  const organizationId = account.workspaces[0]!.organization.id;
  const binding = await f.home();
  await f.ownEngine(binding);
  await f.aws(binding);
  await f.api(`/workspace/organizations/${organizationId}/output`, 'POST', { projectId: binding.projectId });
  expect((await f.say(binding, 'before-revoke')).status).toBe(200);
  await f.revoke(organizationId);
  expect((await f.say(binding, 'refused')).status).toBe(403);
  expect((await f.api<AccountStateView>('/account')).plan.agent).toBe('free');
  await f.regrant(organizationId);
  const admitted = await f.say(binding, 'after-regrant');
  expect(admitted.status, await admitted.clone().text()).toBe(200);
  expect((await f.api<AccountStateView>('/account')).plan.agent).toBe('paid');
});
