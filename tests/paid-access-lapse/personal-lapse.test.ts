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

test('a confirmed Personal lapse opens only the remaining bought credits and keeps the plan free', async () => {
  await f.grantIndividual(email);
  await f.signIn(email);
  const session = f.session(), bearer = await session.token();
  const checkout = await session.backend.client.startPersonalCreditPurchase(bearer, 110);
  await f.cloud.completeCheckout(new URL(checkout.checkoutUrl).pathname.split('/').pop()!);
  await f.revokeIndividual(email);
  await session.confirmPersonalDowngrade('entitlement_revoked');
  expect(session.state().plan).toMatchObject({ agent: 'free', payAsYouGo: true });
  expect(session.personalIncludes('nectovia-agent')).toBe(false);
});

test('a confirmed re-grant keeps the paid plan independent from the bought-credit path', async () => {
  await f.signIn(email);
  const session = f.session(), bearer = await session.token();
  const checkout = await session.backend.client.startPersonalCreditPurchase(bearer, 100);
  await f.cloud.completeCheckout(new URL(checkout.checkoutUrl).pathname.split('/').pop()!);
  await session.reload({ project: false });
  expect(session.state().plan).toMatchObject({ agent: 'free', payAsYouGo: true });
  await f.grantIndividual(email);
  await session.confirmPersonalAdmitted();
  expect(session.state().plan.agent).toBe('paid');
  expect(session.state().plan.payAsYouGo).toBeUndefined();
});

test('an older active Personal reread cannot replace a newer confirmed revocation', async () => {
  await f.signIn(email);
  await f.grantIndividual(email);
  const session = f.session(), held = f.holdNextPersonAccess();
  const older = session.confirmPersonalAdmitted();
  await held.captured;
  await f.revokeIndividual(email);
  await session.confirmPersonalDowngrade('entitlement_revoked');
  expect(session.state().plan.agent).toBe('free');
  held.release();
  await older;
  expect(session.state().plan.agent).toBe('free');
  expect(session.personalIncludes()).toBe(false);
});

test('an older unpaid Personal reread cannot replace a newer confirmed re-grant', async () => {
  await f.signIn(email);
  const session = f.session(), held = f.holdNextPersonAccess();
  const older = session.confirmPersonalDowngrade('entitlement_none');
  await held.captured;
  await f.grantIndividual(email);
  await session.confirmPersonalAdmitted();
  expect(session.state().plan.agent).toBe('paid');
  held.release();
  await older;
  expect(session.state().plan.agent).toBe('paid');
});

test('an older general reload cannot replace a newer confirmed Personal revocation', async () => {
  await f.signIn(email);
  await f.grantIndividual(email);
  const session = f.session(), held = f.holdNextPersonAccess();
  const older = session.reload({ project: false });
  await held.captured;
  await f.revokeIndividual(email);
  await session.confirmPersonalDowngrade('entitlement_revoked');
  expect(session.state().plan.agent).toBe('free');
  held.release();
  await older;
  expect(session.state().plan.agent).toBe('free');
  expect(session.personalIncludes()).toBe(false);
});
