import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AccountStateView } from '../../shared/accounts.js';
import { reviewFixture, DEMO_ACCOUNTS } from './fixture.js';

let f: Awaited<ReturnType<typeof reviewFixture>>;
beforeEach(async () => { f = await reviewFixture(); });
afterEach(async () => { await f?.dispose(); });

describe('independent free harness and paid Agent boundaries at 05ef1b0', () => {
  test('a free default conversation dispatches to the real direct-engine session driver', async () => {
    await f.signIn(DEMO_ACCOUNTS.free.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    const response = await f.say(binding, 'free-direct');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ answerText: 'Direct engine answer' });
    expect(f.calls.direct).toBe(1);
    expect(f.calls.model).toBe(0);
    expect(f.calls.account.filter((call) => call.includes('agent-admissions'))).toEqual([]);
    expect((await f.thread(binding)).engine).toBe('nectovia');
  });

  test('choosing the Agent explicitly refuses instead of silently using the free engine', async () => {
    await f.signIn(DEMO_ACCOUNTS.free.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    await f.api(`/projects/${binding.projectId}/threads/${binding.threadId}`, 'PUT', { engine: 'nectovia' });
    const response = await f.say(binding, 'free-explicit');
    expect(response.status).toBe(403);
    const body = await response.json() as { error: string; code: string };
    expect(body.code).toBe('AGENT_NOT_INCLUDED');
    expect(body.error.match(/Nothing was sent\./g)).toHaveLength(1);
    expect(body.error).toContain('free version');
    expect(body.error).not.toMatch(/business|install|switch/i);
    expect(f.calls.direct + f.calls.model).toBe(0);
  });

  test('a working model key and a saved notice answer do not unlock Agent work', async () => {
    await f.signIn(DEMO_ACCOUNTS.free.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    await f.aws(binding);
    await f.api('/account/plan-notice', 'POST', { choice: 'never' });
    const response = await f.say(binding, 'free-own-key');
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'AGENT_NOT_INCLUDED' });
    expect(f.calls.direct + f.calls.model).toBe(0);
  });

  test('a paid business member keeps their direct engine in Personal without a business payer', async () => {
    await f.signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    const response = await f.say(binding, 'paid-personal-direct');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(f.calls.direct).toBe(1);
    expect(f.calls.model).toBe(0);
  });

  test('a paid business does not pay for an unlinked personal model-API thread', async () => {
    await f.signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    await f.aws(binding);
    const response = await f.say(binding, 'paid-personal-api');
    expect(response.status).toBe(403);
    expect(f.calls.model).toBe(0);
  });

  test('two stale callers cannot start Agent work after the business grant is revoked', async () => {
    const account = await f.signIn(DEMO_ACCOUNTS.owner.email);
    const org = account.workspaces[0]!.organization.id;
    const binding = await f.home();
    await f.ownEngine(binding);
    await f.aws(binding);
    await f.api(`/workspace/organizations/${org}/output`, 'POST', { projectId: binding.projectId });
    const paid = await f.say(binding, 'paid-before-downgrade');
    expect(paid.status, await paid.clone().text()).toBe(200);
    const before = f.calls.model;
    await f.revoke(org);
    // Both requests use the old host session. Neither refreshes the account view.
    for (const command of ['stale-window-a', 'stale-window-b']) {
      const denied = await f.say(binding, command);
      expect(denied.status, await denied.clone().text()).toBe(403);
    }
    expect(f.calls.model).toBe(before);
    expect((await f.thread(binding)).turns.some((turn) => turn.text === 'Agent answer')).toBe(true);
  });

  // e730317 routed the gate through AccountRoutingSession (07dc5ba), whose admit() re-reads access first: an unreachable service now answers 503 unreachable, not 403 AGENT_NOT_INCLUDED.
  test('cached paid access cannot start new Agent work while the account service is offline', async () => {
    const account = await f.signIn(DEMO_ACCOUNTS.owner.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    await f.aws(binding);
    await f.api(`/workspace/organizations/${account.workspaces[0]!.organization.id}/output`, 'POST', { projectId: binding.projectId });
    f.offline(true);
    const response = await f.say(binding, 'offline-new-job');
    expect(response.status, await response.clone().text()).toBe(503);
    const body = await response.json() as { error: string; code: string };
    expect(body.code).toBe('unreachable');
    // The true reason: the service could not be reached. It is not a refusal of the plan.
    expect(body.error).toContain('could not be reached');
    expect(body.error).not.toMatch(/not included|free version|business/i);
    expect(f.calls.model).toBe(0);
    expect(f.calls.direct).toBe(0);
    expect(f.calls.account.filter((call) => call.startsWith('POST') && /([/]admit|agent-admissions)$/.test(call))).toEqual([]);
  });

  test('the free direct-engine session still works when the account service goes offline', async () => {
    await f.signIn(DEMO_ACCOUNTS.free.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    f.offline(true);
    const response = await f.say(binding, 'offline-direct');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(f.calls.direct).toBe(1);
    expect(f.calls.model).toBe(0);
  });

  test('a restored free project and notice preference preserve only direct-engine access', async () => {
    await f.signIn(DEMO_ACCOUNTS.free.email, true);
    const binding = await f.home();
    await f.ownEngine(binding);
    await f.api('/account/plan-notice', 'POST', { choice: 'never' });
    expect((await f.say(binding, 'before-restart')).status).toBe(200);
    await f.restart();
    expect((await f.api<AccountStateView>('/account')).plan).toMatchObject({ agent: 'free', notice: false });
    const response = await f.say(binding, 'after-restart');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(f.calls.direct).toBe(2);
    expect(f.calls.model).toBe(0);
    expect((await f.thread(binding)).turns.filter((turn) => turn.text === 'Direct engine answer')).toHaveLength(2);
  });

  test('sign-out invalidates another caller even when it retained the old thread', async () => {
    await f.signIn(DEMO_ACCOUNTS.free.email);
    const binding = await f.home();
    await f.ownEngine(binding);
    await f.api('/account/sign-out', 'POST');
    expect((await f.say(binding, 'old-window')).status).toBe(401);
    expect((await f.request('/account/plan-notice', 'POST', { choice: 'never' })).status).toBe(401);
    expect(f.calls.direct + f.calls.model).toBe(0);
  });

  test('offline startup refuses saved sign-in authority until the account service can resume it', async () => {
    await f.signIn(DEMO_ACCOUNTS.free.email, true);
    const binding = await f.home();
    await f.ownEngine(binding);
    f.offline(true);
    await f.restart();
    const account = await f.api<AccountStateView>('/account');
    expect(account.signedIn).toBe(false);
    expect((await f.say(binding, 'offline-startup')).status).toBe(401);
    expect(f.calls.direct + f.calls.model).toBe(0);
  });

});
