/**
 * Making the weekly brief reachable, proven through the real HTTP surface.
 *
 * The service that composes a brief has been correct and unreachable: nothing
 * decided which project a business job writes into. These tests hold the route
 * that closes that gap, and the refusals around it that matter more than the
 * happy path — an ordinary member cannot choose where the company writes, a
 * member of one company cannot bind or read another company's output, and a
 * brief with nowhere to go says so rather than picking somewhere.
 *
 * A second person is simulated the way `tests/workspaces.test.ts` does it, by
 * restarting the host over a different `workspaces/identity.json`. That file is
 * this build's labelled development fixture, not an authenticated identity.
 *
 * Every company and project here is invented.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
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

const identityPath = () => path.join(root, 'data', 'workspaces', 'identity.json');

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

/** Stand-in for the approved exports a business would really put in its project. */
const EXPORT_FIXTURE = [
  '# Exports',
  '',
  '- Two cabinets fitted on Tuesday.',
  '- One quote still open.',
  '',
].join('\n');

const folderFor = (name: string) =>
  path.join(root, 'folders', name.replace(/\W+/g, '-').toLowerCase());

/** A real project on disk, because the binding must resolve against real ones. */
async function makeProject(name: string): Promise<string> {
  const folder = folderFor(name);
  await fs.mkdir(folder, { recursive: true });
  const created = await request<{ id: string }>('/projects', 'POST', { name, folder });
  expect(created.status).toBe(200);
  return created.data.id;
}

async function makeOrganization(name: string): Promise<string> {
  const view = await request<WorkspaceView>('/workspace/organizations', 'POST', {
    name,
    industry: null,
  });
  expect(view.status).toBe(200);
  const organization = view.data.organizations.at(-1);
  if (!organization) throw new Error('no organization was created');
  return organization.organization.id;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-output-'));
  await launch();
});

afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe('binding where a business writes', () => {
  test('an owner binds an existing project and the workspace view reports it', async () => {
    const projectId = await makeProject('Company books');
    const organizationId = await makeOrganization('Fernbrook Joinery');

    const bound = await request<WorkspaceView>(
      `/workspace/organizations/${organizationId}/output`,
      'POST',
      { projectId },
    );
    expect(bound.status).toBe(200);

    const view = await request<WorkspaceView>('/workspace');
    const entry = view.data.organizations.find((o) => o.organization.id === organizationId);
    expect(entry?.output?.projectId).toBe(projectId);
    expect(entry?.output?.projectName).toBe('Company books');
  });

  test('a project that does not exist is refused rather than recorded', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    const bound = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/output`,
      'POST',
      { projectId: 'proj-nonexistent' },
    );
    expect(bound.status).toBe(404);
    // The code, not just the status: an unmounted route also answers 404, and a
    // test that accepts that proves nothing about the refusal.
    expect(bound.data.code).toBe('project_not_found');
  });

  test('an ordinary member cannot choose where the company writes', async () => {
    const projectId = await makeProject('Company books');
    const organizationId = await makeOrganization('Fernbrook Joinery');
    expect(
      (await request(`/workspace/organizations/${organizationId}/output`, 'POST', { projectId }))
        .status,
    ).toBe(200);
    const invited = await request<{ code: string }>(
      `/workspace/organizations/${organizationId}/invitations`,
      'POST',
      { role: 'member' },
    );
    expect(invited.status).toBe(200);

    await restartAs('member');
    const joined = await request('/workspace/organizations/join', 'POST', {
      code: invited.data.code,
    });
    expect(joined.status).toBe(200);

    const bound = await request(`/workspace/organizations/${organizationId}/output`, 'POST', {
      projectId,
    });
    expect(bound.status).toBe(403);

    // New per-run source choices must not let an ordinary member replace the
    // owner's configured read scope through a hand-written HTTP request.
    const brief = await request(`/workspace/organizations/${organizationId}/brief`, 'POST', {
      projectId,
      sources: [{ path: 'member-choice.csv', sha: 'a'.repeat(64) }],
    });
    expect(brief.status).toBe(403);
    expect(brief.data.code).toBe('not_a_configurer');
  });

  test('someone outside the company cannot bind its output', async () => {
    const projectId = await makeProject('Company books');
    const organizationId = await makeOrganization('Fernbrook Joinery');

    await restartAs('outsider');
    const bound = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/output`,
      'POST',
      { projectId },
    );
    // Not a 403: an outsider learning that this id names a real company is
    // itself a leak. It must read the same as an id that does not exist.
    expect(bound.status).toBe(404);
    expect(bound.data.code).toBe('organization_not_found');
  });
});

