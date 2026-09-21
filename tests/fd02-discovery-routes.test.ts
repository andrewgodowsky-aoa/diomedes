import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { currentFact, type ProspectDiscoveryRecord } from '../shared/discovery';
import type { Project, ProjectState } from '../shared/types';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let base: string;
let project: Project;
const prospect = (name: string) => ({
  prospectName: name,
  goals: ['Spend less time preparing the weekly review'],
  currentProcess: [
    {
      action: 'Compare the weekly exports',
      actor: 'Owner',
      inputs: ['Sales export'],
      outputs: ['Review note'],
      handoffs: [],
      timing: 'One hour',
      painPoints: ['Repeated copying'],
    },
  ],
  hypothesis: {
    statement: 'A review note may reduce repeated copying',
    workflowFamily: 'weekly-brief',
  },
});
async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.status, `${route}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}
async function start() {
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    port,
    clientPort: port,
    reviewerAdapter: null,
    nativeGenerator: async () => {
      throw new Error('Discovery must not call a model');
    },
  });
  server.on('request', app);
  base = `http://127.0.0.1:${port}`;
}
async function stop() {
  // Held before the first await: a hook that outlives its timeout keeps running,
  // and by then these bindings belong to the next test.
  const closingApp = app, closingServer = server;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-fd02-http-'));
  await start();
  project = await api<Project>('/projects', 'POST', { name: 'Consultant workspace' });
});
afterEach(async () => {
  await stop();
  await fs.rm(root, { recursive: true, force: true });
});
const created = (name: string) =>
  api<{ record: ProspectDiscoveryRecord }>('/discovery', 'POST', prospect(name));

test('no-account discovery preserves owner corrections, negative outcomes and recorded exports across restart', async () => {
  const workspaceBefore = await api('/workspace');
  const { record: original } = await created('Harbor Workshop');
  const corrected = await api<{ record: ProspectDiscoveryRecord }>(
    `/discovery/${original.prospectId}/facts/correct`,
    'POST',
    {
      factId: original.goalFactIds[0],
      value: 'The existing review is already quick',
      provenance: { class: 'reported', reportedBy: 'owner' },
    },
  );
  expect(currentFact(corrected.record, original.goalFactIds[0]!).value).toBe(
    'The existing review is already quick',
  );
  await api(`/discovery/${original.prospectId}/hypothesis/outcome`, 'POST', {
    outcome: 'not-a-weak-point',
    checkedAt: new Date().toISOString(),
  });
  const { record } = await api<{ record: ProspectDiscoveryRecord }>(
    `/discovery/${original.prospectId}/export`,
    'POST',
    { projectId: project.id },
  );
  expect(record.exports).toHaveLength(1);
  const exported = await api<{ text: string; sha: string }>(
    `/projects/${project.id}/documents/read?path=${encodeURIComponent(record.exports[0]!.path)}`,
  );
  expect(exported.text).toContain('The existing review is already quick');
  expect(exported.text).toMatch(/not.a.weak.point/i);
  expect(exported.text).toContain('no-file discovery');
  const state = await api<ProjectState>(`/projects/${project.id}/state`);
  const receipt = state.history.find((entry) => entry.id === record.exports[0]!.id)!;
  expect(receipt).toMatchObject({ actor: 'you', kind: 'discovery-export' });
  expect(receipt.files).toEqual([
    expect.objectContaining({
      path: record.exports[0]!.path,
      op: 'created',
      before: null,
      after: exported.sha,
      recorded: true,
    }),
  ]);
  expect(await api('/workspace')).toEqual(workspaceBefore);
  expect((await api<{ projects: Project[] }>('/projects')).projects).toHaveLength(1);
  await stop();
  await start();
  const reopened = await api<{ record: ProspectDiscoveryRecord }>('/discovery');
  expect(reopened.record).toEqual(record);
  expect(reopened.record.facts.some((fact) => fact.id === original.goalFactIds[0])).toBe(true);
  const second = await api<{ record: ProspectDiscoveryRecord }>(
    `/discovery/${record.prospectId}/export`,
    'POST',
    { projectId: project.id },
  );
  expect(second.record.exports).toHaveLength(2);
  expect(second.record.exports[1]!.path).not.toBe(record.exports[0]!.path);
});

