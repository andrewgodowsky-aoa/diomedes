/** Separate-process proof using a disposable profile and no provider credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createConnectionFixture,
  connectionFixtureModel,
  fixtureStockEvent,
} from '../server/connections/fixture.js';
import { TOAST_ITEMS, TOAST_RESOURCES } from '../server/connections/toast.js';
import { generateCandidate } from '../server/connections/openapi-candidate.js';

const instant = '2026-09-09T08:00:00.000Z';
const sentinel = 'SYNTHETIC-CREDENTIAL-SENTINEL';
const input = { resources: TOAST_RESOURCES.map((resource) => resource.id), itemIds: TOAST_ITEMS };

async function stage(root: string, mode: string) {
  const f = await createConnectionFixture(root, {
    clock: () => Date.parse(instant),
    secret: sentinel,
  });
  const raw = fixtureStockEvent(instant);
  if (mode === 'seed') {
    const runId = await f.service.admit(f.project.id, 'toast-group', input.resources, [
      'get_item_availability',
    ]);
    await f.service.runFixtureAgent(
      runId,
      connectionFixtureModel(input),
      'Inspect the approved menu availability.',
    );
    const proposal = await f.service.propose(
      f.project.id,
      'toast-group',
      'Alert a manager when reported quantity is at most 5',
    );
    await f.service.activate(f.project.id, 'toast-group', proposal.proposal.id, proposal.digest);
    // An earlier source read must not hide this newer low-stock event.
    const eventAt = '2026-09-09T08:00:01.000Z';
    const pending = fixtureStockEvent(eventAt);
    await f.service.accept(f.project.id, 'toast-group', pending, f.sign(pending, eventAt));
    assert.equal(f.store.state(f.project.id).tasks.length, 0);
    assert.equal(f.service.snapshot(f.project.id).connections.inbox[0].state, 'pending');
    console.log(JSON.stringify({ mode, pid: process.pid, pending: 1, issues: 0, readRun: runId }));
    // Intentionally exit without closing the host, after durable ingress and before triage.
    process.exit(73);
  }
  if (mode === 'recover') {
    await f.service.recover(f.project.id);
    const snapshot = f.service.snapshot(f.project.id);
    assert.equal(snapshot.tasks.length, 1);
    const run = await f.host.runs.get(snapshot.connections.inbox[0].runId);
    assert.equal(run.state, 'completed');
    assert.equal(snapshot.connections.inbox[0].state, 'processed');
    await fs.writeFile(
      path.join(root, 'expected-issue.json'),
      JSON.stringify({ id: snapshot.tasks[0].id }),
    );
    console.log(
      JSON.stringify({
        mode,
        pid: process.pid,
        issues: 1,
        issueId: snapshot.tasks[0].id,
        triage: run.state,
      }),
    );
  } else if (mode === 'replay-revoke') {
    await f.service.recover(f.project.id);
    const expected: { id: string } = JSON.parse(
      await fs.readFile(path.join(root, 'expected-issue.json'), 'utf8'),
    );
    const eventAt = '2026-09-09T08:00:01.000Z',
      duplicate = fixtureStockEvent(eventAt);
    assert.equal(
      (await f.service.accept(f.project.id, 'toast-group', duplicate, f.sign(duplicate, eventAt)))
        .duplicate,
      true,
    );
    await f.service.drain(f.project.id);
    assert.deepEqual(
      f.store.state(f.project.id).tasks.map((task) => task.id),
      [expected.id],
    );
    await f.service.control(f.project.id, 'toast-group', 'disconnected');
    await assert.rejects(
      () =>
        f.service.admit(f.project.id, 'toast-group', input.resources, ['get_item_availability']),
      /not active/,
    );
    await assert.rejects(
      () => f.service.accept(f.project.id, 'toast-group', raw, f.sign(raw, instant)),
      /not active/,
    );
    console.log(
      JSON.stringify({
        mode,
        pid: process.pid,
        issues: 1,
        issueId: expected.id,
        duplicate: true,
        revokedReadsAndEvents: true,
      }),
    );
  } else {
    throw new Error('Unknown proof phase.');
  }
  await f.close();
}

async function runChild(root: string, mode: string): Promise<Record<string, unknown>> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), mode, root],
    { windowsHide: true },
  );
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, mode === 'seed' ? 73 : 0, `Phase ${mode} failed: ${stderr}`);
  assert.equal((stdout + stderr).includes(sentinel), false, 'Credential appeared in child output.');
  const result: Record<string, unknown> = JSON.parse(stdout.trim().split('\n').at(-1)!);
  return { ...result, exitCode, stderr: stderr.trim() };
}

if (process.argv[2]) {
  if (!process.argv[3]) throw new Error('A disposable proof root is required.');
  await stage(path.resolve(process.argv[3]), process.argv[2]);
} else {
  const output = path.resolve('evidence', 'connections');
  await fs.mkdir(output, { recursive: true });
  const parent = path.resolve('test-results');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'connections-process-'));
  const phases = [];
  for (const mode of ['seed', 'recover', 'replay-revoke']) phases.push(await runChild(root, mode));
  assert.equal(new Set(phases.map((phase) => phase.pid)).size, 3);
  let scannedFiles = 0;
  for (const name of await fs.readdir(root, { recursive: true })) {
    const file = path.join(root, name);
    if (!(await fs.stat(file)).isFile()) continue;
    assert.equal(
      (await fs.readFile(file, 'utf8')).includes(sentinel),
      false,
      `Credential persisted in ${name}.`,
    );
    scannedFiles++;
  }
  const spec: unknown = JSON.parse(
    await fs.readFile('fixtures/connections/petstore.openapi.json', 'utf8'),
  );
  const candidate = generateCandidate(spec, {
    connectorId: 'petstore',
    operationIds: ['listPets'],
    sourceUrl:
      'https://github.com/OAI/OpenAPI-Specification/blob/main/_archive_/schemas/v3.0/pass/petstore.yaml',
  });
  await fs.writeFile(
    path.join(output, 'petstore-candidate.json'),
    JSON.stringify(candidate, null, 2) + '\n',
  );
  const report = {
    at: new Date().toISOString(),
    phases,
    scannedFiles,
    credentialLeaks: 0,
    candidate: {
      active: false,
      operations: candidate.operations.map((operation) => operation.id),
      allowedOrigins: candidate.allowedOrigins,
    },
    profile: path.relative(process.cwd(), root),
    boundary:
      'Three local processes; synthetic credential, source and model; no provider or packaged desktop.',
  };
  await fs.writeFile(
    path.join(output, 'process-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
}
