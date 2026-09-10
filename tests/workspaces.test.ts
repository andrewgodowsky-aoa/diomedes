/**
 * Personal, Business and the intake, proven through the real HTTP surface.
 *
 * The claims under test are the ones the product contract calls its initial
 * proof: Personal never receives the company questions, an owner runs the
 * intake once, an invited member does not redo it, two businesses stay apart,
 * revoked membership and a stale draft are refused, and a legacy "business"
 * onboarding preference grants nothing.
 *
 * A second person is simulated by restarting the host with a different
 * `workspaces/identity.json`. That file is the labelled development fixture
 * this build uses in place of an identity service; swapping it exercises the
 * membership rules without pretending anyone was authenticated.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { BusinessSetupView } from '../shared/business-setup.js';
import type { Person, WorkspaceView } from '../shared/workspaces.js';
import type { Settings } from '../shared/types.js';

let server: Server | undefined;
let root = '';
let url = '';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

async function launch() {
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function stop() {
  if (!server) return;
  const current = server;
  server = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

const identityPath = () => path.join(root, 'data', 'workspaces', 'identity.json');
/** The person the install generated for itself, kept so a test can come back as them. */
let firstPerson: Person | null = null;

async function writeIdentity(person: Person) {
  await fs.writeFile(identityPath(), JSON.stringify(person, null, 2), 'utf8');
}

/** Restart the host as a different local person against the same registry. */
async function restartAs(name: string) {
  await stop();
  const current = JSON.parse(await fs.readFile(identityPath(), 'utf8')) as Person;
  firstPerson ??= current;
  await writeIdentity({ ...current, id: `person_${name}`, name });
  await launch();
}

/** Come back as the person this install started as. */
async function restartAsFirstPerson() {
  await stop();
  if (firstPerson) await writeIdentity(firstPerson);
  await launch();
}

/** Restart the host as whoever it was, picking up files written underneath it. */
async function restart() {
  await stop();
  await launch();
}

/** The refusal code, whichever shape the error middleware wrapped it in. */
const errorCode = (data: unknown): string | undefined => {
  const value = data as { error?: { code?: string }; code?: string } | null;
  return value?.error?.code ?? value?.code;
};

const workspace = () => request<WorkspaceView>('/workspace').then((r) => r.data);
const createBusiness = (name: string, industry: string | null = null) =>
  request<WorkspaceView>('/workspace/organizations', 'POST', { name, industry });
const setupOf = (organizationId: string) =>
  request<BusinessSetupView>(`/workspace/organizations/${organizationId}/setup`);
const answerOne = (
  organizationId: string,
  questionId: string,
  value: unknown,
  extra: object = {},
) =>
  request<BusinessSetupView>(`/workspace/organizations/${organizationId}/setup/answer`, 'POST', {
    questionId,
    value,
    ...extra,
  });

