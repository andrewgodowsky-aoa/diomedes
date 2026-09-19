import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { EngineService } from '../server/engines/service.js';
import type { ReadinessProjection } from '../shared/readiness.js';

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let base: string;
let discover: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-fd03-http-'));
  discover = vi.fn(async () => {
    throw new Error('Readiness must not probe');
  });
  const engines = new EngineService(path.join(root, 'engines'), { discover });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/readiness`;
});
afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('mounted readiness uses cached facts and cannot self-certify shipped knowledge', async () => {
  const before = structuredClone(app.locals.store.settings);
  const response = await fetch(base);
  expect(response.status).toBe(200);
  const { readiness } = (await response.json()) as { readiness: ReadinessProjection };
  expect(readiness.routes.length).toBeGreaterThan(0);
  expect(readiness.routes.every((route) => route.axes.verified.value === 'unknown')).toBe(true);
  expect(readiness.workflows.every((workflow) => !workflow.ready)).toBe(true);
  expect(app.locals.store.settings).toEqual(before);
  expect(discover).not.toHaveBeenCalled();
});

test('connection readiness is explicitly project-scoped and does not mutate its state', async () => {
  const project = await app.locals.store.createProject('Readiness scope');
  const before = structuredClone(app.locals.store.state(project.id));
  expect((await fetch(`${base}?projectId=${project.id}`)).status).toBe(200);
  expect(app.locals.store.state(project.id)).toEqual(before);
  expect((await fetch(`${base}?projectId=does-not-exist`)).status).toBe(404);
  expect((await fetch(`${base}?projectId=a&projectId=b`)).status).toBe(400);
  expect(discover).not.toHaveBeenCalled();
});

test('workflow API reports blockers and refuses unknown workflows', async () => {
  const all = (await (await fetch(base)).json()) as { readiness: ReadinessProjection };
  expect(all.readiness.workflows.length).toBeGreaterThan(0);
  const id = all.readiness.workflows[0].id;
  const response = await fetch(`${base}/workflows/${id}`);
  expect(response.status).toBe(200);
  const { workflow } = await response.json();
  expect(workflow.ready).toBe(false);
  expect(workflow.blockers.length).toBeGreaterThan(0);
  expect((await fetch(`${base}/workflows/unknown-workflow`)).status).toBe(404);
  expect(discover).not.toHaveBeenCalled();
});
