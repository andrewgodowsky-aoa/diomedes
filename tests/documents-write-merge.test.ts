import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { HistoryEntry, ProjectState } from '../shared/types.js';

// Artifacts v2, E2. `/documents/write` folds an edit into your last edit of the same file when that
// edit is under ten minutes old (server/store.ts, writeRecorded). Save to Files writes each later
// version of an artifact over its own file, so without a way out, a second version saved soon
// after the first rewrote the first's History entry and left the first version with none.
// `merge: false` is that way out: exact, and nothing else is accepted in its place.

let server: Server, app: Awaited<ReturnType<typeof createApp>>, temp: string, url: string;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

const FILE = 'Saved artifacts/Delivery check.md';
const V1 = '```mermaid\n%% artifact: id=delivery-flow title="Delivery check"\ngraph TD\n  A-->B\n```\n';
const V2 = '```mermaid\n%% artifact: id=delivery-flow title="Delivery check"\ngraph TD\n  A-->B-->C\n```\n';

/** A project holding the first version, saved the way Save to Files saves it first. */
async function firstVersion(): Promise<{ id: string; created: HistoryEntry }> {
  const project = await request('/projects', 'POST', { name: 'Delivery desk' });
  expect(project.status).toBe(200);
  const id = project.data.id as string;
  const created = await request(`/projects/${id}/documents/create`, 'POST', { path: FILE, text: V1 });
  expect(created.status).toBe(200);
  return { id, created: created.data as HistoryEntry };
}

async function read(id: string): Promise<{ text: string; sha: string }> {
  const result = await request(`/projects/${id}/documents/read?path=${encodeURIComponent(FILE)}`);
  expect(result.status).toBe(200);
  return result.data;
}

const history = async (id: string) =>
  ((await request(`/projects/${id}/state`)).data as ProjectState).history.filter((entry) =>
    entry.files.some((file) => file.path === FILE),
  );

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'write-merge-'));
  app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20 });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // Held before the first await: a hook that outlives its timeout keeps running, and by then
  // these bindings belong to the next test.
  const closingApp = app,
    closingServer = server;
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

describe('/documents/write with merge: false', () => {
  test('a second version saved within ten minutes keeps the first version its own History entry', async () => {
    const { id, created } = await firstVersion();
    const [first] = await history(id);
    expect(first.id).toBe(created.id);
    const opened = await read(id);
    const written = await request(`/projects/${id}/documents/write`, 'POST', {
      path: FILE,
      text: V2,
      baseSha: opened.sha,
      merge: false,
    });
    expect(written.status).toBe(200);
    expect(written.data.entryId).not.toBe(created.id);

    // Two entries: the first still says the file was created with the first version.
    const entries = await history(id);
    expect(entries.map((entry) => entry.id)).toEqual([created.id, written.data.entryId]);
    expect(entries[0].files).toEqual(first.files);
    expect(entries[1].files).toEqual([
      expect.objectContaining({ path: FILE, op: 'modified', before: first.files[0].after }),
    ]);
    // And the first version comes back from the second entry.
    const restored = await request(`/projects/${id}/history/${written.data.entryId}/restore`, 'POST', {});
    expect(restored.status).toBe(200);
    expect((await read(id)).text).toBe(V1);
  });

  test('merge is exactly false when it is given: anything else is refused and writes nothing', async () => {
    const { id } = await firstVersion();
    const opened = await read(id);
    for (const merge of [true, 'false', 0, null, {}]) {
      const refused = await request(`/projects/${id}/documents/write`, 'POST', {
        path: FILE,
        text: V2,
        baseSha: opened.sha,
        merge,
      });
      expect(refused.status, JSON.stringify(merge)).toBe(400);
    }
    expect((await read(id)).text).toBe(V1);
    expect(await history(id)).toHaveLength(1);
  });

  test('without the flag an edit still folds into your last edit of the same file', async () => {
    const { id, created } = await firstVersion();
    const opened = await read(id);
    const written = await request(`/projects/${id}/documents/write`, 'POST', {
      path: FILE,
      text: V2,
      baseSha: opened.sha,
    });
    expect(written.status).toBe(200);
    expect(written.data.entryId).toBe(created.id);
    expect(await history(id)).toHaveLength(1);
  });
});
