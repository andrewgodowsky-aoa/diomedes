import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { hash, Store } from '../server/store.js';
import { parseWorkCommand, MAX_WORK_RECEIPTS } from '../server/work-admission.js';
import type { Need, ProjectState, Session, Task } from '../shared/types.js';

const original = '\ufeff# Brief\r\n\r\nSynthetic before bytes.\r\n';
const revised = `${original}Reviewed addition.\r\n`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let generate: ReturnType<typeof vi.fn<NativeGenerator>>;
const proposal = () => ({
  model: 'deterministic-fixture',
  version: 'fixture-1',
  text: JSON.stringify({
    summary: 'Append a reviewed sentence.',
    changes: [{ path: 'Brief.md', text: revised, summary: 'One additional sentence.' }],
  }),
});
async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    stepMs: 20,
    nativeGenerator: generate,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
}
async function request<T>(
  route: string,
  method = 'GET',
  body?: unknown,
  customHeaders: Record<string, string> = headers,
) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: customHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const store = (): Store => app.locals.store;
const current = () => store().state(projectId);
const command = (commandId = 'one-command') => ({
  protocolVersion: 1,
  commandId,
  taskId,
  route: 'codex',
  sources: ['Brief.md'],
  consent: true,
});
const start = (body: unknown = command()) =>
  request<Session>(`/projects/${projectId}/work/start`, 'POST', body);
const receipt = (commandId = 'one-command') =>
  request<Session>(`/projects/${projectId}/work/commands/${commandId}`);
