import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { changeCloudSharing, cloudSharing, requireCloudSharing } from '../server/cloud-sharing.js';
import type { ProjectState } from '../shared/types.js';

const state = () => ({ project: { id: 'p1' } }) as ProjectState;

test('older and damaged projects deny every cloud route by default', () => {
  const project = state();
  expect(cloudSharing(project)).toEqual({ version: 0, routes: [], documents: [], shareConversationHistory: false });
  expect(() => requireCloudSharing(project, 'codex', [])).toThrow('Cloud sharing');
  expect(() => requireCloudSharing(project, 'sample', [])).not.toThrow();
  project.cloudSharing = { version: 2, routes: ['codex'], documents: ['.env'], shareConversationHistory: true };
  expect(() => requireCloudSharing(project, 'codex', [])).toThrow('Cloud sharing');
});

test('a project allows only its selected route and document, and history is independent', () => {
  const project = state();
  const other = state();
  const policy = changeCloudSharing(project, {
    expectedVersion: 0,
    routes: ['aws-bedrock'],
    documents: ['Allowed.md'],
    shareConversationHistory: false,
  });
  expect(policy.version).toBe(1);
  expect(() => requireCloudSharing(project, 'aws-bedrock', ['Allowed.md'])).not.toThrow();
  expect(() => requireCloudSharing(project, 'aws-bedrock', ['Other.md'])).toThrow('Cloud sharing');
  expect(() => requireCloudSharing(project, 'codex', [])).toThrow('Cloud sharing');
  expect(() => requireCloudSharing(other, 'aws-bedrock', [])).toThrow('Cloud sharing');
  expect(() => requireCloudSharing(project, 'aws-bedrock', [], true)).toThrow('Cloud sharing');
  expect(() => changeCloudSharing(project, { expectedVersion: 0, routes: [], documents: [], shareConversationHistory: false })).toThrow('Cloud sharing changed');
  changeCloudSharing(project, { expectedVersion: 1, routes: [], documents: [], shareConversationHistory: false });
  expect(() => requireCloudSharing(project, 'aws-bedrock', [])).toThrow('Cloud sharing');
});

test('private paths and the sample route cannot be allowlisted', () => {
  const project = state();
  for (const input of [
    { routes: ['sample'], documents: [] },
    { routes: ['codex'], documents: ['.env'] },
    { routes: ['codex'], documents: ['../outside.md'] },
  ]) {
    expect(() => changeCloudSharing(project, { expectedVersion: 0, ...input, shareConversationHistory: false })).toThrow();
  }
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

test('cloud sharing API persists an optimistic, project-scoped policy', async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'cloud-sharing-'));
  const app = await createApp({ dataDir: path.join(root, 'data'), projectRoot: path.join(root, 'projects') });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  close = async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const post = (url: string, body: unknown, method = 'POST') => fetch(`${base}${url}`, {
    method, headers, body: JSON.stringify(body),
  });
  const one = await (await post('/projects', { name: 'One' })).json() as { id: string };
  const two = await (await post('/projects', { name: 'Two' })).json() as { id: string };
  const url = `/projects/${one.id}/cloud-sharing`;
  expect(await (await fetch(`${base}${url}`, { headers })).json()).toMatchObject({ version: 0, routes: [] });
  const saved = await post(url, {
    expectedVersion: 0, routes: ['codex'], documents: [], shareConversationHistory: false,
  }, 'PUT');
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ version: 1, routes: ['codex'] });
  expect((await post(url, {
    expectedVersion: 0, routes: [], documents: [], shareConversationHistory: false,
  }, 'PUT')).status).toBe(409);
  expect(await (await fetch(`${base}/projects/${two.id}/cloud-sharing`, { headers })).json()).toMatchObject({ version: 0, routes: [] });
});
