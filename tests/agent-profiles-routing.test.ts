/**
 * H09 through the real HTTP surface: a profile decides the route and exact
 * model at admission, the decision is pinned into the run record, fallback is
 * off unless the person turned it on, and a later edit or a restart never
 * changes a run that was already admitted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { forgetCatalog } from '../server/models.js';
import type { NativeGenerator } from '../server/native-work.js';
import { threadChoosesItsOwnModel } from '../server/agent-profiles.js';
import { runtimeModelDifference } from '../shared/agent-profiles.js';
import type { ProjectState, Session } from '../shared/types.js';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let root = '', url = '', projectId = '', taskId = '', threadId = '';
let generate: ReturnType<typeof vi.fn<NativeGenerator>>;
let savedCodexHome: string | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const state = async (): Promise<ProjectState> =>
  (await request(`/projects/${projectId}/state`)).data;
const proposal = (model: string) => ({
  model,
  text: JSON.stringify({
    summary: 'Create it',
    changes: [{ path: 'Result.md', text: 'profile result', summary: 'Result' }],
  }),
});
const start = () =>
  request<Session>(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    taskId,
    threadId,
    route: 'codex',
    consent: true,
    sources: [],
  });
const profile = async (patch: Record<string, unknown> = {}) =>
  (
    await request('/agent-profiles', 'POST', {
      name: 'Careful writer',
      engine: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      agentId: 'diomedes.builder',
      rules: ['Keep British spelling.'],
      ...patch,
    })
  ).data;
async function settled() {
  let current = await state();
  await vi.waitFor(
    async () => {
      current = await state();
      expect(current.needs.length).toBeGreaterThan(0);
      expect(['working', 'queued']).not.toContain(current.sessions.at(-1)?.state);
    },
    { timeout: 12_000, interval: 25 },
  );
  return current;
}
async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    nativeGenerator: (input) => generate(input),
    reviewerAdapter: null,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  const closingApp = app, closingServer = server;
  try {
    await closingApp?.locals.close();
  } finally {
    if (closingServer) {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
  }
}

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'profiles-http-'));
  // An engine that has not written its list: the model is sent as named.
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex');
  forgetCatalog();
  generate = vi.fn(async (input) => proposal(input.model ?? 'runtime-default'));
  await launch();
  projectId = (await request('/projects/sample', 'POST', {})).data.id;
  taskId = (
    await request(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Profile work',
      description: 'Create text results',
    })
  ).data.id;
  threadId = (
    await request(`/projects/${projectId}/threads`, 'POST', { taskId, name: 'Profile thread' })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  expect(
    (
      await request(`/projects/${projectId}/cloud-sharing`, 'PUT', {
        expectedVersion: 0,
        routes: ['codex'],
        documents: ['Result.md'],
        shareConversationHistory: false,
        shareReviewPackets: true,
      })
    ).status,
  ).toBe(200);
});
afterEach(async () => {
  await close();
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  forgetCatalog();
  vi.restoreAllMocks();
});

describe('a thread that picks a profile', () => {
  test('pins the exact engine, model, effort and revision at admission', async () => {
    const chosen = await profile();
    expect(chosen.revision).toBe(1);
    const picked = await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      requested: { model: null, effort: null, profile: chosen.profileId },
    });
    expect(picked.status).toBe(200);
    expect(picked.data.requested).toEqual({ model: null, effort: null, profile: chosen.profileId });
    const started = await start();
    expect(started.status).toBe(200);
    const current = await settled();
    const session = current.sessions.at(-1)!;
    expect(session.route).toBe('codex');
    expect(session.agent?.agentId).toBe('diomedes.builder');
    expect(session.agent?.requestedModel).toBe('gpt-6-astra');
    expect(session.agent?.profile).toMatchObject({
      profileId: chosen.profileId,
      revision: 1,
      digest: chosen.digest,
      engine: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      source: 'thread',
      fallbackPolicy: 'off',
      fallback: null,
      rules: ['Keep British spelling.'],
    });
    // What was sent is what was pinned, and the person's rules travel with it.
    const sent = generate.mock.calls[0][0];
    expect(sent.model).toBe('gpt-6-astra');
    expect(sent.effort).toBe('xhigh');
    expect(sent.prompt).toContain('Keep British spelling.');
  });

  test('a later edit never changes the admitted run, even across a restart', async () => {
    const chosen = await profile();
    await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      requested: { model: null, effort: null, profile: chosen.profileId },
    });
    expect((await start()).status).toBe(200);
    await settled();
    const edited = await request(`/agent-profiles/${chosen.profileId}`, 'PUT', {
      expectedRevision: 1,
      name: 'Careful writer',
      engine: 'codex',
      model: 'gpt-5.5',
      effort: 'low',
      agentId: 'diomedes.builder',
      rules: [],
    });
    expect(edited.status).toBe(200);
    expect(edited.data.revision).toBe(2);
    const pinned = (await state()).sessions.at(-1)!.agent!.profile!;
    expect(pinned).toMatchObject({ revision: 1, model: 'gpt-6-astra', effort: 'xhigh' });

    await close();
    await launch();
    const reloaded = (await state()).sessions.at(-1)!.agent!.profile!;
    expect(reloaded).toEqual(pinned);
    // The profile itself moved on, and keeps the revision the run used.
    const record = (await request(`/agent-profiles/${chosen.profileId}`)).data;
    expect(record.revisions.map((item: { revision: number }) => item.revision)).toEqual([1, 2]);
    expect(record.revisions[0].model).toBe('gpt-6-astra');
    // The next run resolves the current revision.
    expect((await start()).status).toBe(200);
    await vi.waitFor(async () => expect(generate).toHaveBeenCalledTimes(2), { timeout: 12_000 });
    expect(generate.mock.calls[1][0].model).toBe('gpt-5.5');
  });

  test('the runtime-reported model wins over the requested one, and the difference is kept', async () => {
    generate = vi.fn(async () => proposal('gpt-6-astra-2026-09-01'));
    const chosen = await profile();
    await request(`/projects/${projectId}/threads/${threadId}`, 'PUT', {
      requested: { model: null, effort: null, profile: chosen.profileId },
    });
    expect((await start()).status).toBe(200);
    const session = (await settled()).sessions.at(-1)!;
    expect(session.engine.model).toBe('gpt-6-astra-2026-09-01');
    expect(session.origin?.model).toMatchObject({
      requested: 'gpt-6-astra',
      reported: 'gpt-6-astra-2026-09-01',
      source: 'runtime',
    });
    expect(runtimeModelDifference(session)).toEqual({
      requested: 'gpt-6-astra',
      reported: 'gpt-6-astra-2026-09-01',
    });
    // The pin still names what was asked for; it is a request, not a claim.
    expect(session.agent?.profile?.model).toBe('gpt-6-astra');
  });
});

describe('routing preferences and fallback', () => {
  test('fallback is off by default: an unavailable first profile is refused by name', async () => {
    const offline = await profile({ name: 'OpenCode writer', engine: 'opencode', model: 'glm-9' });
    const online = await profile({ name: 'Codex writer' });
    const saved = await request(`/projects/${projectId}/agent-routing`, 'PUT', {
      order: [offline.profileId, online.profileId],
    });
    expect(saved.data).toEqual({ order: [offline.profileId, online.profileId], fallback: false });
    const refused = await start();
    expect(refused.status).toBe(409);
    expect((refused.data as any).error ?? JSON.stringify(refused.data)).toMatch(
      /OpenCode writer cannot run: OpenCode is off in Settings > Engines\. Fallback is off/,
    );
    // Nothing ran and nothing was left behind.
    expect(generate).not.toHaveBeenCalled();
    expect((await state()).sessions).toHaveLength(0);
  });

  test('fallback on runs the next available profile and records why', async () => {
    const offline = await profile({ name: 'OpenCode writer', engine: 'opencode', model: 'glm-9' });
    const online = await profile({ name: 'Codex writer' });
    await request(`/projects/${projectId}/agent-routing`, 'PUT', {
      order: [offline.profileId, online.profileId],
      fallback: true,
    });
    expect((await start()).status).toBe(200);
    const session = (await settled()).sessions.at(-1)!;
    expect(session.route).toBe('codex');
    expect(session.agent?.profile).toMatchObject({
      profileId: online.profileId,
      source: 'project',
      fallbackPolicy: 'on',
      fallback: {
        fromProfileId: offline.profileId,
        fromName: 'OpenCode writer',
        reason: 'OpenCode is off in Settings > Engines.',
      },
    });
    expect(session.agent?.modelSelection).toBe('automatic');
    expect(session.log.map((line) => line.sentence)).toContain(
      'Ran on Codex writer (ChatGPT · gpt-6-astra) because OpenCode writer was unavailable: OpenCode is off in Settings > Engines.',
    );
  });

  test('a task override outranks the project list', async () => {
    const projectPick = await profile({ name: 'Project pick', model: 'gpt-5.5', effort: 'low' });
    const taskPick = await profile({ name: 'Task pick' });
    await request(`/projects/${projectId}/agent-routing`, 'PUT', { order: [projectPick.profileId] });
    const override = await request(`/projects/${projectId}/tasks/${taskId}/agent-routing`, 'PUT', {
      order: [taskPick.profileId],
    });
    expect(override.status).toBe(200);
    expect((await start()).status).toBe(200);
    const session = (await settled()).sessions.at(-1)!;
    expect(session.agent?.profile).toMatchObject({ profileId: taskPick.profileId, source: 'task' });
  });

  test('unavailable profiles are listed with their reason, never hidden', async () => {
    await fs.mkdir(process.env.CODEX_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CODEX_HOME!, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            visibility: 'list',
            default_reasoning_level: 'low',
            supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
          },
        ],
      }),
    );
    forgetCatalog();
    const unlisted = await profile({ name: 'Unlisted model' });
    const deeper = await profile({ name: 'Too deep', model: 'gpt-5.5', effort: 'xhigh' });
    const offline = await profile({ name: 'Offline', engine: 'opencode', model: 'glm-9' });
    const fine = await profile({ name: 'Fine', model: 'gpt-5.5', effort: 'low' });
    const { data } = await request(`/projects/${projectId}/agent-profiles`);
    const reason = (id: string) =>
      data.profiles.find((item: { profileId: string }) => item.profileId === id);
    expect(reason(unlisted.profileId)).toMatchObject({
      available: false,
      reason: 'gpt-6-astra is not in the list ChatGPT reports for this account.',
    });
    expect(reason(deeper.profileId)).toMatchObject({
      available: false,
      reason: 'gpt-5.5 does not offer the xhigh reasoning level.',
    });
    expect(reason(offline.profileId)).toMatchObject({
      available: false,
      reason: 'OpenCode is off in Settings > Engines.',
    });
    expect(reason(fine.profileId)).toMatchObject({ available: true, reason: null });
  });

  test('a route that is on but not connected is unavailable before admission, not at dispatch', async () => {
    await request('/settings', 'PUT', { services: { codex: true, opencode: true } });
    const unconnected = await profile({ name: 'Unconnected', engine: 'opencode', model: 'glm-9' });
    const { data } = await request(`/projects/${projectId}/agent-profiles`);
    expect(
      data.profiles.find((item: { profileId: string }) => item.profileId === unconnected.profileId),
    ).toMatchObject({ available: false, reason: 'OpenCode is not connected in AI setup.' });
  });

  test('a thread that chose its own model or WorkStyle is not overridden by a project list', () => {
    expect(threadChoosesItsOwnModel(null)).toBe(false);
    expect(
      threadChoosesItsOwnModel({ requested: { model: 'gpt-5.5', effort: null } } as any),
    ).toBe(true);
    expect(threadChoosesItsOwnModel({ requested: null, workStyle: 'focused' } as any)).toBe(true);
    expect(threadChoosesItsOwnModel({ requested: { model: null, effort: null, agent: 'auto' } } as any)).toBe(false);
  });
});