describe('running the brief', () => {
  test('with nowhere bound, the brief refuses and names the choice to make', async () => {
    const organizationId = await makeOrganization('Fernbrook Joinery');
    const ran = await request<{ message: string; code?: string }>(
      `/workspace/organizations/${organizationId}/brief`,
      'POST',
      {},
    );
    expect(ran.status).toBe(409);
    expect(JSON.stringify(ran.data)).toContain('Fernbrook Joinery');
  });

  test('with no active setup, a bound project is still not enough', async () => {
    const projectId = await makeProject('Company books');
    const organizationId = await makeOrganization('Fernbrook Joinery');
    await request(`/workspace/organizations/${organizationId}/output`, 'POST', { projectId });

    const ran = await request(`/workspace/organizations/${organizationId}/brief`, 'POST', {});
    // A brief comes from an activated configuration. Binding a project decides
    // where, never whether.
    expect(ran.status).toBe(409);
  });

  test("a member of one company cannot run another company's brief", async () => {
    const projectId = await makeProject('Company books');
    const organizationId = await makeOrganization('Fernbrook Joinery');
    await request(`/workspace/organizations/${organizationId}/output`, 'POST', { projectId });

    await restartAs('outsider');
    const ran = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/brief`,
      'POST',
      {},
    );
    expect(ran.status).toBe(404);
    expect(ran.data.code).toBe('organization_not_found');
  });
});

/**
 * The whole path, end to end: a business answers its questions, turns a setup
 * on, chooses where it writes, and gets a draft it can read.
 *
 * This is the case that was missing. The brief composer and the configuration
 * were each proven on their own, and nothing joined them, because nothing
 * decided which project a business job writes into. A test that stops at
 * "the service composes correctly" would still pass with the product
 * unreachable, so this one goes through the same HTTP surface a person does
 * and then reads the file off disk.
 */
describe('a business gets a brief it can read', () => {
  /** Answer every question with something plausible, the way the setup proof does. */
  async function answerAll(organizationId: string) {
    const canned: Record<string, unknown> = {
      name: 'Fernbrook Joinery',
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
    };
    await request(`/workspace/organizations/${organizationId}/setup/start`, 'POST', {});
    let view = (
      await request<{ step: string; digest: string; state: string }>(
        `/workspace/organizations/${organizationId}/setup`,
      )
    ).data;
    for (let guard = 0; guard < 20 && view.step !== 'review'; guard += 1) {
      const response = await request<typeof view>(
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
  }

  test('answers, an activated setup and a chosen project produce a draft on disk', async () => {
    const projectId = await makeProject('Company books');
    const organizationId = await makeOrganization('Fernbrook Joinery');
    await answerAll(organizationId);

    const base = `/workspace/organizations/${organizationId}/configuration`;
    const compiled = await request<{
      staged: { revision: number } | null;
      expectedActiveRevision: number | null;
    }>(`${base}/compile`, 'POST', {});
    expect(compiled.status).toBe(200);
    const activated = await request<{
      active: { proposal: { contextScopes: { selection: string[] }[] } } | null;
    }>(`${base}/activate`, 'POST', {
      revision: compiled.data.staged!.revision,
      expectedActiveRevision: compiled.data.expectedActiveRevision,
      activationId: 'brief-proof-1',
    });
    expect(activated.status).toBe(200);

    // A brief with no source composes nothing, which is correct and proves
    // nothing. Write the files the activated setup actually names, rather than
    // a guess at them: the test then keeps working when the pack changes what
    // it reads, and fails loudly if a setup activates naming nothing at all.
    const scope = (activated.data.active?.proposal.contextScopes ?? []).flatMap(
      (item) => item.selection,
    );
    expect(scope.length).toBeGreaterThan(0);
    for (const name of scope)
      await fs.writeFile(path.join(folderFor('Company books'), name), EXPORT_FIXTURE, 'utf8');

    // Still refused, because where has not been decided. This is the assertion
    // that would have caught the gap: an activated setup is not enough.
    const beforeBinding = await request<{ code?: string }>(
      `/workspace/organizations/${organizationId}/brief`,
      'POST',
      {},
    );
    expect(beforeBinding.status).toBe(409);
    expect(beforeBinding.data.code).toBe('no_output_project');

    const bound = await request(`/workspace/organizations/${organizationId}/output`, 'POST', {
      projectId,
    });
    expect(bound.status).toBe(200);

    const ran = await request<{
      projectId: string;
      projectName: string;
      destination: string;
      entryId: string;
      sections: number;
    }>(`/workspace/organizations/${organizationId}/brief`, 'POST', {});
    expect(ran.status).toBe(200);
    expect(ran.data.projectId).toBe(projectId);
    expect(ran.data.projectName).toBe('Company books');
    expect(ran.data.sections).toBeGreaterThan(0);

    // The draft is a real file in the project the business chose, not a
    // response body that looked like one.
    const draft = await fs.readFile(
      path.join(folderFor('Company books'), ran.data.destination),
      'utf8',
    );
    expect(draft.length).toBeGreaterThan(0);
    // Every claim in a brief carries its source; the fixture's own words are
    // what proves the draft came from the file rather than from a template.
    expect(draft).toContain('cabinets fitted');

    // The new route uses real imports, with arbitrary export names rather than
    // the pack's historical fixture paths. A stale bound project is refused.
    const exportPath = path.join(root, 'chosen-export.csv');
    await fs.writeFile(exportPath, 'rooms,ready\nDining,yes');
    const inspected = await request<{ path: string; sha: string }>(
      `/projects/${projectId}/imports/inspect`,
      'POST',
      { path: exportPath },
    );
    expect(inspected.status).toBe(200);
    const copied = await request<{ files: { path: string; sha: string }[] }>(
      `/projects/${projectId}/imports`,
      'POST',
      { files: [inspected.data] },
    );
    expect(copied.status).toBe(200);
    const mismatch = await request(`/workspace/organizations/${organizationId}/brief`, 'POST', {
      projectId: 'a-different-project',
      sources: copied.data.files,
    });
    expect(mismatch.status).toBe(409);
    const explicit = await request(`/workspace/organizations/${organizationId}/brief`, 'POST', {
      projectId,
      sources: copied.data.files,
    });
    expect(explicit.status).toBe(200);
    const selectedDraft = await fs.readFile(
      path.join(folderFor('Company books'), ran.data.destination),
      'utf8',
    );
    expect(selectedDraft).toContain('Dining,yes');
    expect(selectedDraft).not.toContain('cabinets fitted');
  });
});