/** Answer everything the host asks for, following its own step order. */
async function answerAll(organizationId: string, businessName: string) {
  const canned: Record<string, unknown> = {
    name: businessName,
    industry: 'cabinetry',
    job: 'prepare-quotes',
    result: 'A quote a person checks before it is sent.',
    sources: ['files'],
    people: 'small-team',
    locations: 'one',
    'human-required': ['sending', 'money'],
    'data-leaving': 'non-sensitive',
    host: 'The office desktop, weekdays.',
    'spend-cap': 120,
    'first-run': 'manual',
  };
  let view = (await setupOf(organizationId)).data;
  for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1) {
    const response = await answerOne(organizationId, view.step, canned[view.step] ?? null, {
      expectedDigest: view.digest,
    });
    expect(response.status, `answering ${view.step}`).toBe(200);
    view = response.data;
  }
  return view;
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'workspace-'));
  firstPerson = null;
  await launch();
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Personal', () => {
  test('is where a fresh install starts, with no organization and no intake', async () => {
    const view = await workspace();
    expect(view.active).toEqual({ kind: 'personal' });
    expect(view.organizations).toEqual([]);
    expect(view.person.assurance).toBe('development-fixture');
  });

  test('says plainly that hosted Business is unavailable rather than offering it', async () => {
    const view = await workspace();
    expect(view.hosted.available).toBe(false);
    expect(view.hosted.reason).toMatch(/no production identity service/i);
  });

  test('has no route into the business questions', async () => {
    const organizationId = (await createBusiness('Ridge Cabinetry')).data.organizations[0]!
      .organization.id;
    await request('/workspace/switch', 'POST', { kind: 'personal' });
    expect((await workspace()).active).toEqual({ kind: 'personal' });

    for (const [route, method] of [
      [`/workspace/organizations/${organizationId}/setup`, 'GET'],
      [`/workspace/organizations/${organizationId}/setup/start`, 'POST'],
      [`/workspace/organizations/${organizationId}/setup/resume`, 'POST'],
      [`/workspace/organizations/${organizationId}/setup/answer`, 'POST'],
      [`/workspace/organizations/${organizationId}/setup/back`, 'POST'],
    ] as const) {
      const response = await request(route, method, method === 'POST' ? {} : undefined);
      expect(response.status, `${method} ${route}`).toBe(409);
      expect(errorCode(response.data)).toBe('workspace_not_active');
    }
  });

  test('settings and data survive creating, joining and switching', async () => {
    await request('/settings', 'PUT', {
      detail: 'technical',
      appearance: { package: 'field', motion: 'reduced' },
      permissions: { sending: true },
    });
    const before = (await request<Settings>('/settings')).data;
    const created = await createBusiness('Ridge Cabinetry');
    await request('/workspace/switch', 'POST', { kind: 'personal' });
    await request('/workspace/switch', 'POST', {
      kind: 'business',
      organizationId: created.data.organizations[0]!.organization.id,
    });
    const after = (await request<Settings>('/settings')).data;
    expect(after.detail).toBe(before.detail);
    expect(after.appearance).toEqual(before.appearance);
    expect(after.permissions).toEqual(before.permissions);
    expect(after.onboarding).toEqual(before.onboarding);
  });
});

describe('legacy onboarding preference', () => {
  test('an old "business" answer grants no membership, credit or authority', async () => {
    await request('/settings', 'PUT', { onboarding: { work: 'business' } });
    const view = await workspace();
    expect(view.legacyPreference.present).toBe(true);
    expect(view.legacyPreference.note).toMatch(/does not create a business workspace/i);
    expect(view.organizations).toEqual([]);
    expect(view.active).toEqual({ kind: 'personal' });
    // And it does not open the intake for anything either.
    expect((await request('/workspace/organizations/anything/setup')).status).toBe(404);
  });
});

describe('creating and switching', () => {
  test('creating a business makes the creator its owner and opens it', async () => {
    const { status, data } = await createBusiness('Ridge Cabinetry', 'cabinetry');
    expect(status).toBe(200);
    const entry = data.organizations[0]!;
    expect(entry.membership.role).toBe('owner');
    expect(entry.membership.state).toBe('active');
    expect(entry.organization.identitySource).toBe('development-fixture');
    expect(data.active).toEqual({ kind: 'business', organizationId: entry.organization.id });
  });

  test('entitlement is separate from membership and is never claimed', async () => {
    const { data } = await createBusiness('Ridge Cabinetry');
    const entry = data.organizations[0]!;
    expect(entry.entitlement).toMatchObject({ plan: 'none', managedInference: false });
    expect(entry.entitlement.reason).toMatch(/no entitlement service/i);
  });

  test('a settings write cannot move someone into a business workspace', async () => {
    const created = await createBusiness('Ridge Cabinetry');
    const organizationId = created.data.organizations[0]!.organization.id;
    await request('/workspace/switch', 'POST', { kind: 'personal' });
    const attempt = await request('/settings', 'PUT', {
      activeWorkspace: { kind: 'business', organizationId },
    });
    expect(attempt.status).toBe(200);
    expect((await workspace()).active).toEqual({ kind: 'personal' });
  });

  test('switching to a business nobody belongs to is refused', async () => {
    const response = await request('/workspace/switch', 'POST', {
      kind: 'business',
      organizationId: 'org_invented',
    });
    expect(response.status).toBe(404);
  });

  test('an email domain never joins anyone to anything', async () => {
    await createBusiness('Ridge Cabinetry');
    const response = await request('/workspace/organizations/join', 'POST', {
      code: '',
      email: 'someone@ridgecabinetry.com',
      domain: 'ridgecabinetry.com',
    });
    expect(response.status).toBe(404);
    expect((await workspace()).organizations).toHaveLength(1);
  });
});