const approval = (need: Need) => ({
  protocolVersion: 1, commandId: crypto.randomUUID(), resolution: 'go-ahead',
  proposalDigest: need.approval!.proposalDigest, actionDigest: need.approval!.actionDigest,
  baseDigest: need.approval!.baseDigest,
});
async function until(predicate: (state: ProjectState) => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate(current())) return current();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Work did not reach the expected state.');
}
beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'admission-'));
  generate = vi.fn(async () => proposal());
  await launch();
  projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Admission fixture' }))
    .data.id;
  await request(`/projects/${projectId}/documents/create`, 'POST', {
    path: 'Brief.md',
    text: original,
  });
  taskId = (
    await request<Task>(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Append a sentence',
      owner: 'diomedes-with-ok',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

describe('durable task Work admission', () => {
  test('common admission extraction preserves the original v1 Work digest bytes', () => {
    expect(parseWorkCommand({ protocolVersion: 1, commandId: 'stable', taskId: 'T1', route: 'codex', sources: ['Brief.md'], consent: true })?.admission.payloadDigest)
      .toBe('sha256:40eb4c504896f33392a678f086f10cbea5689b629701ab2df1ee6b728d7bc4a5');
  });

  test.each(['sample', 'codex'] as const)(
    'failed %s admission persistence returns no phantom receipt',
    async (route) => {
      const persist = store().persist.bind(store());
      const diskFailure = vi.spyOn(store(), 'persist').mockImplementation(async (state) => {
        if (state.sessions.some((session) => session.receipt))
          throw new Error('Synthetic disk full.');
        await persist(state);
      });
      const body = { ...command(), route };
      expect((await start(body)).status).toBe(500);
      expect((await receipt()).status).toBe(404);
      expect(current().sessions).toHaveLength(0);
      expect(generate).not.toHaveBeenCalled();
      diskFailure.mockRestore();
      const retried = await start(body);
      expect(retried.status).toBe(200);
      expect(retried.data.receipt?.commandId).toBe(body.commandId);
      expect(current().sessions).toHaveLength(1);
      expect(generate).toHaveBeenCalledTimes(route === 'codex' ? 1 : 0);
    },
  );

  test('concurrent identical starts, reload and retry have one run and the same receipt', async () => {
    const [a, b] = await Promise.all([
      start(),
      start({
        consent: true,
        sources: ['Brief.md'],
        taskId,
        commandId: 'one-command',
        route: 'codex',
        protocolVersion: 1,
      }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.data.receipt).toEqual(b.data.receipt);
    expect(a.data.receipt).toMatchObject({
      protocolVersion: 1,
      projectId,
      taskId,
      sessionId: a.data.id,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(current().sessions).toHaveLength(1);
    expect(current().history.filter((e) => e.kind === 'work-admitted')).toHaveLength(1);
    expect((await receipt()).data.receipt).toEqual(a.data.receipt);
    const changed = await start({ ...command(), instruction: 'Different action' });
    expect(changed.status).toBe(409);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await store().current(projectId, 'Brief.md')).toBe(original);
  });

  test('the adapter observes the receipt, session, permission and event already on disk', async () => {
    const thread = (
      await request<{ id: string }>(`/projects/${projectId}/threads`, 'POST', {
        name: 'Task thread',
        permission: 'task',
      })
    ).data;
    let persisted: ProjectState | undefined;
    generate.mockImplementation(async () => {
      persisted = JSON.parse(
        await fs.readFile(store().statePath(projectId), 'utf8'),
      ) as ProjectState;
      return proposal();
    });
    const result = await start({ ...command(), threadId: thread.id });
    await until((s) => s.sessions[0]?.state === 'waiting');
    expect(result.status).toBe(200);
    expect(persisted?.sessions[0].permission).toBe('task');
    expect(persisted?.sessions[0].receipt).toEqual(result.data.receipt);
    expect(persisted?.history.find((e) => e.id === result.data.receipt?.eventId)).toMatchObject({
      kind: 'work-admitted',
      sessionId: result.data.id,
    });
    expect(persisted?.tasks[0].sessionIds).toContain(result.data.id);
  });

  test.each([
    { protocolVersion: 2 },
    { commandId: '' },
    { commandId: 'x'.repeat(129) },
    { actor: 'owner' },
    { userId: 'owner' },
    { unknown: true },
    { consent: 'true' },
    { sources: ['../secret.md'] },
    { sources: ['Brief.md', 'brief.md'] },
    { route: 'cloud' },
    { instruction: 3 },
    { sources: 'Brief.md' },
  ])('rejects invalid versioned inputs before admission: %j', async (change) => {
    const result = await start({ ...command(), ...change });
    expect([400, 403, 409]).toContain(result.status);
    expect(generate).not.toHaveBeenCalled();
    expect(current().sessions).toHaveLength(0);
    expect(current().history.some((e) => e.kind === 'work-admitted')).toBe(false);
  });

  test('rejects cross-project tasks, threads, receipt access and unauthorized browser origins', async () => {
    const other = (await request<{ id: string }>('/projects', 'POST', { name: 'Other scope' })).data
      .id;
    // Task ids are local to a project (T1, T2, ...). T1 in each project is a
    // different valid scoped reference, so use a task absent from this project.
    await request(`/projects/${other}/tasks`, 'POST', { name: 'First other task' });
    const foreignTask = (
      await request<Task>(`/projects/${other}/tasks`, 'POST', { name: 'Other task' })
    ).data.id;
    const foreignThread = (
      await request<{ id: string }>(`/projects/${other}/threads`, 'POST', { name: 'Other thread' })
    ).data.id;
    expect((await start({ ...command(), taskId: foreignTask })).status).toBe(404);
    expect((await start({ ...command(), threadId: foreignThread })).status).toBe(404);
    expect(
      (
        await request(`/projects/${projectId}/work/start`, 'POST', command(), {
          ...headers,
          Origin: 'https://untrusted.invalid',
        })
      ).status,
    ).toBe(403);
    expect(generate).not.toHaveBeenCalled();
    await start();
    expect((await request(`/projects/${other}/work/commands/one-command`)).status).toBe(404);
  });

  test('rechecks service enablement and consent before a cached response', async () => {
    const accepted = await start();
    expect((await start({ ...command(), consent: false })).status).toBe(409);
    await request('/settings', 'PUT', { services: { codex: false } });
    expect((await start()).status).toBe(409);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await receipt()).data.receipt).toEqual(accepted.data.receipt);
  });

  test('legacy clients work; versioned sample work also deduplicates', async () => {
    const sample = { ...command(), route: 'sample', sources: [], consent: false };
    const [a, b] = await Promise.all([start(sample), start(sample)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.data.receipt).toEqual(b.data.receipt);
    expect(current().sessions).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
    await request(`/projects/${projectId}/work/${a.data.id}/stop`, 'POST', {});
    const old = await start({ taskId, route: 'sample' });
    expect(old.status).toBe(200);
    expect(old.data.receipt).toBeUndefined();
  });

  test('the admitted native path previews, approves once, writes and restores exact bytes without Git', async () => {
    const accepted = await start();
    const waiting = await until((s) => s.needs.some((n) => n.state === 'open'));
    const need = waiting.needs.find((n) => n.state === 'open')!;
    expect(need.preview?.[0].before).toBe(original);
    expect(need.preview?.[0].after).toBe(revised);
    expect(await store().current(projectId, 'Brief.md')).toBe(original);
    const decide = () =>
      request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', approval(need));
    const decisions = await Promise.all([decide(), decide()]);
    expect(decisions.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await fs.readFile(path.join(current().project.folder, 'Brief.md'))).toEqual(
      Buffer.from(revised),
    );
    const entry = current().history.find(
      (e) => e.sessionId === accepted.data.id && e.kind === 'changed',
    )!;
    expect(entry.files).toHaveLength(1);
    await fs.writeFile(path.join(current().project.folder, 'Brief.md'), 'Newer user edit');
    expect(
      (await request(`/projects/${projectId}/history/${entry.id}/restore`, 'POST', {})).status,
    ).toBe(409);
    expect(await store().current(projectId, 'Brief.md')).toBe('Newer user edit');
    expect(
      (await request(`/projects/${projectId}/history/${entry.id}/restore`, 'POST', { mode: 'all' }))
        .status,
    ).toBe(200);
    expect(await fs.readFile(path.join(current().project.folder, 'Brief.md'))).toEqual(
      Buffer.from(original),
    );
    expect(current().history.some((e) => e.kind === 'restore' && e.restoreOf === entry.id)).toBe(
      true,
    );
    await close();
    await launch();
    const replay = await start();
    expect(replay.data.receipt).toEqual(accepted.data.receipt);
    expect(replay.data.state).toBe('done');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('stale approval preserves a newer file; the command still identifies the failed run', async () => {
    const accepted = await start();
    const waiting = await until((s) => s.needs.some((n) => n.state === 'open'));
    await fs.writeFile(path.join(current().project.folder, 'Brief.md'), 'Newer user edit');
    const result = await request(
      `/projects/${projectId}/needs/${waiting.needs[0].id}/resolve`,
      'POST',
      approval(waiting.needs[0]),
    );
    expect(result.status).toBe(409);
    expect(await store().current(projectId, 'Brief.md')).toBe('Newer user edit');
    expect((await start()).data).toMatchObject({ state: 'failed', receipt: accepted.data.receipt });
  });

  test('cancel prevents a late proposal and releases the project for a different command', async () => {
    let resolve!: (value: Awaited<ReturnType<NativeGenerator>>) => void;
    const pending = new Promise<Awaited<ReturnType<NativeGenerator>>>((done) => {
      resolve = done;
    });
    generate.mockImplementationOnce(async () => pending);
    const accepted = await start();
    await request(`/projects/${projectId}/work/${accepted.data.id}/stop`, 'POST', {});
    expect(generate.mock.calls[0][0].signal?.aborted).toBe(true);
    const second = await start(command('another-command'));
    expect(second.status).toBe(200);
    resolve(proposal());
    await until((s) => s.sessions[1]?.state === 'waiting');
    expect(current().needs.filter((n) => n.sessionId === accepted.data.id)).toHaveLength(0);
    expect((await start()).data.state).toBe('stopped');
    expect(await store().current(projectId, 'Brief.md')).toBe(original);
  });

  test.each(['before', 'admitted', 'dispatched'] as const)(
    'abrupt process exit %s admission recovers without unsafe redispatch',
    async (phase) => {
      await close();
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tests/work-admission-child.ts', root, projectId, taskId, phase],
          {
            cwd: process.cwd(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stderr = '';
        child.stderr.on('data', (data) => {
          stderr += String(data).slice(0, 4000);
        });
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`Crash fixture timeout: ${stderr}`));
        }, 15_000);
        child.once('error', reject);
        child.once('exit', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(exit).toBe(phase === 'before' ? 70 : phase === 'admitted' ? 71 : 72);
      const disk = JSON.parse(
        await fs.readFile(path.join(root, 'data', 'projects', projectId, 'state.json'), 'utf8'),
      ) as ProjectState;
      const saved = disk.sessions[0]?.receipt;
      expect(Boolean(saved)).toBe(phase !== 'before');
      await launch();
      const replay = await start(command('crash-command'));
      expect(replay.status).toBe(200);
      if (phase === 'before') expect(generate).toHaveBeenCalledTimes(1);
      else {
        expect(generate).not.toHaveBeenCalled();
        expect(replay.data).toMatchObject({ state: 'stopped', needId: null, receipt: saved });
        expect(current().project.counts.running).toBe(0);
        expect(current().tasks[0].state).toBe('todo');
        expect(current().history.filter((e) => e.kind === 'work-admitted')).toHaveLength(1);
      }
      expect(await store().current(projectId, 'Brief.md')).toBe(original);
    },
  );

  test('receipt replays perform no folder listing, document read, adapter call or persistence', async () => {
    await start();
    await until((s) => s.sessions[0]?.state === 'waiting');
    const listing = vi.spyOn(store(), 'listDocuments');
    const document = vi.spyOn(store(), 'current');
    const persist = vi.spyOn(store(), 'persist');
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => start()));
    const elapsed = performance.now() - started;
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(listing).not.toHaveBeenCalled();
    expect(document).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    console.log(
      `Work admission replay: 50 requests in ${elapsed.toFixed(1)} ms; no scans or writes.`,
    );
  });

  test('restart expires an unapproved proposal while retaining its original receipt', async () => {
    const accepted = await start();
    await until((s) => s.sessions[0]?.state === 'waiting');
    // In-memory waiting precedes the async durable write. Capture a genuinely
    // saved proposal, not the earlier admission bytes that happen to be on disk.
    let snapshot!: Buffer;
    await vi.waitFor(async () => {
      snapshot = await fs.readFile(store().statePath(projectId));
      expect(JSON.parse(snapshot.toString('utf8')).needs[0]?.state).toBe('open');
    });
    await close();
    // Restore the last running-process bytes to emulate loss without a clean close.
    await fs.writeFile(path.join(root, 'data', 'projects', projectId, 'state.json'), snapshot);
    await launch();
    expect((await start()).data).toMatchObject({
      state: 'stopped',
      receipt: accepted.data.receipt,
    });
    const need = current().needs[0];
    expect(need.state).toBe('expired');
    expect(
      (
        await request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', approval(need))
      ).status,
    ).toBe(409);
    expect(await store().current(projectId, 'Brief.md')).toBe(original);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test.each(['prepared', 'applied', 'finalized'] as const)(
    'recovers the file journal at %s while keeping receipt and history consistent',
    async (phase) => {
      const accepted = await start();
      await until((s) => s.sessions[0]?.state === 'waiting');
      const intended = structuredClone(current());
      const entry = store().addEntry(intended, {
        kind: 'changed',
        sessionId: accepted.data.id,
        taskId,
        actor: 'diomedes-with-ok',
        sentence: 'Synthetic approved journal boundary.',
      });
      entry.files = [
        {
          path: 'Brief.md',
          op: 'modified',
          before: hash(original),
          after: hash(revised),
          recorded: true,
          reason: null,
        },
      ];
      await fs.writeFile(store().objectPath(projectId, hash(revised)!), revised);
      const pending = path.join(root, 'data', 'pending', 'admission-boundary.json');
      const journal = {
        id: 'admission-boundary',
        projectId,
        writes: [{ path: 'Brief.md', before: hash(original), after: hash(revised) }],
        state: intended,
      };
      const target = path.join(current().project.folder, 'Brief.md');
      await close();
      if (phase !== 'prepared') await fs.writeFile(target, revised);
      if (phase === 'finalized')
        await fs.writeFile(
          path.join(root, 'data', 'projects', projectId, 'state.json'),
          JSON.stringify(intended),
        );
      await fs.writeFile(pending, JSON.stringify(journal));
      await launch();
      expect(await fs.readFile(target)).toEqual(Buffer.from(revised));
      expect((await receipt()).data.receipt).toEqual(accepted.data.receipt);
      expect(current().history.filter((e) => e.id === entry.id)).toHaveLength(1);
      expect(current().sessions[0].state).toBe('stopped');
      expect(await fs.readdir(path.dirname(pending))).toEqual([]);
      await close();
      await launch();
      expect(current().history.filter((e) => e.id === entry.id)).toHaveLength(1);
    },
  );

  test('incompatible saved receipts stop loading before project state is rewritten', async () => {
    await start();
    await until((s) => s.sessions[0]?.state === 'waiting');
    await close();
    const statePath = path.join(root, 'data', 'projects', projectId, 'state.json');
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    saved.sessions[0].receipt.protocolVersion = 99;
    const incompatible = JSON.stringify(saved);
    await fs.writeFile(statePath, incompatible);
    const otherStore = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await expect(otherStore.init()).rejects.toThrow('incompatible or inconsistent');
    expect(await fs.readFile(statePath, 'utf8')).toBe(incompatible);
  });

  test('bounded receipt capacity refuses new commands without evicting existing identities', async () => {
    const accepted = await start();
    await until((s) => s.sessions[0]?.state === 'waiting');
    await request(`/projects/${projectId}/work/${accepted.data.id}/stop`, 'POST', {});
    const base = current().sessions[0];
    for (let i = 1; i < MAX_WORK_RECEIPTS; i++) {
      const saved = structuredClone(base);
      saved.id = `capacity-${i}`;
      const event = store().addEntry(current(), { kind: 'work-admitted', sessionId: saved.id, taskId: saved.taskId, sample: saved.sample });
      saved.receipt = { ...base.receipt!, commandId: `capacity-${i}`, sessionId: saved.id, eventId: event.id, admittedAt: event.time };
      current().sessions.push(saved);
    }
    await store().persist(current());
    expect((await start(command('over-capacity'))).status).toBe(409);
    expect((await start()).data.receipt).toEqual(accepted.data.receipt);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(current().sessions).toHaveLength(MAX_WORK_RECEIPTS);
  });
});
