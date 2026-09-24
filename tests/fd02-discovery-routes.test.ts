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

// DIO-84. An observed fact cites an approved file at one SHA. Editing that file
// normally must not lock the record: History is evidence, so the old fact and
// its evidence stay exactly as recorded, and the record says the evidence is
// stale instead of refusing to open.
interface DiscoveryReply {
  record: ProspectDiscoveryRecord;
  staleEvidence: {
    factId: string;
    projectId: string;
    path: string;
    recordedSha: string;
    currentSha: string | null;
  }[];
}
async function importedFile(name: string, text: string) {
  const source = path.join(root, name);
  await fs.writeFile(source, text);
  const candidate = await api(`/projects/${project.id}/imports/inspect`, 'POST', { path: source });
  const imported = await api<{ entryId: string; files: { path: string; sha: string }[] }>(
    `/projects/${project.id}/imports`,
    'POST',
    { files: [candidate] },
  );
  return { entryId: imported.entryId, ...imported.files[0]! };
}
const observedFrom = (file: { path: string; sha: string }, historyEntryId: string) => ({
  class: 'observed' as const,
  evidence: {
    kind: 'approved-file' as const,
    projectId: project.id,
    path: file.path,
    sha: file.sha,
    historyEntryId,
  },
});

test('listing, correcting and retiring after the evidence file is edited all answer 200 (DIO-84 report)', async () => {
  const { record } = await created('Harbor Workshop');
  const file = await importedFile('counts.txt', 'Twelve orders a week\n');
  const added = await api<DiscoveryReply>(`/discovery/${record.prospectId}/facts`, 'POST', {
    field: 'observation.orders',
    label: 'Orders',
    value: 'Twelve orders a week',
    provenance: observedFrom(file, file.entryId),
  });
  const fact = added.record.facts.at(-1)!;
  const edited = await api<{ sha: string; entryId: string }>(
    `/projects/${project.id}/documents/write`,
    'POST',
    { path: file.path, text: 'Fifteen orders a week\n', baseSha: file.sha },
  );
  const list = (await request('/discovery')).status;
  const correct = (
    await request(`/discovery/${record.prospectId}/facts/correct`, 'POST', {
      factId: fact.id,
      value: 'Fifteen orders a week',
      provenance: observedFrom({ path: file.path, sha: edited.sha }, edited.entryId),
    })
  ).status;
  const listed = await request('/discovery');
  const current = listed.status === 200
    ? currentFact(((await listed.json()) as DiscoveryReply).record, fact.id).id
    : fact.id;
  const retire = (
    await request(`/discovery/${record.prospectId}/facts/correct`, 'POST', {
      factId: current,
      value: null,
      provenance: { class: 'unknown', reason: 'Retired after the file changed.' },
    })
  ).status;
  expect({ list, correct, retire }).toEqual({ list: 200, correct: 200, retire: 200 });
});