describe('the Business intake', () => {
  let organizationId = '';
  beforeEach(async () => {
    organizationId = (await createBusiness('Ridge Cabinetry')).data.organizations[0]!.organization
      .id;
  });

  test('an owner starts it, answers it once, and reaches a proposal', async () => {
    expect((await setupOf(organizationId)).data.state).toBe('not-started');
    const started = await request<BusinessSetupView>(
      `/workspace/organizations/${organizationId}/setup/start`,
      'POST',
      {},
    );
    expect(started.data.state).toBe('drafting');
    expect(started.data.step).toBe('name');

    const finished = await answerAll(organizationId, 'Ridge Cabinetry');
    expect(finished.state).toBe('proposal-ready');
    expect(finished.ready).toBe(true);
    expect(finished.proposalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(finished.facts.find((f) => f.questionId === 'job')?.display).toMatch(/quotes/i);
    // The boundary is stated rather than implied by a spinner that stops.
    expect(finished.afterProposal).toMatch(/no rehearsal step yet/i);
  });

  test('a draft resumes where it stopped, across a restart', async () => {
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    await answerOne(organizationId, 'name', 'Ridge Cabinetry');
    await restart();
    const reopened = (await setupOf(organizationId)).data;
    expect(reopened.state).toBe('drafting');
    expect(reopened.step).toBe('industry');
    expect(reopened.answers['name']?.value).toBe('Ridge Cabinetry');
    expect(reopened.answers['name']?.origin).toBe('person');
  });

  test('back moves one question without discarding the answer', async () => {
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    await answerOne(organizationId, 'name', 'Ridge Cabinetry');
    const back = await request<BusinessSetupView>(
      `/workspace/organizations/${organizationId}/setup/back`,
      'POST',
      {},
    );
    expect(back.data.step).toBe('name');
    expect(back.data.answers['name']?.value).toBe('Ridge Cabinetry');
  });

  test('a second start is refused; finishing then changing requires an explicit resume', async () => {
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    const second = await request(
      `/workspace/organizations/${organizationId}/setup/start`,
      'POST',
      {},
    );
    expect(second.status).toBe(409);
    expect(errorCode(second.data)).toBe('setup_exists');

    await answerAll(organizationId, 'Ridge Cabinetry');
    const blocked = await answerOne(organizationId, 'name', 'Renamed');
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked.data)).toBe('resume_required');

    const resumed = await request<BusinessSetupView>(
      `/workspace/organizations/${organizationId}/setup/resume`,
      'POST',
      {},
    );
    expect(resumed.data.state).toBe('drafting');
    // Resuming starts a new proposal rather than editing the finished one.
    expect(resumed.data.proposalDigest).toBeNull();
    expect(resumed.data.answers['name']?.value).toBe('Ridge Cabinetry');
  });

  test('two administrators editing at once conflict rather than overwrite', async () => {
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    const stale = (await setupOf(organizationId)).data.digest;
    await answerOne(organizationId, 'name', 'Ridge Cabinetry');
    const late = await answerOne(organizationId, 'name', 'Someone else typing', {
      expectedDigest: stale,
    });
    expect(late.status).toBe(409);
    expect(errorCode(late.data)).toBe('setup_conflict');
    expect((await setupOf(organizationId)).data.answers['name']?.value).toBe('Ridge Cabinetry');
  });

  test('a draft saved under an older question set is refused until it is resumed', async () => {
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    await answerOne(organizationId, 'name', 'Ridge Cabinetry');
    await stop();
    const file = path.join(root, 'data', 'workspaces', 'setup', `${organizationId}.json`);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...saved, schemaRevision: 0 }, null, 2), 'utf8');
    await launch();

    const view = (await setupOf(organizationId)).data;
    expect(view.stale).toBe(true);
    const refused = await answerOne(organizationId, 'industry', 'cabinetry');
    expect(refused.status).toBe(409);
    expect(errorCode(refused.data)).toBe('stale_setup');

    const resumed = await request<BusinessSetupView>(
      `/workspace/organizations/${organizationId}/setup/resume`,
      'POST',
      {},
    );
    expect(resumed.data.stale).toBe(false);
    expect(resumed.data.schemaRevision).toBe(resumed.data.currentSchemaRevision);
    // Old answers are not reinterpreted under the new questions.
    expect(resumed.data.answers).toEqual({});
  });

  test('a credential typed into an answer is refused, not stored', async () => {
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    const refused = await answerOne(organizationId, 'name', 'password: hunter2');
    expect(refused.status).toBe(400);
    expect(errorCode(refused.data)).toBe('answer_secret_like');
    expect((await setupOf(organizationId)).data.answers['name']).toBeUndefined();
  });

  test('the question set the host serves is the one the renderer draws', async () => {
    const schema = await request<{ questions: { id: string }[] }>('/workspace/questions');
    expect(schema.status).toBe(200);
    expect(schema.data.questions.map((q) => q.id)).toContain('data-leaving');
  });
});

