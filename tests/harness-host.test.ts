import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { Store, hash } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { localHarnessPrincipal } from '../server/harness/bridge.js';
import { identifyHarnessApproval, REPORT_PATH } from '../server/harness/approval.js';
import { validateApprovalReceipts } from '../server/approval-admission.js';
import type { ApprovalCommand, Need, Session } from '../shared/types.js';
import type { HarnessEvent, HarnessRun } from '../shared/harness.js';

let root: string, projectId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const store = (): Store => app.locals.store;
const host = (): HarnessHost => app.locals.harness;
const state = () => store().state(projectId);
const runFile = (runId: string) =>
  path.join(root, 'data', 'projects', projectId, 'harness', 'runs', `${runId}.json`);
async function open() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
}
async function request<T>(
  route: string,
  method = 'GET',
  body?: unknown,
  customHeaders: Record<string, string> = headers,
) {
  const response = await fetch(`${url}/api/projects/${projectId}${route}`, {
    method,
    headers: customHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
function command(
  need: Need,
  resolution: ApprovalCommand['resolution'] = 'go-ahead',
): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId: `decision-${need.id}`,
    resolution,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
const resolve = (need: Need, decision = command(need)) =>
  request<Need>(`/needs/${need.id}/resolve`, 'POST', decision);
async function ready() {
  const session = await host().bridge.startNativeRun(
    projectId,
    null,
    'format-report',
    'Format the shipped fixture.',
    localHarnessPrincipal(projectId),
  );
  // A native run reads the project, resolves instructions and proposes before
  // its Need opens; CI's two-worker run takes over a second for that, so the
  // wait is bounded generously rather than by vi.waitFor's 1 s default.
  await vi.waitFor(
    () =>
      expect(
        state().needs.some((need) => need.sessionId === session.id && need.state === 'open'),
      ).toBe(true),
    { timeout: 15_000 },
  );
  return structuredClone(
    state().needs.find((need) => need.sessionId === session.id && need.state === 'open')!,
  );
}
async function untilRun(runId: string, expected: HarnessRun['state']) {
  await vi.waitFor(async () => expect((await host().get(projectId, runId)).state).toBe(expected), {
    timeout: 15_000,
  });
  await host().bridge.flush();
  return host().get(projectId, runId);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-harness-host-'));
  await open();
  const project = await store().locked(() => store().createProject('Harness fixture'));
  projectId = project.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('native harness through the real host', () => {
  test('one Session, exact Need, recorded write, receipt replay, and reconnect cursor survive reopening', async () => {
    const writer = vi.spyOn(store(), 'writeRecorded');
    const need = await ready();
    const runId = need.harness!.runId;
    const waiting = await host().get(projectId, runId);
    expect(state().sessions).toHaveLength(1);
    expect(state().tasks).toHaveLength(1);
    expect(need.preview).toEqual([]);
    expect(need.approval!.actionDigest).toBe(
      waiting.steps.find((step) => step.state === 'waiting_approval')!.intentHash,
    );
    expect(Date.parse(need.approval!.expiresAt) - Date.parse(need.createdAt)).toBe(3600000);
    expect(state().sessions[0]).toMatchObject({
      state: 'waiting',
      sample: false,
      permission: 'show-first',
      engine: { name: 'native-fixture' },
    });
    expect(state().tasks[0]).toMatchObject({ state: 'waiting', reason: 'needs-ok' });
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
    const cursor = waiting.lastSeq;
    expect((await resolve(need)).status).toBe(200);
    const run = await untilRun(runId, 'completed');
    expect(state().sessions[0].state).toBe('done');
    expect(state().tasks[0].state).toBe('done');
    expect(writer).toHaveBeenCalledTimes(1);
    expect(await store().current(projectId, REPORT_PATH)).toBe(
      '# Fixture report\n\n- Inspect the saved report\n- Review the exact change\n- Keep the recorded result\n',
    );
    const savedNeed = state().needs.find((item) => item.id === need.id)!;
    const entry = state().history.find((item) => item.id === savedNeed.execution!.eventId)!;
    expect(entry).toMatchObject({
      kind: 'changed',
      approvalId: need.id,
      sessionId: need.sessionId,
      taskId: need.taskId,
    });
    expect(entry.label).toMatch(/^[a-f0-9]{64}$/);
    expect(savedNeed.execution!.state).toBe('applied');
    expect(run.approvals[0]).toMatchObject({
      principalId: 'local-client',
      intentHash: need.approval!.actionDigest,
      decision: 'approved',
    });
    expect(Date.parse(run.approvals[0].expiresAt)).toBeLessThanOrEqual(
      Date.parse(need.approval!.expiresAt),
    );
    expect(
      state().sessions[0].log.filter(
        (line) => line.level === 'technical' && line.sentence.startsWith('{'),
      ),
    ).toHaveLength(run.events.length);
    expect(state().sessions[0].log.some((line) => line.sentence.startsWith('Before step'))).toBe(
      true,
    );
    validateApprovalReceipts(state());
    expect((await resolve(need)).data.approvalReceipt).toEqual(savedNeed.approvalReceipt);
    expect(writer).toHaveBeenCalledTimes(1);
    const events = await request<{ events: HarnessEvent[]; lastSeq: number }>(
      `/harness/runs/${runId}/events?after=${cursor}`,
    );
    expect(events.status).toBe(200);
    expect(events.data.events.every((event) => event.v === 1 && event.seq > cursor)).toBe(true);
    expect(events.data.events.at(-1)!.type).toBe('run.completed');
    await close();
    await open();
    const reconnected = await request(`/harness/runs/${runId}/events?after=${cursor}`);
    expect(reconnected.data).toEqual(events.data);
    expect((await resolve(need)).data.approvalReceipt).toEqual(savedNeed.approvalReceipt);
    expect(state().history.filter((item) => item.label === entry.label)).toHaveLength(1);
  });

  test('an unanswered Need remains resolvable after service restart', async () => {
    const need = await ready();
    await close();
    await open();
    expect(state().needs.find((item) => item.id === need.id)!.state).toBe('open');
    expect(state().sessions[0].state).toBe('waiting');
    expect((await resolve(need)).status).toBe(200);
    await untilRun(need.harness!.runId, 'completed');
  });

  test('expired approval is refused and the run remains waiting', async () => {
    const original = await ready();
    await store().locked(async () => {
      const need = state().needs.find((item) => item.id === original.id)!;
      need.createdAt = new Date(Date.now() - 3600001).toISOString();
      need.approval = identifyHarnessApproval(projectId, need);
      await store().persist(state());
    });
    const need = structuredClone(state().needs.find((item) => item.id === original.id)!);
    const result = await resolve(need);
    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({ code: 'approval_expired' });
    expect((await host().get(projectId, need.harness!.runId)).state).toBe('waiting');
    expect(state().needs.find((item) => item.id === need.id)!.approvalReceipt).toBeUndefined();
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
  });

  test('declining cancels the run, persists the single decision, and writes no report', async () => {
    const need = await ready();
    expect((await resolve(need, command(need, 'declined'))).status).toBe(200);
    await untilRun(need.harness!.runId, 'cancelled');
    expect(state().sessions[0].state).toBe('stopped');
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
    validateApprovalReceipts(state());
    await close();
    await open();
    expect(state().needs[0].execution!.state).toBe('declined');
  });

  test('API start uses the bridge and both native and existing Work starts refuse a second active run', async () => {
    const input = {
      capabilityId: 'format-report',
      taskId: null,
      instruction: 'Format the fixture.',
    };
    const started = await request<Session>('/work/start', 'POST', input);
    expect(started.status).toBe(200);
    expect(started.data.sample).toBe(false);
    expect((await request('/work/start', 'POST', input)).status).toBe(409);
    expect(
      (await request('/work/start', 'POST', { taskId: started.data.taskId, route: 'sample' }))
        .status,
    ).toBe(409);
    expect(state().sessions).toHaveLength(1);
  });

  test('a newer run version cannot break app startup or overwrite the run file', async () => {
    const need = await ready();
    await close();
    const file = runFile(need.harness!.runId);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as HarnessRun;
    const bytes = JSON.stringify({ ...saved, v: 2 });
    await fs.writeFile(file, bytes);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await open();
    expect((await request(`/harness/runs/${saved.id}`)).status).toBe(409);
    expect((await request('/harness/runs')).data).toEqual({ runs: [] });
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect(warning).toHaveBeenCalled();
    expect(state().sessions[0].state).toBe('failed');
  });

  test('routes validate the cursor, enforce project scope and client header, and cancel through the person principal', async () => {
    const need = await ready();
    const runId = need.harness!.runId;
    expect((await request(`/harness/runs/${runId}/events?after=-1`)).status).toBe(400);
    expect((await request(`/harness/runs/${runId}/events?after=1.5`)).status).toBe(400);
    expect(
      (
        await request(
          `/harness/runs/${runId}/cancel`,
          'POST',
          {},
          { 'Content-Type': 'application/json' },
        )
      ).status,
    ).toBe(403);
    const other = await store().locked(() => store().createProject('Other fixture'));
    const wrong = await fetch(`${url}/api/projects/${other.id}/harness/runs/${runId}`);
    expect(wrong.status).toBe(404);
    await expect(
      host().runs.cancel(runId, 'wrong scope', localHarnessPrincipal(other.id)),
    ).rejects.toThrow(/project mismatch/);
    expect(
      (await request(`/harness/runs/${runId}/cancel`, 'POST', { reason: 'Stop this fixture.' }))
        .status,
    ).toBe(200);
    expect(state().sessions[0].state).toBe('stopped');
    expect((await resolve(need)).status).toBe(409);
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
  });

  test.each(['step', 'null', 'scope'])(
    'a malformed %s record cannot break startup and is not rewritten',
    async (kind) => {
      const need = await ready();
      await close();
      const file = runFile(need.harness!.runId);
      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as HarnessRun;
      const bytes = JSON.stringify(
        kind === 'null'
          ? null
          : kind === 'step'
            ? { ...saved, steps: [null] }
            : { ...saved, principal: { ...saved.principal, projectId: 'wrong-project' } },
      );
      await fs.writeFile(file, bytes);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await open();
      const response = await request(`/harness/runs/${saved.id}`);
      expect(response.status).toBe(409);
      expect(response.data).toMatchObject({ code: 'invalid_run_record' });
      expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    },
  );

  test('a failed initial claim cannot be revived by a queued mirror or a restart', async () => {
    vi.spyOn(host().runs, 'claim').mockRejectedValueOnce(new Error('Synthetic claim failure.'));
    await expect(
      host().bridge.startNativeRun(
        projectId,
        null,
        'format-report',
        'Format the fixture.',
        localHarnessPrincipal(projectId),
      ),
    ).rejects.toThrow(/claim failure/);
    await host().bridge.flush();
    expect(state().sessions[0].state).toBe('stopped');
    const [run] = await host().list(projectId);
    expect(run.state).toBe('cancelled');
    await close();
    await open();
    expect(state().sessions[0].state).toBe('stopped');
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
  });

  test('a listing that started before run creation cannot erase the new run lookup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.spyOn(FileRunStore.prototype, 'list').mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const listing = host().list(projectId);
    const session = await host().bridge.startNativeRun(
      projectId,
      null,
      'format-report',
      'Format the fixture.',
      localHarnessPrincipal(projectId),
    );
    const dir = path.join(root, 'data', 'projects', projectId, 'harness', 'runs');
    const file = (await fs.readdir(dir)).find((name) => name.endsWith('.json'))!;
    release();
    await listing;
    await expect(host().runs.get(file.slice(0, -5))).resolves.toMatchObject({
      sessionId: session.id,
    });
  });

  test('duplicate run ids are refused without breaking unrelated project startup', async () => {
    const need = await ready();
    const other = await store().locked(() => store().createProject('Duplicate fixture'));
    await close();
    const source = runFile(need.harness!.runId);
    const target = path.join(
      root,
      'data',
      'projects',
      other.id,
      'harness',
      'runs',
      `${need.harness!.runId}.json`,
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await open();
    const response = await request(`/harness/runs/${need.harness!.runId}`);
    expect(response.status).toBe(409);
    expect(response.data).toMatchObject({ code: 'duplicate_run' });
    expect((await request('/harness/runs')).data).toEqual({ runs: [] });
    expect(await fs.readFile(target, 'utf8')).toBe(await fs.readFile(source, 'utf8'));
    const third = await store().locked(() => store().createProject('Independent fixture'));
    const session = await host().bridge.startNativeRun(
      third.id,
      null,
      'format-report',
      'Format the fixture.',
      localHarnessPrincipal(third.id),
    );
    await vi.waitFor(
      () =>
        expect(
          store()
            .state(third.id)
            .sessions.find((item) => item.id === session.id)!.state,
        ).toBe('waiting'),
      { timeout: 15_000 },
    );
  });

  test.skipIf(process.platform !== 'win32')(
    'atomic run replacement retries a transient lock and surfaces a permanent failure',
    async () => {
      const need = await ready();
      const run = await host().get(projectId, need.harness!.runId);
      const original = fs.rename.bind(fs);
      let attempts = 0;
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === runFile(run.id) && attempts++ === 0)
          throw Object.assign(new Error('Synthetic sharing violation.'), { code: 'EPERM' });
        await original(from, to);
      });
      await host().runs.claim(run.id, run.owner!);
      await host().bridge.flush();
      expect(attempts).toBe(2);
      const prior = await fs.readFile(runFile(run.id), 'utf8');
      attempts = 0;
      rename.mockImplementation(async (from, to) => {
        if (String(to) === runFile(run.id)) {
          attempts++;
          throw Object.assign(new Error('Synthetic permanent permission failure.'), {
            code: 'EPERM',
          });
        }
        await original(from, to);
      });
      await expect(host().runs.claim(run.id, run.owner!)).rejects.toThrow(/permanent permission/);
      expect(attempts).toBe(6);
      expect(await fs.readFile(runFile(run.id), 'utf8')).toBe(prior);
    },
  );

  test('outside edits invalidate the exact write and remain untouched', async () => {
    const need = await ready();
    await fs.writeFile(path.join(state().project.folder, REPORT_PATH), 'Outside content.');
    expect((await resolve(need)).status).toBe(200);
    await untilRun(need.harness!.runId, 'failed');
    expect(await store().current(projectId, REPORT_PATH)).toBe('Outside content.');
    expect(state().history.filter((entry) => entry.kind === 'changed')).toHaveLength(0);
    expect(state().needs[0].execution!.state).toBe('not-applied');
    validateApprovalReceipts(state());
  });

  test('changed identity is refused and the existing Session stop route cancels the harness', async () => {
    const need = await ready();
    expect((await resolve(need, { ...command(need), actionDigest: '0'.repeat(64) })).status).toBe(
      409,
    );
    expect((await host().get(projectId, need.harness!.runId)).state).toBe('waiting');
    const response = await request<Session>(`/work/${need.sessionId}/stop`, 'POST', {});
    expect(response.status).toBe(200);
    expect(response.data.state).toBe('stopped');
    await host().bridge.flush();
    expect((await host().get(projectId, need.harness!.runId)).state).toBe('cancelled');
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
  });

  test('thread permission is mirrored while the fixture still requires exact approval', async () => {
    const task = await store().locked(async () => {
      const task = store().createTask(state(), { name: 'Thread fixture' });
      await store().persist(state());
      return task;
    });
    const thread = await request<{ id: string }>('/threads', 'POST', { taskId: task.id });
    expect(thread.status).toBe(201);
    await store().locked(async () => {
      state().conversations.find((item) => item.id === thread.data.id)!.permission = 'task';
      await store().persist(state());
    });
    const session = await host().bridge.startNativeRun(
      projectId,
      task.id,
      'format-report',
      'Format a fixture.',
      localHarnessPrincipal(projectId),
    );
    expect(session.permission).toBe('task');
    await vi.waitFor(
      () => expect(state().needs.some((need) => need.sessionId === session.id)).toBe(true),
      { timeout: 15_000 },
    );
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
  });

  test('unknown effects stay waiting for reconciliation across failure, completion, restart, and cancellation', async () => {
    const need = await ready();
    const run = await host().get(projectId, need.harness!.runId);
    await expect(
      host().runs.step(
        run.id,
        run.owner!,
        { id: 'uncertain', version: 'v1', effect: 'non-idempotent' },
        () => {
          throw new Error('Synthetic lost effect acknowledgement.');
        },
        localHarnessPrincipal(projectId),
      ),
    ).rejects.toThrow(/lost effect/);
    expect((await host().get(projectId, run.id)).state).toBe('reconcile_required');
    expect(state().sessions[0].state).toBe('waiting');
    expect(state().tasks[0]).toMatchObject({ state: 'waiting', reason: 'went-wrong' });
    expect(
      state().sessions[0].log.some((line) => line.sentence.includes('Check before starting again')),
    ).toBe(true);
    await expect(host().runs.complete(run.id, run.owner!, { text: 'wrong' })).rejects.toThrow(
      /reconciliation/,
    );
    await host().runs.fail(run.id, run.owner!, new Error('later failure'));
    await close();
    await open();
    expect((await host().get(projectId, run.id)).state).toBe('reconcile_required');
    expect(state().sessions[0].state).toBe('waiting');
    expect(
      (await request('/work/start', 'POST', { taskId: need.taskId, route: 'sample' })).status,
    ).toBe(409);
    expect((await request(`/harness/runs/${run.id}/cancel`, 'POST', {})).status).toBe(200);
    expect(state().sessions[0].state).toBe('stopped');
    expect(state().tasks[0].reason).toBe('went-wrong');
    expect(await store().current(projectId, REPORT_PATH)).toBeNull();
  });

  test('secret scrubber covers durable errors, event mirrors, and returned run records', async () => {
    const token = 'synthetic-harness-secret-123';
    host().rememberSecret(token);
    const tool = host().tools.get('read_fixture');
    vi.spyOn(tool, 'execute').mockImplementation(() => {
      const error = new Error(`Synthetic error ${token}`);
      error.name = token;
      throw error;
    });
    const session = await host().bridge.startNativeRun(
      projectId,
      null,
      'format-report',
      'Read a fixture.',
      localHarnessPrincipal(projectId),
    );
    await vi.waitFor(
      () => expect(state().sessions.find((item) => item.id === session.id)!.state).toBe('failed'),
      { timeout: 15_000 },
    );
    const [run] = await host().list(projectId);
    expect(await fs.readFile(runFile(run.id), 'utf8')).not.toContain(token);
    expect(JSON.stringify(state().sessions)).not.toContain(token);
    expect(run.failure!.message).toContain('[redacted]');
    // Provider transcript contents are not read; the route returns a scrubbed opaque reference.
    await host().runs.recordTranscript(run.id, run.owner!, 'fixture', {
      providerId: 'fixture',
      modelId: null,
      lineageId: 'fixture-lineage',
      opaqueRef: token,
      prefixHash: hash('prefix')!,
    });
    const response = await request<HarnessRun>(`/harness/runs/${run.id}`);
    expect(JSON.stringify(response.data)).not.toContain(token);
    expect(response.data.transcripts.fixture.opaqueRef).toBe('[redacted]');
  });

  test.each(['after-decision', 'journal', 'after-write'])(
    'abrupt exit at %s recovers the Store first and commits the harness observation once',
    async (phase) => {
      await close();
      const output: string[] = [];
      const code = await new Promise<number | null>((done, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tests/harness-host-child.ts', root, projectId, phase],
          { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout.on('data', (chunk) => output.push(String(chunk)));
        child.stderr.on('data', (chunk) => output.push(String(chunk)));
        child.on('error', reject);
        child.on('close', done);
      });
      expect(code, output.join('')).toBe(17);
      const runId = await fs.readFile(path.join(root, 'crash-run.txt'), 'utf8');
      await open();
      const run = await untilRun(runId, 'completed');
      expect(state().history.filter((entry) => entry.kind === 'changed')).toHaveLength(1);
      expect(state().needs.filter((need) => need.approvalReceipt)).toHaveLength(1);
      expect(state().needs[0].execution!.state).toBe('applied');
      expect(run.steps.find((step) => step.intent.name === 'propose_write')!.state).toBe(
        'succeeded',
      );
      expect(run.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(await fs.readdir(path.join(root, 'data', 'pending'))).toEqual([]);
      validateApprovalReceipts(state());
      await close();
      await open();
      expect((await host().get(projectId, runId)).lastSeq).toBe(run.lastSeq);
      expect(state().history.filter((entry) => entry.kind === 'changed')).toHaveLength(1);
    },
  );
});
