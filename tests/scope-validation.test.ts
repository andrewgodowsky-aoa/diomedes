import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { validateScopeGrants, validateScopedAuthorization } from '../server/trust/scope-grants.js';
import { validateWorkReceipts } from '../server/work-admission.js';
import type { ProjectState } from '../shared/types.js';

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
const scopeBody = (commandId = crypto.randomUUID(), task = taskId) => ({
  protocolVersion: 2,
  commandId,
  taskId: task,
  roots: ['.'],
  operations: ['text.create', 'text.modify'],
  engine: 'codex',
  accountRoute: 'codex:chatgpt',
  maxWrites: 40,
  maxBytes: 5_242_880,
  ttlMinutes: 60,
  review: 'human',
});
const newTask = async () =>
  (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Other task' })).data.id;
const issueScope = (body = scopeBody()) =>
  request(`/projects/${projectId}/permissions/grants`, 'POST', body);
const startWork = (commandId: string) =>
  request(`/projects/${projectId}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId,
    taskId,
    route: 'codex',
    sources: [],
    consent: true,
  });
async function openNeed() {
  result = {
    text: JSON.stringify({
      summary: 'Create the result',
      changes: [{ path: 'Result.md', text: 'recorded result', summary: 'Result' }],
    }),
    model: 'runtime-model',
  };
  expect(
    (
      await request(`/projects/${projectId}/work/start`, 'POST', {
        taskId,
        route: 'codex',
        consent: true,
        sources: [],
      })
    ).status,
  ).toBe(200);
  let current = await state();
  await vi.waitFor(async () => {
    current = await state();
    expect(current.needs.some((need) => need.state === 'open')).toBe(true);
  });
  return current.needs.find((need) => need.state === 'open')!;
}
const decide = (needId: string, body: unknown) =>
  request(`/projects/${projectId}/needs/${needId}/resolve`, 'POST', body);
const approvalBody = (
  need: ProjectState['needs'][number],
  commandId: string,
  resolution = 'declined',
) => ({
  protocolVersion: 1,
  commandId,
  resolution,
  proposalDigest: need.approval!.proposalDigest,
  actionDigest: need.approval!.actionDigest,
  baseDigest: need.approval!.baseDigest,
});
beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'scope-validation-'));
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
      name: 'Scoped validation',
      description: 'Command namespace checks',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
  result = {
    text: JSON.stringify({
      summary: 'Create the result',
      changes: [{ path: 'Result.md', text: 'recorded result', summary: 'Result' }],
    }),
    model: 'runtime-model',
  };
});
afterEach(async () => {
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('one command namespace for scopes, Work and exact approvals', () => {
  test('scope-first blocks Work reuse of the same command id', async () => {
    const commandId = crypto.randomUUID();
    expect((await issueScope(scopeBody(commandId))).status).toBe(200);
    const replay = await startWork(commandId);
    expect(replay.status).toBe(409);
    expect(replay.data?.code ?? replay.data?.details?.code).toBe('work_command_conflict');
  });

  test('work-first blocks scope reuse of the same command id', async () => {
    const commandId = crypto.randomUUID();
    expect((await startWork(commandId)).status).toBe(200);
    const replay = await issueScope(scopeBody(commandId));
    expect(replay.status).toBe(409);
    expect(replay.data?.code ?? replay.data?.details?.code).toBe('scope_command_conflict');
  });

  test('scope-first blocks exact-approval reuse of the same command id', async () => {
    const commandId = crypto.randomUUID();
    // The scope lives on another task so this task's proposal still waits for review.
    expect((await issueScope(scopeBody(commandId, await newTask()))).status).toBe(200);
    const need = await openNeed();
    const replay = await decide(need.id, approvalBody(need, commandId));
    expect(replay.status).toBe(409);
    expect(replay.data?.code ?? replay.data?.details?.code).toBe('approval_command_conflict');
    expect((await state()).needs.find((item) => item.id === need.id)?.state).toBe('open');
  });

  test('approval-first blocks scope reuse of the same command id', async () => {
    const need = await openNeed();
    const commandId = crypto.randomUUID();
    expect((await decide(need.id, approvalBody(need, commandId))).status).toBe(200);
    const replay = await issueScope(scopeBody(commandId));
    expect(replay.status).toBe(409);
    expect(replay.data?.code ?? replay.data?.details?.code).toBe('scope_command_conflict');
  });

  test('identical replays stay idempotent within each family', async () => {
    const scopeId = crypto.randomUUID();
    const first = await issueScope(scopeBody(scopeId));
    expect(first.status).toBe(200);
    expect((await issueScope(scopeBody(scopeId))).data.grant.id).toBe(first.data.grant.id);
    const workId = crypto.randomUUID();
    const started = await startWork(workId);
    expect(started.status).toBe(200);
    expect((await startWork(workId)).data.id).toBe(started.data.id);
  });
});

describe('strict persisted scope validation fails closed', () => {
  async function appliedScopeSnapshot() {
    expect((await issueScope()).status).toBe(200);
    result = {
      text: JSON.stringify({
        summary: 'Create the result',
        changes: [{ path: 'Result.md', text: 'recorded result', summary: 'Result' }],
      }),
      model: 'runtime-model',
    };
    expect(
      (
        await request(`/projects/${projectId}/work/start`, 'POST', {
          taskId,
          route: 'codex',
          consent: true,
          sources: [],
        })
      ).status,
    ).toBe(200);
    let current = await state();
    await vi.waitFor(async () => {
      current = await state();
      expect(current.sessions.at(-1)?.state).not.toBe('working');
    });
    expect(current.needs.at(-1)?.authorization?.kind).toBe('scope-grant');
    expect(current.needs.at(-1)?.execution?.state).toBe('applied');
    return structuredClone(current);
  }
  test('valid grants and authorizations pass strict validation', async () => {
    const snap = await appliedScopeSnapshot();
    expect(() => validateScopeGrants(snap)).not.toThrow();
    expect(() => validateScopedAuthorization(snap, snap.needs.at(-1)!)).not.toThrow();
  });
  test('forged tenant or issuer on a saved grant fails closed', async () => {
    const snap = await appliedScopeSnapshot();
    const forgedTenant = structuredClone(snap);
    (forgedTenant.scopeGrants![0].grant as unknown as Record<string, unknown>).tenantId = 'forged';
    expect(() => validateScopeGrants(forgedTenant)).toThrow();
    expect(() => validateScopedAuthorization(forgedTenant, forgedTenant.needs.at(-1)!)).toThrow();
    const forgedIssuer = structuredClone(snap);
    (forgedIssuer.scopeGrants![0].grant as unknown as Record<string, string>).issuer =
      undefined as never;
    (forgedIssuer.scopeGrants![0].grant as unknown as Record<string, unknown>).issuer = {
      actor: 'owner',
    };
    expect(() => validateScopeGrants(forgedIssuer)).toThrow();
    expect(() => validateScopedAuthorization(forgedIssuer, forgedIssuer.needs.at(-1)!)).toThrow();
  });
  test('unknown grant version or duplicate scope command fails closed', async () => {
    const snap = await appliedScopeSnapshot();
    const unknownVersion = structuredClone(snap);
    (unknownVersion.scopeGrants![0].grant as unknown as Record<string, unknown>).protocolVersion =
      99;
    expect(() => validateScopeGrants(unknownVersion)).toThrow();
    const duplicated = structuredClone(snap);
    duplicated.scopeGrants!.push({
      ...structuredClone(duplicated.scopeGrants![0]),
      grant: { ...duplicated.scopeGrants![0].grant, id: 'Gduplicate' },
    });
    expect(() => validateScopeGrants(duplicated)).toThrow();
  });
  test('scope command colliding with a Work receipt fails closed', async () => {
    const workId = crypto.randomUUID();
    expect((await startWork(workId)).status).toBe(200);
    expect((await issueScope()).status).toBe(200);
    const snap = structuredClone(await state());
    const collided = structuredClone(snap);
    (collided.scopeGrants!.at(-1)!.grant as unknown as Record<string, unknown>).commandId = workId;
    expect(() => validateScopeGrants(collided)).toThrow();
    expect(() => validateWorkReceipts(collided)).toThrow();
  });
  test('tampered scoped authorization cannot authorize', async () => {
    const snap = await appliedScopeSnapshot();
    const badDigest = structuredClone(snap);
    (badDigest.needs.at(-1)!.authorization as unknown as Record<string, unknown>).grantDigest =
      'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    expect(() => validateScopedAuthorization(badDigest, badDigest.needs.at(-1)!)).toThrow();
    const overBudget = structuredClone(snap);
    (overBudget.needs.at(-1)!.authorization as unknown as Record<string, unknown>).writes = 999;
    expect(() => validateScopedAuthorization(overBudget, overBudget.needs.at(-1)!)).toThrow();
    const declined = structuredClone(snap);
    (declined.needs.at(-1) as unknown as Record<string, unknown>).execution = {
      state: 'declined',
      eventId: null,
      completedAt: new Date().toISOString(),
      reason: null,
      conflicts: [],
    };
    expect(() => validateScopedAuthorization(declined, declined.needs.at(-1)!)).toThrow();
    const revoked = structuredClone(snap);
    revoked.scopeGrants![0].generation = 1;
    revoked.scopeGrants![0].revokedAt = new Date().toISOString();
    // Revocation is retained history, not corruption: load validation passes.
    expect(() => validateScopeGrants(revoked)).not.toThrow();
    expect(() => validateScopedAuthorization(revoked, revoked.needs.at(-1)!)).not.toThrow();
  });

  test('a revoked grant refuses writes at effect time without reporting corruption', async () => {
    await appliedScopeSnapshot();
    const store = app.locals.store;
    const liveNeed = store.state(projectId).needs.at(-1)!;
    await store.scopeGrants.revoke(projectId, store.state(projectId).scopeGrants![0].grant.id);
    await expect(store.scopeGrants.assertCurrent(projectId, liveNeed, [])).rejects.toMatchObject({
      details: { code: 'scope_not_authorized' },
    });
  });
});