describe('membership', () => {
  test('an invited member joins the existing setup and does not redo it', async () => {
    const organizationId = (await createBusiness('Ridge Cabinetry')).data.organizations[0]!
      .organization.id;
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    const owner = await answerAll(organizationId, 'Ridge Cabinetry');
    expect(owner.state).toBe('proposal-ready');
    const invitation = await request<{ code: string }>(
      `/workspace/organizations/${organizationId}/invitations`,
      'POST',
      { role: 'member' },
    );
    expect(invitation.status).toBe(200);

    await restartAs('invitee');
    expect((await workspace()).organizations).toEqual([]);
    const joined = await request<WorkspaceView>('/workspace/organizations/join', 'POST', {
      code: invitation.data.code,
    });
    expect(joined.status).toBe(200);
    const entry = joined.data.organizations[0]!;
    expect(entry.membership.role).toBe('member');
    expect(entry.setup?.mayConfigure).toBe(false);
    expect(entry.setup?.resumable).toBe(false);

    // The company questions are refused for them at the host, in their own
    // active business workspace — the setup they joined is not theirs to redo.
    expect(joined.data.active).toEqual({ kind: 'business', organizationId });
    const refused = await setupOf(organizationId);
    expect(refused.status).toBe(403);
    expect(errorCode(refused.data)).toBe('not_configurator');
    expect(
      (await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {})).status,
    ).toBe(403);

    // And the owner's answers are untouched.
    await restartAsFirstPerson();
    const registry = path.join(root, 'data', 'workspaces', 'setup', `${organizationId}.json`);
    const saved = JSON.parse(await fs.readFile(registry, 'utf8'));
    expect(saved.state).toBe('proposal-ready');
    expect(saved.answers.name.value).toBe('Ridge Cabinetry');
  });

  test('a single-use invitation cannot be redeemed twice', async () => {
    const organizationId = (await createBusiness('Ridge Cabinetry')).data.organizations[0]!
      .organization.id;
    const invitation = await request<{ code: string }>(
      `/workspace/organizations/${organizationId}/invitations`,
      'POST',
      { role: 'member' },
    );
    await restartAs('first');
    expect(
      (await request('/workspace/organizations/join', 'POST', { code: invitation.data.code }))
        .status,
    ).toBe(200);
    await restartAs('second');
    const replay = await request('/workspace/organizations/join', 'POST', {
      code: invitation.data.code,
    });
    expect(replay.status).toBe(409);
    expect(errorCode(replay.data)).toBe('invitation_used');
  });

  test('only an owner invites people', async () => {
    const organizationId = (await createBusiness('Ridge Cabinetry')).data.organizations[0]!
      .organization.id;
    const invitation = await request<{ code: string }>(
      `/workspace/organizations/${organizationId}/invitations`,
      'POST',
      { role: 'member' },
    );
    await restartAs('member');
    await request('/workspace/organizations/join', 'POST', { code: invitation.data.code });
    const attempt = await request(
      `/workspace/organizations/${organizationId}/invitations`,
      'POST',
      { role: 'admin' },
    );
    expect(attempt.status).toBe(403);
  });

  test('revoked membership loses the workspace and the intake', async () => {
    const organizationId = (await createBusiness('Ridge Cabinetry')).data.organizations[0]!
      .organization.id;
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    const invitation = await request<{ code: string }>(
      `/workspace/organizations/${organizationId}/invitations`,
      'POST',
      { role: 'admin' },
    );
    await restartAs('admin');
    await request('/workspace/organizations/join', 'POST', { code: invitation.data.code });
    expect((await setupOf(organizationId)).status).toBe(200);

    // The owner removes their access.
    await restartAsFirstPerson();
    const revoked = await request<WorkspaceView>(
      `/workspace/organizations/${organizationId}/members/person_admin/revoke`,
      'POST',
      { reason: 'Left the company' },
    );
    expect(revoked.status).toBe(200);

    await restartAs('admin');
    const view = await workspace();
    expect(view.active).toEqual({ kind: 'personal' });
    expect(view.organizations).toEqual([]);
    expect(view.revoked[0]).toMatchObject({ organizationId, reason: 'Left the company' });
    expect((await setupOf(organizationId)).status).toBe(409);
    const back = await request('/workspace/switch', 'POST', { kind: 'business', organizationId });
    expect(back.status).toBe(403);
    expect(errorCode(back.data)).toBe('membership_revoked');
  });

  test('the last owner cannot be removed', async () => {
    const created = await createBusiness('Ridge Cabinetry');
    const organizationId = created.data.organizations[0]!.organization.id;
    const me = created.data.person.id;
    const attempt = await request(
      `/workspace/organizations/${organizationId}/members/${me}/revoke`,
      'POST',
      { reason: 'no' },
    );
    expect(attempt.status).toBe(409);
    expect(errorCode(attempt.data)).toBe('last_owner');
  });
});

