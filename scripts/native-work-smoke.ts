import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { hash } from '../server/store.js';
import type { HistoryEntry, Project, ProjectState, Session, Task } from '../shared/types.js';

// Each invocation makes exactly one native ChatGPT generation request, using
// only the synthetic document below. No generation retry or fallback exists.
const root = fileURLToPath(new URL('../', import.meta.url));
const port = 47633;
const baseUrl = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const appData = path.join(root, '.data', `native-work-smoke-${stamp}`);
const projectFolder = path.join(root, 'test-results', `native-work-smoke-${stamp}`, 'project');
const brief = '# Native work smoke\n\nThis is synthetic verification text.\n';
const expected = `${brief}Native work verified.\n`;
const proof: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  passed: false,
  nativeGenerationRequests: 0,
  scope:
    'One synthetic native file proposal, preview, explicit approval, recorded write, review, and restore through the local HTTP API.',
  projectFolder,
  appData,
  port,
  limitations: [
    'This flow proposes text files; the native engine has no filesystem, shell, browser, or MCP tools.',
    'Diomedes applies the approved fixed proposal using its recorded write service.',
    'No model fallback, local inference, external sending, or build command was performed.',
  ],
};

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: { 'X-Diomedes-Client': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status} for ${method} ${route}: ${(await response.text()).slice(0, 600)}`,
    );
  return (await response.json()) as T;
}

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
try {
  app = await createApp({
    dataDir: appData,
    projectRoot: path.dirname(projectFolder),
    port,
    clientPort: 5173,
  });
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve);
    server!.once('error', reject);
  });
  console.log('Native work smoke: one native ChatGPT request using only synthetic text.');
  await api('/settings', 'PUT', { services: { codex: true, codexModel: 'gpt-5.6-luna', codexEffort: 'low' } });
  const project = await api<Project>('/projects', 'POST', {
    name: 'Native work smoke',
    folder: projectFolder,
  });
  proof.projectId = project.id;
  await api<HistoryEntry>(`/projects/${project.id}/documents/create`, 'POST', {
    path: 'Brief.md',
    text: brief,
  });
  const task = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Append one sentence to Brief.md',
    owner: 'diomedes-with-ok',
    description:
      'Append exactly the sentence Native work verified. as one new line at the end of Brief.md, followed by a newline. Preserve every existing character. Do not create, delete, or change any other file.',
  });
  proof.taskId = task.id;
  assert.equal(await fs.readFile(path.join(projectFolder, 'Brief.md'), 'utf8'), brief);
  proof.nativeGenerationRequests = 1;
  const command = {
    protocolVersion: 1, commandId: 'native-work-smoke',
    taskId: task.id,
    route: 'codex',
    sources: ['Brief.md'],
    consent: true,
  };
  const started = await api<Session>(`/projects/${project.id}/work/start`, 'POST', command);
  const retried = await api<Session>(`/projects/${project.id}/work/start`, 'POST', command);
  assert.ok(started.receipt, 'Native Work must return its durable command receipt.');
  assert.deepEqual(retried.receipt, started.receipt);
  assert.equal(retried.id, started.id);
  proof.commandReceipt = started.receipt;
  assert.equal(started.sample, false);
  proof.sessionId = started.id;

  let state: ProjectState | undefined;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    state = await api<ProjectState>(`/projects/${project.id}/state`);
    const session = state.sessions.find((item) => item.id === started.id);
    assert.ok(session, 'The native work session must remain durable.');
    if (session.state === 'failed' || session.state === 'stopped') {
      throw new Error(
        `Native proposal ${session.state}: ${session.log.at(-1)?.sentence || 'No diagnostic was recorded.'}`,
      );
    }
    if (session.state === 'waiting') break;
    assert.notEqual(
      session.state,
      'done',
      'The append task must produce a proposal requiring approval.',
    );
    await pause(250);
  }
  assert.ok(state, 'The project state was returned.');
  const need = state.needs.find((item) => item.sessionId === started.id && item.state === 'open');
  assert.ok(need, 'A native proposal must require explicit approval before writing.');
  assert.equal(need.preview?.length, 1, 'Only one file may be proposed in this bounded smoke.');
  const preview = need.preview[0];
  assert.equal(preview.path, 'Brief.md');
  assert.equal(preview.before, brief);
  assert.equal(
    preview.after,
    expected,
    'The visible proposal must match the exact authorized synthetic edit.',
  );
  assert.equal(
    await fs.readFile(path.join(projectFolder, 'Brief.md'), 'utf8'),
    brief,
    'The original must remain untouched before approval.',
  );
  proof.beforeApproval = {
    checkedAt: new Date().toISOString(),
    fileUnchanged: true,
    needId: need.id,
    previewFiles: 1,
    sha256: hash(brief),
  };
  console.log('Native proposal ready: original file is unchanged and the exact preview passed.');

  await api(`/projects/${project.id}/needs/${need.id}/resolve`, 'POST', { resolution: 'go-ahead' });
  assert.equal(
    await fs.readFile(path.join(projectFolder, 'Brief.md'), 'utf8'),
    expected,
    'The approved file bytes must match the shown proposal.',
  );
  state = await api<ProjectState>(`/projects/${project.id}/state`);
  const completed = state.sessions.find((item) => item.id === started.id);
  assert.equal(completed?.state, 'done');
  assert.equal(completed.sample, false);
  assert.ok(completed.engine.model, 'The native model must be recorded.');
  const entry = state.history.find(
    (item) => item.sessionId === started.id && item.kind === 'changed',
  );
  assert.ok(entry, 'The native file write must have a durable history entry.');
  assert.equal(entry.sample, false);
  assert.equal(entry.files.length, 1);
  assert.equal(entry.files[0].before, hash(brief));
  assert.equal(entry.files[0].after, hash(expected));
  const change = state.changes.find(
    (item) => item.entryId === entry.id && item.path === 'Brief.md',
  );
  assert.ok(change, 'The file change must appear in Review.');
  assert.equal(change.state, 'waiting');
  assert.equal(change.after, expected);
  proof.afterApproval = {
    checkedAt: new Date().toISOString(),
    fileMatchesPreview: true,
    model: completed.engine.model,
    historyEntryId: entry.id,
    reviewChangeId: change.id,
    sha256: hash(expected),
    sessionSample: false,
  };

  const restored = await api<{ entryId: string }>(
    `/projects/${project.id}/history/${entry.id}/restore`,
    'POST',
    {},
  );
  assert.equal(
    await fs.readFile(path.join(projectFolder, 'Brief.md'), 'utf8'),
    brief,
    'Restore must reproduce the exact original bytes.',
  );
  state = await api<ProjectState>(`/projects/${project.id}/state`);
  const restoreEntry = state.history.find((item) => item.id === restored.entryId);
  assert.ok(restoreEntry, 'The restore must itself be durable history.');
  assert.equal(restoreEntry.restoreOf, entry.id);
  assert.equal(restoreEntry.files[0].before, hash(expected));
  assert.equal(restoreEntry.files[0].after, hash(brief));
  assert.equal(state.changes.find((item) => item.id === change.id)?.state, 'undone');
  proof.restore = {
    checkedAt: new Date().toISOString(),
    originalBytesRestored: true,
    displacedVersionPreserved: true,
    historyEntryId: restored.entryId,
    sha256: hash(brief),
    reviewState: 'undone',
  };
  proof.passed = true;
  console.log(
    'PASS: native proposal, no write before approval, exact approved bytes, History, Review, and recorded restore.',
  );
} catch (error) {
  proof.error = error instanceof Error ? error.message : 'The native work smoke failed.';
  process.exitCode = 1;
  console.error(proof.error);
} finally {
  try {
    if (app) await app.locals.close();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    proof.ownedServerClosed = true;
  } catch (error) {
    proof.cleanupError = error instanceof Error ? error.message : 'Owned server cleanup failed.';
    proof.passed = false;
    process.exitCode = 1;
  }
  proof.completedAt = new Date().toISOString();
  await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'evidence', 'native-work-proof.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
}
