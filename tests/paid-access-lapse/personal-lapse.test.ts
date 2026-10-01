import { afterEach, beforeEach, expect, test } from 'vitest';
import type { AccountStateView } from '../../shared/accounts.js';
import { reviewFixture, DEMO_ACCOUNTS } from './fixture.js';

let f: Awaited<ReturnType<typeof reviewFixture>>;
beforeEach(async () => { f = await reviewFixture(); });
afterEach(async () => { await f?.dispose(); });

const email = DEMO_ACCOUNTS.free.email;

async function personalThread() {
  const binding = await f.home();
  await f.ownEngine(binding);
  await f.aws(binding);
  return binding;
}

test('a person whose Individual plan is withdrawn reads as free after the refusal, with no manual refresh', async () => {
  await f.grantIndividual(email);
  await f.signIn(email);
  const binding = await personalThread();
  expect((await f.say(binding, 'before-revoke')).status).toBe(200);
  expect((await f.api<AccountStateView>('/account')).plan.agent).toBe('paid');
  await f.revokeIndividual(email);
  const denied = await f.say(binding, 'after-revoke');
  expect(denied.status, await denied.clone().text()).toBe(403);
  const plan = (await f.api<AccountStateView>('/account')).plan;
  expect(plan.agent).toBe('free');
  expect(plan.notice).toBe(true);
});

test('after a re-grant the next Personal message is admitted and the plan reads paid again', async () => {
  await f.grantIndividual(email);
  await f.signIn(email);
  const binding = await personalThread();
  expect((await f.say(binding, 'before-revoke')).status).toBe(200);
  await f.revokeIndividual(email);
  expect((await f.say(binding, 'refused')).status).toBe(403);
  expect((await f.api<AccountStateView>('/account')).plan.agent).toBe('free');
  await f.grantIndividual(email);
  const admitted = await f.say(binding, 'after-regrant');
  expect(admitted.status, await admitted.clone().text()).toBe(200);
  expect((await f.api<AccountStateView>('/account')).plan.agent).toBe('paid');
});

test('the free-plan notice comes back after a lapse and is cleared again by a re-grant', async () => {
  await f.grantIndividual(email);
  await f.signIn(email);
  const binding = await personalThread();
  expect((await f.say(binding, 'before-revoke')).status).toBe(200);
  await f.revokeIndividual(email);
  expect((await f.say(binding, 'refused')).status).toBe(403);
  await f.api('/account/plan-notice', 'POST', { choice: 'never' });
  expect((await f.api<AccountStateView>('/account')).plan.notice).toBe(false);
  await f.grantIndividual(email);
  expect((await f.say(binding, 'after-regrant')).status).toBe(200);
  // Paid cleared the answer, so a later lapse shows the notice again.
  await f.revokeIndividual(email);
  expect((await f.say(binding, 'refused-again')).status).toBe(403);
  expect((await f.api<AccountStateView>('/account')).plan.notice).toBe(true);
});

test('an unreadable access read after a refusal is not a downgrade', async () => {
  await f.grantIndividual(email);
  await f.signIn(email);
  const binding = await personalThread();
  expect((await f.say(binding, 'before-revoke')).status).toBe(200);
  await f.revokeIndividual(email);
  f.accessUnavailable(true);
  await f.say(binding, 'unreadable');
  f.accessUnavailable(false);
  expect((await f.api<AccountStateView>('/account')).plan.agent).not.toBe('free');
});

test('a business workspace still needs Business, an Individual plan never covers it', async () => {
  const account = await f.signIn(DEMO_ACCOUNTS.harborOwner.email);
  await f.grantIndividual(DEMO_ACCOUNTS.harborOwner.email);
  const organizationId = account.workspaces[0]!.organization.id;
  const binding = await f.home();
  await f.ownEngine(binding);
  await f.aws(binding);
  await f.api(`/workspace/organizations/${organizationId}/output`, 'POST', { projectId: binding.projectId });
  const denied = await f.say(binding, 'business-work');
  expect(denied.status, await denied.clone().text()).toBe(403);
  expect(f.calls.model).toBe(0);
});