describe('two businesses', () => {
  test('stay separate in tenant, setup and answers', async () => {
    const first = (await createBusiness('Ridge Cabinetry')).data.organizations[0]!.organization;
    const second = (await createBusiness('Harbour Diner')).data.organizations.find(
      (item) => item.organization.name === 'Harbour Diner',
    )!.organization;
    expect(first.tenantId).not.toBe(second.tenantId);

    await request('/workspace/switch', 'POST', { kind: 'business', organizationId: first.id });
    await request(`/workspace/organizations/${first.id}/setup/start`, 'POST', {});
    await answerAll(first.id, 'Ridge Cabinetry');

    // The other workspace's intake is untouched, and cannot be reached from here.
    const crossed = await setupOf(second.id);
    expect(crossed.status).toBe(409);
    expect(errorCode(crossed.data)).toBe('workspace_not_active');

    await request('/workspace/switch', 'POST', { kind: 'business', organizationId: second.id });
    const fresh = (await setupOf(second.id)).data;
    expect(fresh.state).toBe('not-started');
    expect(fresh.answers).toEqual({});

    const view = await workspace();
    expect(view.organizations).toHaveLength(2);
    expect(view.organizations.find((o) => o.organization.id === first.id)!.setup!.state).toBe(
      'proposal-ready',
    );
  });
});
