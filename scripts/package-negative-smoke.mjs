import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const executablePath = path.resolve(process.argv[2] ?? '');
const root = path.resolve(process.argv[3] ?? '');
if (path.basename(executablePath) !== 'Diomedes.exe' || !process.argv[3])
  throw new Error('Supply the exact packaged executable and a NEW isolated proof directory.');
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root);

const env = {
  ...process.env,
  DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
  DIOMEDES_DATA_DIR: path.join(root, 'data'),
  DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  DIOMEDES_TEST_MODE: '1',
  CODEX_HOME: path.join(root, 'synthetic-codex'),
};
delete env.ELECTRON_RUN_AS_NODE;
await fs.mkdir(env.CODEX_HOME);
const initialCodexEntries = await fs.readdir(env.CODEX_HOME);
assert.deepEqual(initialCodexEntries, []);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  throw new Error('The controlled approval fixture contains a non-JSON value.');
};
const digest = (value) => sha256(canonical(value));
const payloadDigest = (value) => `sha256:${sha256(JSON.stringify(value))}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const proof = {
  startedAt: new Date().toISOString(),
  executablePath,
  root,
  version: null,
  checks: [],
  launches: [],
  errors: [],
  passed: false,
};
let desktop;
let page;
let origin;
const origins = new Set();
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request(route, method = 'GET', body, expectedStatus = 200) {
  const response = await fetch(`${origin}/api${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = text;
  }
  assert.equal(
    response.status,
    expectedStatus,
    `${route}: expected ${expectedStatus}, received ${response.status} ${text}`,
  );
  assert.equal(response.ok, expectedStatus >= 200 && expectedStatus < 300);
  return { value, status: response.status, ok: response.ok };
}

async function api(route, method = 'GET', body, expectedStatus = 200) {
  return (await request(route, method, body, expectedStatus)).value;
}

async function waitFor(read, accept, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

async function launch() {
  const started = performance.now();
  desktop = await electron.launch({ executablePath, env, cwd: root });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => proof.errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  origin = new URL(page.url()).origin;
  origins.add(origin);
  const health = await api('/health');
  proof.launches.push({
    origin,
    pid: desktop.process().pid,
    readyMs: Math.round(performance.now() - started),
    version: health.version,
  });
  return health;
}

async function close() {
  if (!desktop) return;
  await desktop.close();
  desktop = undefined;
  page = undefined;
}

async function startReport(base, instruction) {
  const session = await api(`${base}/work/start`, 'POST', {
    capabilityId: 'format-report',
    taskId: null,
    instruction,
  });
  const state = await waitFor(
    () => api(`${base}/state`),
    (candidate) => candidate.sessions.find((item) => item.id === session.id)?.state === 'waiting',
    'the exact report approval',
  );
  const need = state.needs.find(
    (item) => item.sessionId === session.id && item.state === 'open' && item.harness,
  );
  assert.ok(need, 'The packaged fixture did not create an exact harness Need.');
  return { session, need };
}

const decision = (need, commandId) => ({
  protocolVersion: 1,
  commandId,
  resolution: 'go-ahead',
  proposalDigest: need.approval.proposalDigest,
  actionDigest: need.approval.actionDigest,
  baseDigest: need.approval.baseDigest,
});

function ageHarnessNeed(projectId, need) {
  const createdAt = new Date(Date.now() - 3_600_001).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 3_600_000).toISOString();
  const sources = need.approval.sources ?? [];
  const actionDigest = digest(need.harness.intent);
  const basePayload = {
    type: 'harness-write-base',
    expected: need.harness.intent.input.expected,
    ...(sources.length ? { sources } : {}),
  };
  const baseDigest = payloadDigest(basePayload);
  const proposalDigest = payloadDigest({
    type: 'harness-step-proposal',
    protocolVersion: 1,
    projectId,
    approvalId: need.id,
    taskId: need.taskId,
    sessionId: need.sessionId,
    createdAt,
    expiresAt,
    actionDigest,
    baseDigest,
    binding: need.harness,
    what: need.what,
    why: need.why,
    consequence: need.consequence,
    files: need.files,
    preview: need.preview,
  });
  need.createdAt = createdAt;
  need.approval = {
    protocolVersion: 1,
    actionDigest,
    baseDigest,
    expiresAt,
    sources,
    proposalDigest,
  };
  return { createdAt, expiresAt, actionDigest, baseDigest, proposalDigest };
}

