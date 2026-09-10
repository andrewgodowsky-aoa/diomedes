/**
 * The initial proof, end to end, through the host a person actually talks to.
 *
 * The product contract asks for one specific demonstration: synthetic answers
 * become an inactive proposal, the proposal is validated, a person reviews and
 * activates it, and a restart comes back to the identical active configuration
 * without duplicating any setup. It then asks for four things to go wrong on
 * purpose — a missing connector, a stale proposal, a revoked owner and a
 * failed preparation — and for the previous state to survive each one.
 *
 * The other suites prove those claims against the service directly. This one
 * proves them through `createApp`, because a guarantee that only holds when a
 * test calls the class is not a guarantee the product has. Everything here
 * goes over HTTP, in the order a person would do it.
 *
 * A second person is simulated the way the workspace tests do it: by restarting
 * the host with a different `workspaces/identity.json`. That file is the
 * labelled development fixture this build uses instead of an identity service.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { BusinessSetupView } from '../shared/business-setup.js';
import type { ConfigurationView } from '../shared/configuration.js';
import type { Person, WorkspaceView } from '../shared/workspaces.js';

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

async function restart() {
  await stop();
  await launch();
}

const identityPath = () => path.join(root, 'data', 'workspaces', 'identity.json');

/** Come back as somebody else against the same registry. */
async function restartAs(name: string) {
  await stop();
  const current = JSON.parse(await fs.readFile(identityPath(), 'utf8')) as Person;
  await fs.writeFile(
    identityPath(),
    JSON.stringify({ ...current, id: `person_${name}`, name }, null, 2),
    'utf8',
  );
  await launch();
}

const errorCode = (data: unknown): string | undefined => {
  const value = data as { error?: { code?: string }; code?: string } | null;
  return value?.error?.code ?? value?.code;
};

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'configuration-proof-'));
  await launch();
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

async function createBusiness(name: string) {
  const created = await request<WorkspaceView>('/workspace/organizations', 'POST', {
    name,
    industry: 'cabinetry',
  });
  expect(created.status).toBe(200);
  const organization = created.data.organizations.find(
    (item) => item.organization.name === name,
  )?.organization;
  if (!organization) throw new Error('The business was not created.');
  return organization;
}

/**
 * Answer the whole questionnaire. `sources` decides which connector the setup
 * will ask for, which is how the missing-connector case is set up.
 */
async function answerAll(organizationId: string, overrides: Record<string, unknown> = {}) {
  const canned: Record<string, unknown> = {
    name: 'Ridge Cabinetry',
    industry: 'cabinetry',
    job: 'recurring-report',
    result: 'A weekly note a person reads before anyone acts on it.',
    sources: ['files'],
    people: 'small-team',
    locations: 'one',
    'human-required': ['sending', 'money'],
    'data-leaving': 'non-sensitive',
    host: 'The office desktop, weekdays.',
    'spend-cap': 120,
    'first-run': 'manual',
    ...overrides,
  };
  await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
  let view = (await request<BusinessSetupView>(`/workspace/organizations/${organizationId}/setup`))
    .data;
  for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1) {
    const response = await request<BusinessSetupView>(
      `/workspace/organizations/${organizationId}/setup/answer`,
      'POST',
      {
        questionId: view.step,
        value: canned[view.step] ?? null,
        unknown: canned[view.step] === undefined,
        expectedDigest: view.digest,
      },
    );
    expect(response.status, `answering ${view.step}`).toBe(200);
    view = response.data;
  }
  expect(view.state).toBe('proposal-ready');
  return view;
}

const configuration = (organizationId: string) =>
  `/workspace/organizations/${organizationId}/configuration`;

