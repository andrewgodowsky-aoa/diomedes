import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/app.js';
import type { NativeGenerator } from '../server/native-work.js';
import { hash, Store } from '../server/store.js';
import {
  APPROVAL_TTL_MS,
  MAX_APPROVAL_RECEIPTS,
  identifyApproval,
  parseApprovalCommand,
  validateApprovalReceipts,
} from '../server/approval-admission.js';
import type { ApprovalCommand, Need, ProjectState, Task } from '../shared/types.js';

const original = '\ufeff# Brief\r\n\r\nSynthetic before bytes.\r\n';
const revised = `${original}Reviewed addition.\r\n`;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string, projectId: string, taskId: string, url: string;
let app: Awaited<ReturnType<typeof createApp>>, server: Server | undefined;
let generate: ReturnType<typeof vi.fn<NativeGenerator>>;
const store = (): Store => app.locals.store;
const current = () => store().state(projectId);
async function launch() {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
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
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
}
async function request<T>(route: string, method = 'GET', body?: unknown, customHeaders = headers) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: customHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
async function ready(sources = ['Brief.md', 'Reference.md']) {
  expect(
    (
      await request(`/projects/${projectId}/work/start`, 'POST', {
        protocolVersion: 1,
        commandId: 'work-command',
        taskId,
        route: 'codex',
        sources,
        consent: true,
      })
    ).status,
  ).toBe(200);
  await vi.waitFor(() => expect(current().needs.some((need) => need.state === 'open')).toBe(true));
  return structuredClone(current().needs.find((need) => need.state === 'open')!);
}
function command(
  need: Need,
  resolution: ApprovalCommand['resolution'] = 'go-ahead',
  commandId = 'approval-command',
): ApprovalCommand {
  return {
    protocolVersion: 1,
    commandId,
    resolution,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  };
}
const decide = (need: Need, body: unknown = command(need)) =>
  request<Need>(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', body);
const read = (need: Need) => request<Need>(`/projects/${projectId}/needs/${need.id}`);
async function crash(phase: string) {
  await close();
  const output: string[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/approval-crash-child.ts', root, projectId, taskId, phase],
      { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect(code, output.join('')).toBe(
    80 +
      [
        'before-decision',
        'after-decision',
        'journal',
        'first-file',
        'after-files',
        'finalized',
      ].indexOf(phase),
  );
  return JSON.parse(
    await fs.readFile(path.join(root, 'approval-command.json'), 'utf8'),
  ) as ApprovalCommand;
}
beforeEach(async () => {
  await fs.mkdir('test-results', { recursive: true });
  root = await fs.mkdtemp(path.resolve('test-results', 'approvals-'));
  generate = vi.fn(async () => ({
    model: 'deterministic-fixture',
    text: JSON.stringify({
      summary: 'Append one reviewed sentence and create a draft.',
      changes: [
        { path: 'Brief.md', text: revised, summary: 'Append a sentence.' },
        { path: 'Draft.md', text: '# Draft\n', summary: 'Create a draft.' },
      ],
    }),
  }));
  await launch();
  projectId = (await request<{ id: string }>('/projects', 'POST', { name: 'Approval fixture' }))
    .data.id;
  for (const [name, text] of [
    ['Brief.md', original],
    ['Reference.md', 'Selected read-only reference.\n'],
  ])
    await request(`/projects/${projectId}/documents/create`, 'POST', { path: name, text });
  taskId = (
    await request<Task>(`/projects/${projectId}/tasks`, 'POST', {
      name: 'Append a sentence',
      owner: 'diomedes-with-ok',
    })
  ).data.id;
  await request('/settings', 'PUT', { services: { codex: true } });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await close();
});

describe('exact native approval admission', () => {
  test.each(['go-ahead', 'declined'] as const)(
    'lost response and duplicate %s return one immutable decision through two restarts',
    async (resolution) => {
      const need = await ready();
      const [a, b] = await Promise.all([
        decide(need, command(need, resolution)),
        decide(need, command(need, resolution)),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.data.approvalReceipt).toEqual(b.data.approvalReceipt);
      expect(a.data.approvalReceipt).toMatchObject({
        commandId: 'approval-command',
        decision: resolution,
        projectId,
        approvalId: need.id,
        actor: 'local-client',
        scope: 'local-prototype',
      });
      expect(a.data.execution?.state).toBe(resolution === 'go-ahead' ? 'applied' : 'declined');
      expect(current().history.filter((entry) => entry.kind === 'decision')).toHaveLength(1);
      expect(current().history.filter((entry) => entry.kind === 'changed')).toHaveLength(
        resolution === 'go-ahead' ? 1 : 0,
      );
      expect(await store().current(projectId, 'Brief.md')).toBe(
        resolution === 'go-ahead' ? revised : original,
      );
      validateApprovalReceipts(current());
      const receipt = structuredClone(a.data.approvalReceipt);
      for (let n = 0; n < 2; n++) {
        await close();
        await launch();
        expect((await read(need)).data.approvalReceipt).toEqual(receipt);
        expect((await decide(need, command(need, resolution))).data.approvalReceipt).toEqual(
          receipt,
        );
        expect(generate).toHaveBeenCalledTimes(1);
      }
    },
  );
  test('approval is durable before the writer and the write carries its exact event link', async () => {
    const need = await ready();
    const write = store().writeRecorded.bind(store());
    vi.spyOn(store(), 'writeRecorded').mockImplementation(async (...args) => {
      const disk = JSON.parse(
        await fs.readFile(store().statePath(projectId), 'utf8'),
      ) as ProjectState;
      expect(disk.needs[0].approvalReceipt?.commandId).toBe('approval-command');
      expect(disk.needs[0].execution?.state).toBe('pending');
      expect(await store().current(projectId, 'Brief.md')).toBe(original);
      return write(...args);
    });
    const result = await decide(need);
    expect(result.status).toBe(200);
    expect(
      current().history.find((entry) => entry.id === result.data.execution?.eventId),
    ).toMatchObject({ approvalId: need.id, kind: 'changed' });
  });
  test.each(['proposalDigest', 'actionDigest', 'baseDigest'] as const)(
    'rejects a changed displayed %s without using the writer',
    async (key) => {
      const need = await ready(),
        writer = vi.spyOn(store(), 'writeRecorded');
      expect(
        (await decide(need, { ...command(need), [key]: `sha256:${'0'.repeat(64)}` })).status,
      ).toBe(409);
      expect(writer).not.toHaveBeenCalled();
      expect(current().needs[0].state).toBe('open');
      expect((await decide(need)).status).toBe(200);
    },
  );
  test.each([
    { protocolVersion: 2 },
    { commandId: '' },
    { commandId: 'x'.repeat(129) },
    { actor: 'owner' },
    { scope: 'authenticated' },
    { allowForTask: true },
    { actionDigest: 'bad' },
  ])('strict version and authority validation: %j', async (input) => {
    const need = await ready();
    expect([400, 409]).toContain((await decide(need, { ...command(need), ...input })).status);
    expect(current().needs[0].approvalReceipt).toBeUndefined();
    expect(await store().current(projectId, 'Brief.md')).toBe(original);
  });
  test('an unversioned caller cannot bypass an exact Need; sample requests remain compatible', async () => {
    const need = await ready();
    expect((await decide(need, { resolution: 'go-ahead' })).status).toBe(409);
    expect(current().needs[0].state).toBe('open');
  });
  test.each(['Brief.md', 'Reference.md', 'Draft.md'])(
    'denies a stale %s including unchanged selected inputs and creation targets',
    async (file) => {
      const need = await ready();
      await fs.writeFile(path.join(current().project.folder, file), 'Outside text.\n');
      expect((await decide(need)).status).toBe(409);
      expect(current().needs[0].approvalReceipt).toBeUndefined();
      expect(current().history.filter((entry) => entry.kind === 'changed')).toHaveLength(0);
      expect(await store().current(projectId, file)).toBe('Outside text.\n');
    },
  );
  test('competing decisions and command reuse cannot reinterpret an accepted action', async () => {
    const need = await ready();
    const [a, b] = await Promise.all([
      decide(need),
      decide(need, command(need, 'declined', 'other-decision')),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await decide(need, command(need, 'declined'))).status).toBe(409);
    expect((await decide(need, command(need, 'go-ahead', 'work-command'))).status).toBe(409);
    const winningCommand = current().needs[0].approvalReceipt!.commandId;
    expect(
      (
        await request(`/projects/${projectId}/work/start`, 'POST', {
          protocolVersion: 1,
          commandId: winningCommand,
          taskId,
          route: 'sample',
        })
      ).status,
    ).toBe(409);
    expect(current().history.filter((entry) => entry.kind === 'decision')).toHaveLength(1);
  });
  test('expires at the boundary, but an accepted receipt replays after expiry without IO', async () => {
    const need = await ready();
    const accepted = await decide(need);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(need.approval!.expiresAt));
    const files = vi.spyOn(store(), 'current'),
      writes = vi.spyOn(store(), 'writeRecorded'),
      persist = vi.spyOn(store(), 'persist'),
      docs = vi.spyOn(store(), 'listDocuments');
    expect((await decide(need)).data.approvalReceipt).toEqual(accepted.data.approvalReceipt);
    expect(files).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(docs).not.toHaveBeenCalled();
  });
  test('expiry is rechecked at durable admission after asynchronous base validation', async () => {
    const need = await ready(),
      readFile = store().current.bind(store());
    vi.spyOn(store(), 'current').mockImplementation(async (...args) => {
      const text = await readFile(...args);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse(need.approval!.expiresAt));
      return text;
    });
    const result = await decide(need);
    expect(result.status).toBe(409);
    expect(current().needs[0].approvalReceipt).toBeUndefined();
    expect(await readFile(projectId, 'Brief.md')).toBe(original);
    await close();
    await launch();
  });
  test('failed decision persistence creates no phantom receipt or write and can be retried', async () => {
    const need = await ready(),
      persist = store().persist.bind(store());
    const fault = vi.spyOn(store(), 'persist').mockImplementation(async (state) => {
      if (state.needs.some((item) => item.approvalReceipt)) throw new Error('Synthetic disk full.');
      return persist(state);
    });
    expect((await decide(need)).status).toBe(500);
    fault.mockRestore();
    expect((await read(need)).data.approvalReceipt).toBeUndefined();
    expect(await store().current(projectId, 'Brief.md')).toBe(original);
    expect((await decide(need)).status).toBe(200);
  });
  test('failure after acceptance but before journal preparation is durable not-applied and never redispatched', async () => {
    const need = await ready();
    const writer = vi
      .spyOn(store(), 'writeRecorded')
      .mockRejectedValue(new Error('Synthetic preparation failure.'));
    expect((await decide(need)).status).toBe(500);
    const result = await decide(need);
    expect(result.status).toBe(200);
    expect(result.data.execution?.state).toBe('not-applied');
    expect(writer).toHaveBeenCalledTimes(1);
    expect(await store().current(projectId, 'Brief.md')).toBe(original);
  });
  test('failed journal recovery blocks later mutations until recovery finishes', async () => {
    const need = await ready(),
      persist = store().persist.bind(store());
    const fault = vi.spyOn(store(), 'persist').mockImplementation(async (state) => {
      if (state.needs.some((item) => item.execution?.state === 'applied'))
        throw new Error('Synthetic finalization disk fault.');
      return persist(state);
    });
    expect((await decide(need)).status).toBe(500);
    expect(
      (await fs.readdir(path.join(root, 'data', 'pending'))).filter((name) =>
        name.endsWith('.json'),
      ),
    ).toHaveLength(1);
    expect(
      (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'After recovery' })).status,
    ).toBe(500);
    expect(current().tasks).toHaveLength(1);
    fault.mockRestore();
    expect(
      (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'After recovery' })).status,
    ).toBe(200);
    await close();
    await launch();
    expect(current().tasks.some((task) => task.name === 'After recovery')).toBe(true);
    expect((await read(need)).data.execution?.state).toBe('applied');
  });
  test('project, Host, Origin and client boundaries protect decisions and receipts', async () => {
    const need = await ready();
    const other = (await request<{ id: string }>('/projects', 'POST', { name: 'Other' })).data.id;
    expect((await request(`/projects/${other}/needs/${need.id}`)).status).toBe(404);
    expect(
      (await request(`/projects/${other}/needs/${need.id}/resolve`, 'POST', command(need))).status,
    ).toBe(404);
    for (const custom of [
      { ...headers, Origin: 'https://foreign.invalid' },
      { 'Content-Type': 'application/json' },
    ])
      expect(
        (
          await request(
            `/projects/${projectId}/needs/${need.id}/resolve`,
            'POST',
            command(need),
            custom as typeof headers,
          )
        ).status,
      ).toBe(403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        `${url}/api/projects/${projectId}/needs/${need.id}/resolve`,
        { method: 'POST', headers: { ...headers, Host: 'foreign.invalid' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(command(need)));
    });
    expect(hostStatus).toBe(403);
    expect(current().needs[0].approvalReceipt).toBeUndefined();
  });
  test.each(['version', 'digest', 'event', 'decision', 'action-bytes', 'execution'] as const)(
    'inconsistent saved %s fails closed without rewriting project state',
    async (field) => {
      const need = await ready();
      await decide(need);
      await close();
      const filename = path.join(root, 'data', 'projects', projectId, 'state.json');
      const state = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (field === 'version') state.needs[0].approvalReceipt.protocolVersion = 2;
      if (field === 'digest')
        state.needs[0].approvalReceipt.payloadDigest = `sha256:${'0'.repeat(64)}`;
      if (field === 'event') state.needs[0].approvalReceipt.eventId = 'missing';
      if (field === 'decision') state.needs[0].approvalReceipt.decision = 'declined';
      if (field === 'action-bytes') state.needs[0].preview[0].after += 'silently different';
      if (field === 'execution') state.needs[0].execution.eventId = 'missing';
      const bytes = JSON.stringify(state);
      await fs.writeFile(filename, bytes);
      await expect(launch()).rejects.toThrow('incompatible or inconsistent');
      expect(await fs.readFile(filename, 'utf8')).toBe(bytes);
    },
  );
  test('digests bind bytes, destination, displayed explanation and read-only source identity', async () => {
    const need = await ready();
    expect(Date.parse(need.approval!.expiresAt) - Date.parse(need.createdAt)).toBe(APPROVAL_TTL_MS);
    for (const mutate of [
      (n: Need) => {
        n.preview![0].after += '!';
      },
      (n: Need) => {
        n.preview![0].path = 'Different.md';
      },
      (n: Need) => {
        n.why += '!';
      },
      (n: Need) => {
        n.preview![0].hunks[0].value += '!';
      },
    ]) {
      const copy = structuredClone(need);
      mutate(copy);
      expect(identifyApproval(projectId, copy, copy.approval!.sources).proposalDigest).not.toBe(
        need.approval!.proposalDigest,
      );
    }
    expect(
      identifyApproval(projectId, need, [{ path: 'Reference.md', sha: hash('different')! }])
        .baseDigest,
    ).not.toBe(need.approval!.baseDigest);
  });
  test.each([
    'before-decision',
    'after-decision',
    'journal',
    'first-file',
    'after-files',
    'finalized',
  ])(
    'abrupt exit at %s recovers once with the correct durable outcome',
    async (phase) => {
      const saved = await crash(phase);
      await launch();
      const need = current().needs[0];
      const applied = !['before-decision', 'after-decision'].includes(phase);
      expect(need.execution?.state).toBe(
        phase === 'before-decision' ? undefined : applied ? 'applied' : 'not-applied',
      );
      expect(await store().current(projectId, 'Brief.md')).toBe(applied ? revised : original);
      expect(await store().current(projectId, 'Draft.md')).toBe(applied ? '# Draft\n' : null);
      expect((await decide(need, saved)).status).toBe(phase === 'before-decision' ? 409 : 200);
      const receipt = structuredClone(need.approvalReceipt);
      await close();
      await launch();
      expect((await read(need)).data.approvalReceipt).toEqual(receipt);
      expect((await decide(need, saved)).status).toBe(phase === 'before-decision' ? 409 : 200);
      expect(current().history.filter((entry) => entry.kind === 'changed')).toHaveLength(
        applied ? 1 : 0,
      );
      expect(generate).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, 'adapter-invoked.txt'), 'utf8')).toBe('once');
      expect(
        (await fs.readdir(path.join(root, 'data', 'pending'))).filter((file) =>
          file.endsWith('.json'),
        ),
      ).toHaveLength(0);
    },
    20_000,
  );
  test.each(['text', 'binary', 'oversized', 'directory'])(
    'recovery preserves an outside %s replacement and reports a conflict without replaying',
    async (kind) => {
      const saved = await crash('first-file');
      const diskState = JSON.parse(
        await fs.readFile(store().statePath(projectId), 'utf8'),
      ) as ProjectState;
      const target = path.join(diskState.project.folder, 'Draft.md');
      const bytes =
        kind === 'text'
          ? Buffer.from('Newer user work.\n')
          : kind === 'binary'
            ? Buffer.from([0, 255, 42])
            : Buffer.alloc(8 * 1024 * 1024 + 1, 65);
      if (kind === 'directory') await fs.mkdir(target);
      else await fs.writeFile(target, bytes);
      await launch();
      const need = current().needs[0];
      expect(need.execution).toMatchObject({ state: 'conflicted', conflicts: ['Draft.md'] });
      expect(current().sessions[0].state).toBe('failed');
      expect(await store().current(projectId, 'Brief.md')).toBe(revised);
      if (kind === 'directory') expect((await fs.stat(target)).isDirectory()).toBe(true);
      else expect((await fs.readFile(target)).equals(bytes)).toBe(true);
      const replay = await decide(need, saved);
      expect(replay.status).toBe(200);
      expect(replay.data.execution?.state).toBe('conflicted');
      const outside = current().history.find((entry) => entry.kind === 'outside');
      expect(outside?.files[0].recorded).toBe(kind === 'text');
      await close();
      await launch();
      expect((await read(need)).data.execution?.state).toBe('conflicted');
      expect(generate).not.toHaveBeenCalled();
    },
    20_000,
  );
  test.each(['action', 'missing-link', 'receipt'])(
    'an inconsistent prepared %s fails closed before any recovery write',
    async (field) => {
      await crash('journal');
      const dir = path.join(root, 'data', 'pending');
      const journalPath = path.join(
        dir,
        (await fs.readdir(dir)).find((name) => name.endsWith('.json'))!,
      );
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      if (field === 'action') journal.writes[0].after = hash('Different action.');
      if (field === 'missing-link') delete journal.approvalId;
      if (field === 'receipt') journal.state.needs[0].approvalReceipt.protocolVersion = 2;
      await fs.writeFile(journalPath, JSON.stringify(journal));
      const statePath = path.join(root, 'data', 'projects', projectId, 'state.json');
      const before = await fs.readFile(statePath, 'utf8');
      const state = JSON.parse(before) as ProjectState;
      await expect(launch()).rejects.toThrow(/inconsistent|incompatible/);
      expect(await fs.readFile(statePath, 'utf8')).toBe(before);
      expect(await fs.readFile(path.join(state.project.folder, 'Brief.md'), 'utf8')).toBe(original);
    },
    20_000,
  );
  test('a damaged content object cannot change the bytes authorized by a receipt', async () => {
    const saved = await crash('journal');
    const objectPath = store().objectPath(projectId, hash(revised)!);
    await fs.writeFile(objectPath, 'Different bytes under the approved hash.');
    await expect(launch()).rejects.toThrow('damaged');
    const disk = JSON.parse(
      await fs.readFile(store().statePath(projectId), 'utf8'),
    ) as ProjectState;
    expect(await fs.readFile(path.join(disk.project.folder, 'Brief.md'), 'utf8')).toBe(original);
    await fs.writeFile(objectPath, revised);
    await launch();
    expect((await decide(current().needs[0], saved)).data.execution?.state).toBe('applied');
    expect(await store().current(projectId, 'Brief.md')).toBe(revised);
  }, 20_000);
  test('receipt retention is bounded without eviction and replay stays free of project IO at capacity', async () => {
    const need = await ready();
    const first = (await decide(need, command(need, 'declined'))).data;
    for (let index = 1; index < MAX_APPROVAL_RECEIPTS; index++) {
      const copy = structuredClone(first);
      copy.id = `capacity-${index}`;
      copy.approval = identifyApproval(projectId, copy, copy.approval!.sources);
      const admitted = parseApprovalCommand(projectId, copy.id, {
        ...command(copy, 'declined', `capacity-${index}`),
      })!;
      const event = store().addEntry(current(), {
        kind: 'decision',
        approvalId: copy.id,
        sessionId: copy.sessionId,
        taskId: copy.taskId,
      });
      copy.decidedAt = event.time;
      copy.approvalReceipt = {
        ...first.approvalReceipt!,
        commandId: admitted.command.commandId,
        payloadDigest: admitted.payloadDigest,
        approvalId: copy.id,
        proposalDigest: copy.approval.proposalDigest,
        eventId: event.id,
        decidedAt: event.time,
      };
      copy.execution = { ...copy.execution!, completedAt: event.time };
      current().needs.push(copy);
    }
    validateApprovalReceipts(current());
    await store().persist(current());
    const sourceBytes = Buffer.byteLength(JSON.stringify(current()));
    const receiptBytes = Buffer.byteLength(
      JSON.stringify(
        current().needs.map((item) => ({
          approval: item.approval,
          receipt: item.approvalReceipt,
          execution: item.execution,
        })),
      ),
    );
    const listing = vi.spyOn(store(), 'listDocuments'),
      files = vi.spyOn(store(), 'current'),
      persist = vi.spyOn(store(), 'persist');
    const replayNeed = structuredClone(current().needs.at(-1)!);
    const started = performance.now();
    const replays = await Promise.all(
      Array.from({ length: 50 }, () =>
        decide(replayNeed, command(replayNeed, 'declined', replayNeed.approvalReceipt!.commandId)),
      ),
    );
    const replayMs = performance.now() - started;
    expect(replays.every((result) => result.status === 200)).toBe(true);
    expect(listing).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    listing.mockRestore();
    files.mockRestore();
    persist.mockRestore();
    expect(
      (
        await request(`/projects/${projectId}/work/start`, 'POST', {
          protocolVersion: 1,
          commandId: 'next-work',
          taskId,
          route: 'codex',
          sources: ['Brief.md'],
          consent: true,
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(() => expect(current().needs.at(-1)?.state).toBe('open'));
    expect(
      (
        await decide(
          current().needs.at(-1)!,
          command(current().needs.at(-1)!, 'go-ahead', 'over-capacity'),
        )
      ).status,
    ).toBe(409);
    expect((await decide(need, command(need, 'declined'))).data.approvalReceipt).toEqual(
      first.approvalReceipt,
    );
    console.log(
      `Approval replay at ${MAX_APPROVAL_RECEIPTS} receipts: 50 requests in ${replayMs.toFixed(1)} ms, zero project IO or persistence; receipt metadata ${receiptBytes} bytes, full synthetic state ${sourceBytes} bytes.`,
    );
    await fs.mkdir('output/approvals', { recursive: true });
    await fs.writeFile(
      'output/approvals/approval-performance.json',
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          receiptCount: MAX_APPROVAL_RECEIPTS,
          requests: 50,
          replayMs,
          scans: 0,
          documentReads: 0,
          statePersists: 0,
          receiptBytes,
          sourceBytes,
        },
        null,
        2,
      ),
    );
  }, 20_000);
});
