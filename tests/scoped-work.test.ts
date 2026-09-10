import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import type { ProjectState } from '../shared/types.js';
import { Store } from '../server/store.js';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let temp: string, url: string, projectId: string, taskId: string;
let result: Awaited<ReturnType<NativeGenerator>>;
let generate: NativeGenerator;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
const grantBody = () => ({
  protocolVersion: 2,
  commandId: crypto.randomUUID(),
  taskId,
  roots: ['.'],
  operations: ['text.create', 'text.modify'],
  engine: 'codex',
  accountRoute: 'codex:chatgpt',
  maxWrites: 40,
  maxBytes: 5_242_880,
  ttlMinutes: 60,
  review: 'human',
});
const grant = (body = grantBody()) =>
  request(`/projects/${projectId}/permissions/grants`, 'POST', body);
const start = (sources: string[] = []) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    taskId,
    route: 'codex',
    consent: true,
    sources,
  });
function proposal(name: string, text: string | null = 'recorded result') {
  result = {
    text: JSON.stringify({
      summary: 'Create the result',
      changes: [{ path: name, text, summary: 'Result' }],
    }),
    model: 'runtime-model',
  };
}
async function settled() {
  let current = await state();
  await vi.waitFor(async () => {
    current = await state();
    expect(current.sessions.at(-1)?.state).not.toBe('working');
  });
  return current;
}
beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'scope-work-'));
  generate = async () => result;
  app = await createApp({
    dataDir: path.join(temp, 'data'),
    projectRoot: path.join(temp, 'projects'),
    nativeGenerator: (input) => generate(input),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Scoped work',
      description: 'Create text results',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  proposal('Result.md');
});
afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('human-issued task scope', () => {
  test('one confirmation permits twenty journaled edits, each with independent authorization evidence', async () => {
    const issued = await grant();
    expect(issued.status).toBe(200);
    for (let n = 0; n < 20; n++) {
      proposal(`Result-${n}.md`, `result ${n}`);
      expect((await start()).status).toBe(200);
      const current = await settled();
      expect(current.sessions.at(-1)?.state).toBe('done');
      expect(current.needs.filter((need) => need.state === 'open')).toHaveLength(0);
      const need = current.needs.at(-1)!;
      expect(need.approvalReceipt).toBeUndefined();
      expect(need.authorization?.kind).toBe('scope-grant');
      expect(need.authorization?.grantId).toBe(issued.data.grant.id);
      expect(need.execution?.state).toBe('applied');
      expect(await fs.readFile(path.join(current.project.folder, `Result-${n}.md`), 'utf8')).toBe(
        `result ${n}`,
      );
    }
    const current = await state();
    expect(current.history.filter((entry) => entry.kind === 'changed')).toHaveLength(20);
    expect(new Set(current.needs.map((need) => need.authorization?.id)).size).toBe(20);
  }, 30_000);

  test('review changes still waits and legacy task flags do not mint authority', async () => {
    const thread = await request(`/projects/${projectId}/threads`, 'POST', {
      taskId,
      name: 'Legacy task flag',
      permission: 'task',
    });
    await request(`/projects/${projectId}/work/start`, 'POST', {
      taskId,
      route: 'codex',
      consent: true,
      sources: [],
      threadId: thread.data.id,
    });
    const current = await settled();
    expect(current.needs.at(-1)?.state).toBe('open');
    expect(current.needs.at(-1)?.authorization).toBeUndefined();
    await expect(fs.stat(path.join(current.project.folder, 'Result.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('proposal and recorded write retain the runtime origin independently from settings', async () => {
    expect((await grant()).status).toBe(200);
    await start();
    const completed = await settled();
    expect(completed.needs.at(-1)?.origin?.model.reported).toBe('runtime-model');
    expect(completed.needs.at(-1)?.origin?.mode).toBe('direct');
    expect(
      [...completed.history].reverse().find((entry) => entry.kind === 'changed')?.origin?.model
        .reported,
    ).toBe('runtime-model');
    await request('/settings', 'PUT', { services: { codexModel: 'different-request' } });
    expect((await state()).needs.at(-1)?.origin).toEqual(completed.needs.at(-1)?.origin);
  });

  test('duplicate scope creation reconciles and changed payload cannot widen its command', async () => {
    const command = grantBody();
    const first = await grant(command);
    expect(first.status).toBe(200);
    expect((await grant(command)).data.grant.id).toBe(first.data.grant.id);
    expect((await grant({ ...command, maxWrites: 41 })).status).toBe(409);
  });

  test.each([
    { operations: ['text.delete'] },
    { operations: ['command.run'] },
    { roots: ['../outside'] },
    { roots: ['C:\\outside'] },
    { roots: ['dir/../outside'] },
    { roots: ['dir.'] },
    { roots: ['NUL'] },
    { roots: ['dir:stream'] },
    { roots: ['.git'] },
    { review: 'auto' },
    { engine: 'opencode' },
    { accountRoute: 'codex:api' },
    { tenantId: 'forged' },
    { issuer: 'owner' },
    { fullAccess: true },
  ])('refuses unsupported or forged scope %j', async (extra) => {
    const denied = await request(`/projects/${projectId}/permissions/grants`, 'POST', {
      ...grantBody(),
      ...extra,
    });
    expect([400, 403, 409]).toContain(denied.status);
  });

  test('a new task receives no authority from another task', async () => {
    expect((await grant()).status).toBe(200);
    taskId = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Other task' })).data
      .id;
    await start();
    expect((await settled()).needs.at(-1)?.state).toBe('open');
  });

  test('out-of-scope destinations and deletions require an exact review', async () => {
    await fs.mkdir(path.join((await state()).project.folder, 'reports'));
    expect((await grant({ ...grantBody(), roots: ['reports'] })).status).toBe(200);
    proposal('Elsewhere.md');
    await start();
    const current = await settled();
    expect(current.needs.at(-1)?.state).toBe('open');
    expect(current.needs.at(-1)?.authorization).toBeUndefined();
    expect(current.needs.at(-1)?.authorizationBoundary).toMatch(/outside.*authorized/i);
  });

  test('revocation during generation prevents automatic writes and stops owned work', async () => {
    const issued = await grant();
    expect(issued.status).toBe(200);
    let finish!: (value: typeof result) => void;
    generate = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const running = await start();
    expect(running.status).toBe(200);
    const revoked = await request(
      `/projects/${projectId}/permissions/grants/${issued.data.grant.id}/revoke`,
      'POST',
      {},
    );
    expect(revoked.status).toBe(200);
    finish(result);
    const current = await settled();
    expect(current.sessions.at(-1)?.state).toBe('stopped');
    await expect(fs.stat(path.join(current.project.folder, 'Result.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('an expired live scope requires exact approval even after presentation and requested model changes', async () => {
    expect((await grant({ ...grantBody(), ttlMinutes: 1 })).status).toBe(200);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    try {
      app.locals.store.settings.detail = 'technical';
      app.locals.store.settings.services.codexModel = 'different-request';
      proposal('Expired.md');
      await start();
      const current = await settled();
      expect(current.needs.at(-1)?.state).toBe('open');
      expect(current.needs.at(-1)?.authorization).toBeUndefined();
      expect(current.needs.at(-1)?.authorizationBoundary).toMatch(/expired/i);
      await expect(fs.stat(path.join(current.project.folder, 'Expired.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      clock.mockRestore();
    }
  });

  test('a junction beneath an authorized root cannot receive a write', async () => {
    const current = await state();
    const outside = path.join(temp, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(current.project.folder, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await grant()).status).toBe(200);
    proposal('linked/Escape.md');
    await start();
    expect((await settled()).sessions.at(-1)?.state).toBe('failed');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test('a host restart retains effects but never revives an active scope or duplicates a write', async () => {
    const issued = await grant();
    expect(issued.status).toBe(200);
    await start();
    const current = await settled();
    const restarted = new Store(path.join(temp, 'data'), path.join(temp, 'projects'));
    await restarted.init();
    expect(restarted.scopeGrants.view(projectId)[0].active).toBe(false);
    expect(
      restarted.state(projectId).history.filter((entry) => entry.kind === 'changed'),
    ).toHaveLength(1);
    expect(restarted.state(projectId).needs.at(-1)?.execution?.state).toBe('applied');
    expect(await fs.readFile(path.join(current.project.folder, 'Result.md'), 'utf8')).toBe(
      'recorded result',
    );
    const replay = await restarted.scopeGrants.issue(projectId, {
      ...grantBody(),
      commandId: issued.data.grant.commandId,
    });
    expect(replay.grant.id).toBe(issued.data.grant.id);
    expect(restarted.scopeGrants.view(projectId)[0].active).toBe(false);
  });

  test('a selected base changed during generation is preserved under a scope', async () => {
    expect((await grant()).status).toBe(200);
    let finish!: (value: typeof result) => void;
    generate = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    proposal('Fall menu.md', 'proposed replacement');
    await start(['Fall menu.md']);
    const folder = (await state()).project.folder;
    await fs.writeFile(path.join(folder, 'Fall menu.md'), 'new human edit');
    finish(result);
    const current = await settled();
    expect(current.needs.at(-1)?.execution?.state).toBe('not-applied');
    expect(await fs.readFile(path.join(folder, 'Fall menu.md'), 'utf8')).toBe('new human edit');
  });

  test('budget exhaustion, deletion, and a changed billing route never silently apply', async () => {
    expect((await grant({ ...grantBody(), maxWrites: 1 })).status).toBe(200);
    await start();
    await settled();
    proposal('Second.md');
    await start();
    let current = await settled();
    expect(current.needs.at(-1)?.state).toBe('open');
    await request(`/projects/${projectId}/work/${current.sessions.at(-1)!.id}/stop`, 'POST', {});
    expect((await grant()).status).toBe(200);
    proposal('Fall menu.md', null);
    await start(['Fall menu.md']);
    current = await settled();
    expect(current.needs.at(-1)?.state).toBe('open');
    await request(`/projects/${projectId}/work/${current.sessions.at(-1)!.id}/stop`, 'POST', {});
    app.locals.store.settings.services.codexAccountRoute = 'codex:api';
    proposal('Third.md');
    await start();
    expect((await settled()).needs.at(-1)?.state).toBe('open');
  });

  test('expiry and revocation are checked immediately before the filesystem effect', async () => {
    const issued = await grant();
    expect(issued.status).toBe(200);
    const store: Store = app.locals.store;
    const original = store.object.bind(store);
    let triggered = false;
    vi.spyOn(store, 'object').mockImplementation(async (id, sha) => {
      const text = await original(id, sha);
      if (
        !triggered &&
        store.state(projectId).needs.at(-1)?.authorization &&
        (await fs.readdir(path.join(temp, 'data', 'pending'))).length > 0
      ) {
        triggered = true;
        await store.scopeGrants.revoke(projectId, issued.data.grant.id);
      }
      return text;
    });
    await start();
    const current = await settled();
    expect(triggered).toBe(true);
    expect(current.needs.at(-1)?.execution?.state).not.toBe('applied');
    await expect(fs.stat(path.join(current.project.folder, 'Result.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const need = current.needs.at(-1)!;
    expect(need.execution?.state).toBe('conflicted');
    expect(need.execution?.conflicts).toEqual(['Result.md']);
    expect(need.execution?.reason).toMatch(/scope is no longer active/i);
    const changed = current.history.filter((entry) => entry.kind === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].files).toHaveLength(1);
    expect(changed[0].files[0]).toMatchObject({
      path: 'Result.md',
      before: null,
      recorded: true,
      op: 'created',
    });
    const outside = current.history.filter((entry) => entry.kind === 'outside');
    expect(outside).toHaveLength(0);
    const change = current.changes.find((item) => item.path === 'Result.md');
    expect(change?.current).toBeNull();
    expect(change?.changedSince?.actor).toBe('task scope ended before write');
    expect(change?.after).toBe('recorded result');
  });

  test('revoked scope with a genuine outside replacement still records truthful conflict evidence', async () => {
    const issued = await grant();
    expect(issued.status).toBe(200);
    const store: Store = app.locals.store;
    const original = store.object.bind(store);
    let triggered = false;
    vi.spyOn(store, 'object').mockImplementation(async (id, sha) => {
      const text = await original(id, sha);
      if (
        !triggered &&
        store.state(projectId).needs.at(-1)?.authorization &&
        (await fs.readdir(path.join(temp, 'data', 'pending'))).length > 0
      ) {
        triggered = true;
        await store.scopeGrants.revoke(projectId, issued.data.grant.id);
        await fs.writeFile(
          path.join(store.state(projectId).project.folder, 'Result.md'),
          'genuine outside edit',
        );
      }
      return text;
    });
    await start();
    const current = await settled();
    expect(triggered).toBe(true);
    expect(await fs.readFile(path.join(current.project.folder, 'Result.md'), 'utf8')).toBe(
      'genuine outside edit',
    );
    const need = current.needs.at(-1)!;
    expect(need.execution?.state).toBe('conflicted');
    expect(need.execution?.conflicts).toEqual(['Result.md']);
    const changed = current.history.filter((entry) => entry.kind === 'changed');
    expect(changed).toHaveLength(1);
    const outside = current.history.filter((entry) => entry.kind === 'outside');
    expect(outside).toHaveLength(1);
    expect(outside[0].files[0].path).toBe('Result.md');
    expect(outside[0].files[0].before).toBe(changed[0].files[0].after);
    expect(outside[0].files[0].after).not.toBe(changed[0].files[0].after);
  });
});