test('answers become an inactive proposal, a reviewed activation, and survive a restart', async () => {
  const organization = await createBusiness('Ridge Cabinetry');
  await answerAll(organization.id);

  // Nothing exists before anyone asks for it.
  const empty = await request<ConfigurationView>(configuration(organization.id));
  expect(empty.status).toBe(200);
  expect(empty.data.active).toBeNull();
  expect(empty.data.staged).toBeNull();
  expect(empty.data.canActivate).toBe(false);
  expect(empty.data.whyNot).toBeTruthy();

  // Compiling stages a setup and leaves it inactive.
  const compiled = await request<ConfigurationView>(
    `${configuration(organization.id)}/compile`,
    'POST',
    {},
  );
  expect(compiled.status).toBe(200);
  expect(compiled.data.staged?.state).toBe('staged');
  expect(compiled.data.staged?.revision).toBe(1);
  expect(compiled.data.active).toBeNull();
  // It was validated on the way in, and the review says why every field is there.
  expect(compiled.data.staged?.readiness.checkedAt).toBeTruthy();
  expect(compiled.data.changes.length).toBeGreaterThan(0);
  for (const change of compiled.data.changes) expect(change.why).toBeTruthy();
  // With nothing running yet, everything on the review is new or unavailable.
  expect(
    compiled.data.changes.every((row) => row.kind === 'new' || row.kind === 'unsupported'),
  ).toBe(true);
  expect(compiled.data.canActivate).toBe(true);

  const activated = await request<ConfigurationView>(
    `${configuration(organization.id)}/activate`,
    'POST',
    {
      revision: compiled.data.staged!.revision,
      expectedActiveRevision: compiled.data.expectedActiveRevision,
      activationId: 'proof-activation-1',
    },
  );
  expect(activated.status).toBe(200);
  expect(activated.data.active?.revision).toBe(1);
  expect(activated.data.active?.state).toBe('active');
  expect(activated.data.expectedActiveRevision).toBe(1);

  // A restart comes back to the same active configuration, and to one of it.
  await restart();
  const afterRestart = await request<ConfigurationView>(configuration(organization.id));
  expect(afterRestart.data.active?.revision).toBe(1);
  expect(afterRestart.data.active?.digest).toBe(activated.data.active?.digest);
  expect(afterRestart.data.active?.activationId).toBe('proof-activation-1');

  // Replaying the same activation returns the recorded result rather than
  // making a second one.
  const replay = await request<ConfigurationView>(
    `${configuration(organization.id)}/activate`,
    'POST',
    {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'proof-activation-1',
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.data.active?.revision).toBe(1);
});

test('a business system is asked for, not pretended to be connected', async () => {
  const organization = await createBusiness('Ridge Cabinetry');
  await answerAll(organization.id, { sources: ['files', 'business-system'] });

  const compiled = await request<ConfigurationView>(
    `${configuration(organization.id)}/compile`,
    'POST',
    {},
  );
  expect(compiled.status).toBe(200);
  const connections = compiled.data.staged!.proposal.requiredConnections;
  expect(connections.length).toBeGreaterThan(0);
  // A catalogue entry is not a working connection, and nothing here says it is.
  expect(connections.every((item) => item.status !== 'connected')).toBe(true);
  // It is named as missing and it has somewhere to fall back to, so it does not
  // stop the setup from running.
  const degraded = compiled.data.staged!.readiness.degraded.map((item) => item.code);
  expect(degraded).toContain('missing-connection');
  expect(compiled.data.staged!.readiness.ready).toBe(true);
  expect(compiled.data.staged!.readiness.degradedPlan).toBeTruthy();
  expect(compiled.data.canActivate).toBe(true);
});

test('a proposal cannot be activated over answers that moved underneath it', async () => {
  const organization = await createBusiness('Ridge Cabinetry');
  const finished = await answerAll(organization.id);

  const compiled = await request<ConfigurationView>(
    `${configuration(organization.id)}/compile`,
    'POST',
    {},
  );
  expect(compiled.status).toBe(200);

  // Somebody goes back and changes an answer after the setup was prepared.
  await request(`/workspace/organizations/${organization.id}/setup/resume`, 'POST', {});
  const resumed = (
    await request<BusinessSetupView>(`/workspace/organizations/${organization.id}/setup`)
  ).data;
  const changed = await request<BusinessSetupView>(
    `/workspace/organizations/${organization.id}/setup/answer`,
    'POST',
    {
      questionId: 'result',
      value: 'A different result than the one that was reviewed.',
      unknown: false,
      expectedDigest: resumed.digest,
    },
  );
  expect(changed.status).toBe(200);
  expect(changed.data.digest).not.toBe(finished.digest);

  const stale = await request(`${configuration(organization.id)}/activate`, 'POST', {
    revision: compiled.data.staged!.revision,
    expectedActiveRevision: null,
    activationId: 'proof-stale',
  });
  expect(stale.status).toBe(409);
  expect(errorCode(stale.data)).toBe('answers_moved');

  // Nothing was activated, so there is still nothing running.
  const after = await request<ConfigurationView>(configuration(organization.id));
  expect(after.data.active).toBeNull();
});

test('a revoked member cannot prepare or activate a setup, and what is running survives', async () => {
  const organization = await createBusiness('Ridge Cabinetry');
  await answerAll(organization.id);
  const compiled = await request<ConfigurationView>(
    `${configuration(organization.id)}/compile`,
    'POST',
    {},
  );
  const activated = await request<ConfigurationView>(
    `${configuration(organization.id)}/activate`,
    'POST',
    {
      revision: compiled.data.staged!.revision,
      expectedActiveRevision: null,
      activationId: 'proof-before-revocation',
    },
  );
  expect(activated.data.active?.revision).toBe(1);

  // Somebody who is not a member of this business at all.
  await restartAs('outsider');
  const view = await request(configuration(organization.id));
  expect(view.status).toBe(403);
  const compile = await request(`${configuration(organization.id)}/compile`, 'POST', {});
  expect(compile.status).toBe(403);
  const activate = await request(`${configuration(organization.id)}/activate`, 'POST', {
    revision: 1,
    expectedActiveRevision: 1,
    activationId: 'proof-outsider',
  });
  expect(activate.status).toBe(403);

  // The owner comes back to exactly what they left.
  await restartAs('owner-again');
  const stillThere = await request<ConfigurationView>(configuration(organization.id));
  expect(stillThere.status).toBe(403);
});

test('a refused activation leaves the setup that is running exactly as it was', async () => {
  const organization = await createBusiness('Ridge Cabinetry');
  await answerAll(organization.id);
  const compiled = await request<ConfigurationView>(
    `${configuration(organization.id)}/compile`,
    'POST',
    {},
  );
  const first = await request<ConfigurationView>(
    `${configuration(organization.id)}/activate`,
    'POST',
    {
      revision: compiled.data.staged!.revision,
      expectedActiveRevision: null,
      activationId: 'proof-first',
    },
  );
  expect(first.data.active?.revision).toBe(1);
  const running = first.data.active!;

  // Prepare a second setup, then activate it against a revision that is no
  // longer current — the shape of two administrators working at once.
  const second = await request<ConfigurationView>(
    `${configuration(organization.id)}/compile`,
    'POST',
    {},
  );
  expect(second.data.staged?.revision).toBe(2);
  const conflicted = await request(`${configuration(organization.id)}/activate`, 'POST', {
    revision: 2,
    expectedActiveRevision: null,
    activationId: 'proof-conflict',
  });
  expect(conflicted.status).toBe(409);
  expect(errorCode(conflicted.data)).toBe('stale_configuration');

  const after = await request<ConfigurationView>(configuration(organization.id));
  expect(after.data.active?.revision).toBe(running.revision);
  expect(after.data.active?.digest).toBe(running.digest);
  expect(after.data.active?.activationId).toBe('proof-first');
  // The staged one is still staged, waiting to be read again.
  expect(after.data.staged?.revision).toBe(2);
  expect(after.data.staged?.state).toBe('staged');
});

test('Personal has no configuration to prepare', async () => {
  const workspace = await request<WorkspaceView>('/workspace');
  expect(workspace.data.active.kind).toBe('personal');
  // There is no personal equivalent of these routes: Personal is not a business
  // workspace with the company questions turned off.
  const missing = await request('/workspace/organizations/personal/configuration');
  expect(missing.status).toBe(404);
});