test('an edited evidence file leaves the record inspectable, correctable and retirable (DIO-84)', async () => {
  const { record } = await created('Harbor Workshop');
  const file = await importedFile('counts.txt', 'Twelve orders a week\n');
  const evidence = observedFrom(file, file.entryId);
  await api(`/discovery/${record.prospectId}/facts`, 'POST', {
    field: 'observation.orders',
    label: 'Orders',
    value: 'Twelve orders a week',
    provenance: evidence,
  });
  const added = await api<DiscoveryReply>(`/discovery/${record.prospectId}/facts`, 'POST', {
    field: 'observation.staff',
    label: 'Staff',
    value: 'Two people prepare orders',
    provenance: evidence,
  });
  expect(added.staleEvidence ?? []).toEqual([]);
  const [orders, staff] = added.record.facts.slice(-2);

  // Edit the file normally, through the ordinary recorded write.
  const edited = await api<{ sha: string; entryId: string }>(
    `/projects/${project.id}/documents/write`,
    'POST',
    { path: file.path, text: 'Fifteen orders a week\n', baseSha: file.sha },
  );
  expect(edited.sha).not.toBe(file.sha);

  // Listing succeeds and names the stale evidence, recorded against current.
  const listed = await api<DiscoveryReply>('/discovery');
  expect(listed.record.facts).toEqual(added.record.facts);
  const stale = (factId: string) => ({
    factId,
    projectId: project.id,
    path: file.path,
    recordedSha: file.sha,
    currentSha: edited.sha,
  });
  expect(listed.staleEvidence).toEqual([stale(orders!.id), stale(staff!.id)]);

  // New observations stay strict: the old SHA is not fresh evidence.
  const refused = await request(`/discovery/${record.prospectId}/facts/correct`, 'POST', {
    factId: orders!.id,
    value: 'Fifteen orders a week',
    provenance: evidence,
  });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: 'unverified_observed_evidence' });

  // Correcting with fresh evidence from the edit works, and appends.
  const fresh = observedFrom({ path: file.path, sha: edited.sha }, edited.entryId);
  const corrected = await api<DiscoveryReply>(
    `/discovery/${record.prospectId}/facts/correct`,
    'POST',
    { factId: orders!.id, value: 'Fifteen orders a week', provenance: fresh },
  );
  const replacement = corrected.record.facts.at(-1)!;
  expect(replacement).toMatchObject({
    replacesFactId: orders!.id,
    value: 'Fifteen orders a week',
    provenance: fresh,
  });
  // The earlier fact and its evidence are untouched history.
  expect(corrected.record.facts.find((fact) => fact.id === orders!.id)).toEqual(orders);
  expect(corrected.staleEvidence.map((item) => item.factId)).toEqual([orders!.id, staff!.id]);

  // Retiring works whatever the evidence says.
  const retired = await api<DiscoveryReply>(`/discovery/${record.prospectId}/facts/correct`, 'POST', {
    factId: staff!.id,
    value: null,
    provenance: { class: 'unknown', reason: 'The owner no longer tracks this.' },
  });
  expect(retired.record.facts.at(-1)).toMatchObject({ replacesFactId: staff!.id, value: null });
  expect(retired.record.facts.find((fact) => fact.id === staff!.id)).toEqual(staff);

  // Still readable after a restart, with the same stale reading.
  await stop();
  await start();
  const reopened = await api<DiscoveryReply>('/discovery');
  expect(reopened.record).toEqual(retired.record);
  expect(reopened.staleEvidence).toEqual([stale(orders!.id), stale(staff!.id)]);
});

test('evidence from an edit that a later quick edit folded into stays inspectable (DIO-84)', async () => {
  const { record } = await created('Harbor Workshop');
  const createdEntry = await api<{ id: string }>(`/projects/${project.id}/documents/create`, 'POST', {
    path: 'Notes/visit.md',
    text: 'Owner copies totals by hand.\n',
  });
  const first = await api<{ sha: string }>(
    `/projects/${project.id}/documents/read?path=Notes%2Fvisit.md`,
  );
  const evidence = observedFrom({ path: 'Notes/visit.md', sha: first.sha }, createdEntry.id);
  const added = await api<DiscoveryReply>(`/discovery/${record.prospectId}/facts`, 'POST', {
    field: 'observation.copying',
    label: 'Copying',
    value: 'Totals are copied by hand',
    provenance: evidence,
  });
  const fact = added.record.facts.at(-1)!;
  // A second edit inside ten minutes folds into the same History entry.
  const edited = await api<{ sha: string; entryId: string }>(
    `/projects/${project.id}/documents/write`,
    'POST',
    { path: 'Notes/visit.md', text: 'Owner copies totals by hand, twice.\n', baseSha: first.sha },
  );
  expect(edited.entryId).toBe(createdEntry.id);
  const listed = await api<DiscoveryReply>('/discovery');
  expect(listed.record.facts.at(-1)).toEqual(fact);
  expect(listed.staleEvidence).toEqual([
    {
      factId: fact.id,
      projectId: project.id,
      path: 'Notes/visit.md',
      recordedSha: first.sha,
      currentSha: edited.sha,
    },
  ]);
});

test('stored evidence that never checked out still refuses the record (DIO-84 boundary)', async () => {
  const { record } = await created('Harbor Workshop');
  const file = await importedFile('counts.txt', 'Twelve orders a week\n');
  await api(`/discovery/${record.prospectId}/facts`, 'POST', {
    field: 'observation.orders',
    label: 'Orders',
    value: 'Twelve orders a week',
    provenance: observedFrom(file, file.entryId),
  });
  // Rewrite the stored record so its evidence cites a History entry that does not exist.
  await stop();
  const stored = path.join(root, 'data', 'prospects', 'discovery', `${record.prospectId}.json`);
  const text = await fs.readFile(stored, 'utf8');
  await fs.writeFile(stored, text.replace(file.entryId, 'E-invented'));
  await start();
  const response = await request('/discovery');
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'invalid_observed_evidence' });
});