try {
  const health = await launch();
  assert.equal(health.version, '0.1.1');
  proof.version = health.version;
  const initialSettings = await api('/settings');
  assert.equal(initialSettings.services.codex, false);
  proof.providerBoundary = {
    codexEnabled: initialSettings.services.codex,
    syntheticCodexHomeStartedEmpty: true,
    providerRoutesCalled: 0,
  };
  const project = await api('/projects/sample', 'POST', {});
  const base = `/projects/${project.id}`;
  const connections = `${base}/connections`;
  await api('/settings', 'PUT', {
    detail: 'technical',
    surface: 'console',
    openProjects: [project.id],
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'some',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });

  const serviceWindow = {
    start: '00:00',
    end: '23:59',
    timeZone: 'UTC',
    days: [0, 1, 2, 3, 4, 5, 6],
  };
  const proposed = await api(`${connections}/propose`, 'POST', {
    text: 'Watch Toast menu availability across three Raleigh restaurants',
    threshold: 5,
    serviceWindow,
  });
  await api(`${connections}/adopt`, 'POST', {
    id: proposed.plan.id,
    digest: proposed.digest,
  });
  const newer = { id: randomUUID(), at: new Date().toISOString(), quantity: 3 };
  const older = {
    id: randomUUID(),
    at: new Date(Date.parse(newer.at) - 120_000).toISOString(),
    quantity: 1,
  };
  await api(`${connections}/event`, 'POST', newer, 202);
  await waitFor(
    () => api(connections),
    (view) => view.inbox.find((item) => item.id === newer.id)?.state === 'processed',
    'the newer signed event to finish',
  );
  await api(`${connections}/event`, 'POST', older, 202);
  const reordered = await waitFor(
    () => api(connections),
    (view) => view.inbox.find((item) => item.id === older.id)?.state === 'ignored',
    'the reordered signed event to be ignored',
  );
  const replay = await api(`${connections}/event`, 'POST', older, 202);
  assert.equal(replay.duplicate, true);
  assert.equal(reordered.inbox.length, 2);
  assert.equal(reordered.tasks.length, 1);
  assert.equal(reordered.observations.length, 1);
  assert.equal(reordered.observations[0].sourceAt, newer.at);
  assert.equal(reordered.observations[0].facts.quantity, 3);
  proof.reorderedEvent = {
    newerId: newer.id,
    olderId: older.id,
    newerSourceAt: newer.at,
    olderSourceAt: older.at,
    states: reordered.inbox.map(({ id, state }) => ({ id, state })),
    duplicateReplay: replay.duplicate,
    tasks: reordered.tasks.length,
    retainedObservation: reordered.observations[0],
  };
  proof.checks.push(
    'A valid older signed event was durably ignored; exact replay was a duplicate, with one Task and the newer observation retained.',
  );

  const privilege = await request(
    `${connections}/rules/revise`,
    'POST',
    { capabilities: ['connections.write'] },
    400,
  );
  proof.privilegeExpansion = privilege;
  proof.checks.push(
    'A rule-revision request carrying a privilege expansion failed strict request validation with HTTP 400.',
  );

  const changedBase = await startReport(base, 'Verify changed report base refusal.');
  const reportPath = path.join(project.folder, 'Harness report.md');
  const outside = 'Outside content must remain untouched.\n';
  await fs.writeFile(reportPath, outside);
  await api(
    `${base}/needs/${changedBase.need.id}/resolve`,
    'POST',
    decision(changedBase.need, `negative-base-${randomUUID()}`),
  );
  const failedRun = await waitFor(
    () => api(`${base}/harness/runs/${changedBase.need.harness.runId}`),
    (run) => run.state === 'failed',
    'the changed-base report run to fail',
  );
  const afterBase = await api(`${base}/state`);
  const baseNeed = afterBase.needs.find((item) => item.id === changedBase.need.id);
  assert.equal(await fs.readFile(reportPath, 'utf8'), outside);
  assert.equal(baseNeed.execution.state, 'not-applied');
  assert.equal(
    afterBase.history.filter((entry) =>
      entry.files.some((file) => file.path === 'Harness report.md'),
    ).length,
    0,
  );
  proof.changedBase = {
    runId: failedRun.id,
    runState: failedRun.state,
    failure: failedRun.failure,
    execution: baseNeed.execution,
    retainedSha256: sha256(await fs.readFile(reportPath)),
    historyWrites: 0,
  };
  proof.checks.push(
    'An outside report created after proposal invalidated the expected base; the run failed, execution was not applied, and the outside bytes remained.',
  );

  await fs.rm(reportPath);
  const expiry = await startReport(base, 'Verify expired approval refusal.');
  await close();
  const statePath = path.join(root, 'data', 'projects', project.id, 'state.json');
  const stateText = await fs.readFile(statePath, 'utf8');
  const state = JSON.parse(stateText);
  const durableNeed = state.needs.find((item) => item.id === expiry.need.id);
  assert.ok(durableNeed?.harness && durableNeed.approval);
  const beforeExpiry = {
    createdAt: durableNeed.createdAt,
    expiresAt: durableNeed.approval.expiresAt,
    stateSha256: sha256(stateText),
  };
  const aged = ageHarnessNeed(project.id, durableNeed);
  const agedText = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(statePath, agedText);
  proof.controlledExpiryFixture = {
    kind: 'isolated-state-injection',
    reason:
      'The packaged process exposes no supported clock override; only this unopened isolated Need was aged while the owned process was stopped.',
    statePath,
    before: beforeExpiry,
    after: { ...aged, stateSha256: sha256(agedText) },
    machineClockChanged: false,
    sourceChanged: false,
  };

  await launch();
  const expired = await request(
    `${base}/needs/${durableNeed.id}/resolve`,
    'POST',
    decision(durableNeed, `negative-expiry-${randomUUID()}`),
    409,
  );
  assert.equal(expired.value.code, 'approval_expired');
  const expiredState = await api(`${base}/state`);
  const retainedNeed = expiredState.needs.find((item) => item.id === durableNeed.id);
  const retainedRun = await api(`${base}/harness/runs/${durableNeed.harness.runId}`);
  assert.equal(retainedNeed.state, 'open');
  assert.equal(retainedNeed.approvalReceipt, undefined);
  assert.equal(retainedRun.state, 'waiting');
  await assert.rejects(fs.access(reportPath), (error) => error.code === 'ENOENT');
  proof.expiredApproval = {
    response: expired,
    needState: retainedNeed.state,
    approvalReceipt: null,
    runState: retainedRun.state,
    reportExists: false,
  };
  proof.checks.push(
    'A valid but expired exact approval was refused with approval_expired; its Need and run stayed waiting and no report was written.',
  );

  const codexEntries = await fs.readdir(env.CODEX_HOME);
  const credentialEntries = codexEntries.filter((entry) =>
    /^(?:auth\.json|config\.toml)$/i.test(entry),
  );
  assert.deepEqual(credentialEntries, []);
  proof.syntheticCodexHome = {
    path: env.CODEX_HOME,
    initialEntries: initialCodexEntries,
    finalEntries: codexEntries,
    credentialEntries,
    note: 'The isolated runtime initialized fresh local databases; no inherited auth or config file was present.',
  };
  assert.deepEqual(proof.errors, []);
  proof.passed = true;
} catch (error) {
  proof.error = error?.stack ?? String(error);
  process.exitCode = 1;
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await close().catch((error) => {
    proof.errors.push(`close: ${error?.message ?? String(error)}`);
    proof.passed = false;
    process.exitCode = 1;
  });
  proof.finishedAt = new Date().toISOString();
  proof.executableSha256 = sha256(await fs.readFile(executablePath));
  proof.asarSha256 = sha256(
    await fs.readFile(path.join(path.dirname(executablePath), 'resources', 'app.asar')),
  );
  proof.cleanup = [];
  for (const closedOrigin of origins) {
    let closed = false;
    try {
      const response = await fetch(`${closedOrigin}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      closed = !response.ok && response.status === 0;
    } catch {
      closed = true;
    }
    proof.cleanup.push({ origin: closedOrigin, closed });
  }
  const lockPath = path.join(root, 'data', 'service.lock');
  proof.lockReleased = await fs.access(lockPath).then(
    () => false,
    (error) => {
      if (error.code === 'ENOENT') return true;
      throw error;
    },
  );
  if (proof.cleanup.some((item) => !item.closed) || !proof.lockReleased) {
    proof.passed = false;
    process.exitCode = 1;
  }
  await fs.writeFile(path.join(root, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: proof.passed,
      version: proof.version,
      checks: proof.checks,
      error: proof.error,
      proof: path.join(root, 'proof.json'),
    }),
  );
}