test('trusted active selection hides the previous prospect and rejects stale or spoofed mutations', async () => {
  const { record: first } = await created('Private first workshop');
  const { record: second } = await created('Second workshop');
  const response = await request(`/discovery?activeProspectId=${first.prospectId}`);
  const text = await response.text();
  expect(text).toContain(second.prospectId);
  expect(text).not.toContain(first.prospectId);
  expect(text).not.toContain(first.prospectName);
  expect(
    (await request(`/discovery/${first.prospectId}/export`, 'POST', { projectId: project.id }))
      .status,
  ).toBe(404);
  expect(
    (
      await request(`/discovery/${first.prospectId}/select`, 'POST', {
        operatorId: first.operatorId,
      })
    ).status,
  ).toBe(400);
  const selected = await api<{ record: ProspectDiscoveryRecord }>(
    `/discovery/${first.prospectId}/select`,
    'POST',
    {},
  );
  expect(selected.record.prospectId).toBe(first.prospectId);
  expect(
    (
      await fetch(`${base}/api/discovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prospect('Unauthorized')),
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${base}/api/discovery`, { headers: { Origin: 'https://untrusted.example' } }))
      .status,
  ).toBe(403);
});

test('research import requires an unchanged Files import and preserves public provenance', async () => {
  const { record } = await created('Harbor Workshop');
  const brief = {
    business: { name: 'Harbor Workshop', category: 'cabinetry', city: 'Example City' },
    locations: [],
    services: [],
    namedSoftware: [],
    sources: [{ url: 'https://example.test/workshop', retrievedAt: '2026-09-19' }],
    observations: [{ text: 'Offers custom cabinets', source: 0 }],
    hypothesis: { workflowFamily: 'weekly-brief' },
  };
  const source = path.join(root, 'research.json');
  await fs.writeFile(source, JSON.stringify(brief));
  const candidate = await api(`/projects/${project.id}/imports/inspect`, 'POST', { path: source });
  const imported = await api<{ entryId: string; files: { path: string; sha: string }[] }>(
    `/projects/${project.id}/imports`,
    'POST',
    { files: [candidate] },
  );
  const file = imported.files[0]!;
  const input = { projectId: project.id, path: file.path, sha: file.sha };
  expect(
    (
      await request(`/discovery/${record.prospectId}/import`, 'POST', {
        ...input,
        sha: '0'.repeat(64),
      })
    ).status,
  ).toBe(403);
  const added = await api<{ record: ProspectDiscoveryRecord }>(
    `/discovery/${record.prospectId}/import`,
    'POST',
    input,
  );
  const publicFact = added.record.facts.find((fact) => fact.value === 'Offers custom cabinets')!;
  expect(publicFact).toMatchObject({
    origin: 'imported-document',
    provenance: {
      class: 'public',
      url: 'https://example.test/workshop',
      retrievedAt: '2026-09-19',
    },
  });
  const evidence = {
    kind: 'approved-file',
    projectId: project.id,
    path: file.path,
    sha: file.sha,
    historyEntryId: imported.entryId,
  };
  expect(
    (
      await request(`/discovery/${record.prospectId}/facts`, 'POST', {
        field: 'observation',
        label: 'Evidence',
        value: 'A file is present',
        provenance: { class: 'observed', evidence: { ...evidence, historyEntryId: 'invented' } },
      })
    ).status,
  ).toBe(403);
  const observed = await api<{ record: ProspectDiscoveryRecord }>(
    `/discovery/${record.prospectId}/facts`,
    'POST',
    {
      field: 'observation',
      label: 'Evidence',
      value: 'A file is present',
      provenance: { class: 'observed', evidence },
    },
  );
  expect(observed.record.facts.at(-1)?.provenance.class).toBe('observed');
  expect(
    (
      await request(`/discovery/${record.prospectId}/facts/correct`, 'POST', {
        factId: publicFact.id,
        value: 'Claim upgraded',
        provenance: { class: 'observed', evidence },
      })
    ).status,
  ).toBe(409);
  await api(`/projects/${project.id}/documents/create`, 'POST', {
    path: 'Imports/created-not-imported.json',
    text: JSON.stringify(brief),
  });
  const ordinary = await api<{ sha: string }>(
    `/projects/${project.id}/documents/read?path=Imports%2Fcreated-not-imported.json`,
  );
  expect(
    (
      await request(`/discovery/${record.prospectId}/import`, 'POST', {
        projectId: project.id,
        path: 'Imports/created-not-imported.json',
        sha: ordinary.sha,
      })
    ).status,
  ).toBe(403);
});
