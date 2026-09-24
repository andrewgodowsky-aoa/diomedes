import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store, hash } from '../server/store.js';
import { VerificationService } from '../server/verification/service.js';
import type { VerificationReviewerAdapter, VerificationReviewerRequest } from '../server/verification/reviewer.js';
import { parseVerificationVerdict } from '../server/verification/reviewer.js';
import { createApp } from '../server/app.js';
import { verificationOf, type AcceptanceCheck, type VerificationView } from '../shared/verification.js';
import { directOrigin } from '../shared/attribution.js';
import type { ProjectState, Session, Task } from '../shared/types.js';

/**
 * H17 verification service: a separate verifier binds its evidence to the
 * exact bytes History recorded, reports failures with their evidence, reads a
 * timeout or a missing route as uncertain, attributes every check truthfully,
 * and gives the same answer after a restart. It never runs project code and
 * never writes a project file.
 */

const MENU = '# Menu\n\nSoup of the day\nBread\n';
const WORKER = directOrigin({ engine: 'codex', reportedModel: 'gpt-6-astra', version: '0.153.4' });

let root: string;
let store: Store;
let id: string;
let folder: string;

async function seedRun(sessionState: Session['state'] = 'done') {
  const state = store.state(id);
  const task: Task = {
    id: 'T1',
    name: 'Write the reopening menu',
    description: 'A plain menu for Friday.',
    from: null,
    owner: 'diomedes',
    state: 'done',
    reason: null,
    needId: null,
    sessionIds: ['S1'],
    changeIds: [],
    createdBy: 'you',
    createdAt: '2026-09-24T00:00:00.000Z',
    moves: [],
  };
  const session: Session = {
    id: 'S1',
    taskId: 'T1',
    route: 'codex',
    origin: WORKER,
    state: 'working',
    startedAt: '2026-09-24T00:00:01.000Z',
    endedAt: null,
    sample: false,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'codex', model: 'gpt-6-astra', worker: 1, branch: null, context: null, events: 0, verified: true },
  };
  state.tasks.push(task);
  state.sessions.push(session);
  await store.persist(state);
  await store.locked(() =>
    store.writeRecorded(id, [{ path: 'menu.md', text: MENU, expected: null }], {
      actor: 'diomedes',
      kind: 'changed',
      sessionId: 'S1',
      taskId: 'T1',
      origin: WORKER,
    }),
  );
  const after = store.state(id);
  const stored = after.sessions.find((item) => item.id === 'S1')!;
  stored.state = sessionState;
  stored.endedAt = sessionState === 'done' ? '2026-09-24T00:00:05.000Z' : null;
  await store.persist(after);
}

const declare = (verification: VerificationService, checks: AcceptanceCheck[]) =>
  store.locked(() => verification.declare(id, 'T1', { checks }));

const project = (): VerificationView => {
  const state = store.state(id);
  return verificationOf({
    session: state.sessions.find((item) => item.id === 'S1')!,
    task: state.tasks.find((item) => item.id === 'T1')!,
    history: state.history,
  });
};

function allowReview() {
  store.settings.services = { ...(store.settings.services ?? {}), codex: true } as typeof store.settings.services;
  const state = store.state(id);
  state.cloudSharing = {
    version: 1,
    routes: ['codex'],
    documents: ['menu.md'],
    shareConversationHistory: false,
    shareReviewPackets: true,
  };
}

const answering =
  (model: string | null, text = '{"verdict":"pass","note":"Lists soup and bread."}') =>
  (seen: VerificationReviewerRequest[] = []): VerificationReviewerAdapter =>
  async (request) => {
    seen.push(request);
    return { text, ...(model ? { model } : {}), version: '0.153.4', threadId: 'review-thread' };
  };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h17-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  const created = await store.createProject('Verification fixture');
  id = created.id;
  folder = created.folder;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('H17 verification service', () => {
  test('with nothing declared a finished run is plainly Not verified, and verify refuses', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    expect(project()).toMatchObject({ state: 'not-verified', rule: 'no-checks-declared' });
    await expect(verification.verify(id, 'S1')).rejects.toMatchObject({ status: 409 });
  });

  test('an unfinished run cannot be verified', async () => {
    await seedRun('working');
    const verification = new VerificationService(store, null);
    await declare(verification, [{ id: 'has-menu', kind: 'file-exists', path: 'menu.md' }]);
    await expect(verification.verify(id, 'S1')).rejects.toMatchObject({ status: 409 });
    expect(project().rule).toBe('run-not-finished');
  });

  test('bad declarations are refused before anything is saved', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    const before = store.state(id).history.length;
    await expect(
      declare(verification, [
        { id: 'a', kind: 'file-exists', path: 'menu.md' },
        { id: 'a', kind: 'file-exists', path: 'other.md' },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.locked(() => verification.declare(id, 'T1', { checks: [{ id: 'x', kind: 'shell', run: 'rm -rf /' }] })),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.state(id).history.length).toBe(before);
    expect(store.state(id).tasks[0].acceptance).toBeUndefined();
  });

  test('passing checks verify the run against the exact output digest, attributed to Diomedes', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    await declare(verification, [
      { id: 'has-menu', kind: 'file-exists', path: 'menu.md' },
      { id: 'has-soup', kind: 'text-contains', path: 'menu.md', text: 'Soup of the day' },
    ]);
    expect(project()).toMatchObject({ state: 'not-verified', rule: 'checks-not-run', declared: 2 });
    const view = await verification.verify(id, 'S1');
    expect(view).toMatchObject({ state: 'verified', rule: 'all-passed', label: 'Verified' });
    const record = view.record!;
    expect(record.outputs).toEqual([{ path: 'menu.md', sha: hash(MENU) }]);
    expect(record.bound).toEqual([{ path: 'menu.md', sha: hash(MENU) }]);
    expect(record.checks.map((check) => [check.id, check.outcome])).toEqual([
      ['outputs-intact', 'passed'],
      ['has-menu', 'passed'],
      ['has-soup', 'passed'],
    ]);
    // Truthful attribution: the verifier is a Diomedes application action; the
    // worker's identity is copied from the run, never from a picker.
    for (const check of record.checks) {
      expect(check.origin.mode).toBe('application');
      expect(check.origin.executorId).toBe('diomedes:verifier');
    }
    expect(record.producer).toEqual(WORKER);
    const entry = store.state(id).history.find((item) => item.id === view.entryId)!;
    expect(entry).toMatchObject({ kind: 'verified', actor: 'you', sessionId: 'S1', taskId: 'T1', files: [] });
    expect(entry.origin?.mode).toBe('application');
    // Verifying never touched the output.
    expect(await fs.readFile(path.join(folder, 'menu.md'), 'utf8')).toBe(MENU);
  });

  test('a later change to the verified bytes flips the result to uncertain, from History alone', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    await declare(verification, [{ id: 'has-menu', kind: 'file-exists', path: 'menu.md' }]);
    expect((await verification.verify(id, 'S1')).state).toBe('verified');

    // A write through Diomedes is recorded, so the projection sees it at once.
    const edited = `${MENU}Pie\n`;
    await store.locked(() => store.writeRecorded(id, [{ path: 'menu.md', text: edited, expected: hash(MENU) }]));
    expect(project()).toMatchObject({
      state: 'uncertain',
      rule: 'outputs-changed',
      changed: [{ path: 'menu.md', verified: hash(MENU), current: hash(edited) }],
    });

    // Verifying again cannot restore it: the bytes are no longer the run's output.
    const again = await verification.verify(id, 'S1');
    expect(again).toMatchObject({ state: 'uncertain', rule: 'check-incomplete' });
    expect(again.record!.checks[0]).toMatchObject({ id: 'outputs-intact', outcome: 'incomplete' });
  });

  test('an edit outside Diomedes reaches History on the next sync, which the state route runs', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    await declare(verification, [{ id: 'has-menu', kind: 'file-exists', path: 'menu.md' }]);
    expect((await verification.verify(id, 'S1')).state).toBe('verified');
    await fs.writeFile(path.join(folder, 'menu.md'), 'changed by hand\n', 'utf8');
    expect(project().state).toBe('verified');
    await store.locked(() => verification.sync(id));
    expect(project()).toMatchObject({ state: 'uncertain', rule: 'outputs-changed' });
    expect(store.state(id).history.at(-1)).toMatchObject({ kind: 'outside' });
    // A sync with nothing new records nothing.
    const length = store.state(id).history.length;
    await store.locked(() => verification.sync(id));
    expect(store.state(id).history.length).toBe(length);
  });

  test('an output that moved before verification is judged uncertain, not verified', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    await declare(verification, [{ id: 'has-menu', kind: 'file-exists', path: 'menu.md' }]);
    await fs.writeFile(path.join(folder, 'menu.md'), 'someone else\n', 'utf8');
    const view = await verification.verify(id, 'S1');
    expect(view.state).toBe('uncertain');
    expect(view.record!.checks[0]).toMatchObject({ id: 'outputs-intact', outcome: 'incomplete' });
  });

  test('a failing check is Failed verification with the failing evidence', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    await declare(verification, [
      { id: 'has-dessert', kind: 'text-contains', path: 'menu.md', text: 'Dessert' },
      { id: 'prices', kind: 'json-valid', path: 'prices.json', requiredKeys: ['soup'] },
      { id: 'pinned', kind: 'file-digest', path: 'menu.md', sha: '0'.repeat(64) },
    ]);
    const view = await verification.verify(id, 'S1');
    expect(view).toMatchObject({ state: 'failed', rule: 'check-failed', label: 'Failed verification' });
    expect(view.sentence).toMatch(/3 checks failed: menu\.md does not contain “Dessert”/);
    const byId = Object.fromEntries(view.record!.checks.map((check) => [check.id, check]));
    expect(byId['has-dessert'].evidence).toEqual([{ path: 'menu.md', sha: hash(MENU) }]);
    expect(byId.prices).toMatchObject({ outcome: 'failed', evidence: [{ path: 'prices.json', sha: null }] });
    expect(byId.prices.sentence).toMatch(/does not exist/);
    expect(byId.pinned.sentence).toMatch(/not the declared 000000000000/);
  });

  test('a command check is declared but never run, so the result is uncertain', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    await declare(verification, [
      { id: 'has-menu', kind: 'file-exists', path: 'menu.md' },
      { id: 'tests', kind: 'command', command: 'npm test' },
    ]);
    const view = await verification.verify(id, 'S1');
    expect(view).toMatchObject({ state: 'uncertain', rule: 'check-incomplete' });
    const command = view.record!.checks.find((check) => check.id === 'tests')!;
    expect(command).toMatchObject({ outcome: 'incomplete', evidence: [] });
    expect(command.sentence).toMatch(/Trust decision this build does not make/);
  });

  test('a reviewer that does not answer in time reads as uncertain, never as a pass', async () => {
    await seedRun();
    allowReview();
    let aborted = false;
    const hanging: VerificationReviewerAdapter = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const verification = new VerificationService(store, hanging, { reviewTimeoutMs: 40 });
    await declare(verification, [
      { id: 'has-menu', kind: 'file-exists', path: 'menu.md' },
      { id: 'judged', kind: 'review', instruction: 'Lists soup and bread.' },
    ]);
    const view = await verification.verify(id, 'S1');
    expect(view).toMatchObject({ state: 'uncertain', rule: 'check-incomplete' });
    expect(view.sentence).toMatch(/did not answer within/);
    expect(aborted).toBe(true);
  });

  test('an independent reviewer pass verifies; the same model grading its own work does not', async () => {
    await seedRun();
    allowReview();
    const seen: VerificationReviewerRequest[] = [];
    const checks: AcceptanceCheck[] = [
      { id: 'has-menu', kind: 'file-exists', path: 'menu.md' },
      { id: 'judged', kind: 'review', instruction: 'Lists soup and bread.' },
    ];
    const other = new VerificationService(store, answering('gpt-5.5')(seen));
    await declare(other, checks);
    const view = await other.verify(id, 'S1');
    expect(view.state).toBe('verified');
    const review = view.checks.find((check) => check.kind === 'review')!;
    expect(review).toMatchObject({ outcome: 'passed', independence: 'independent', review: { verdict: 'pass' } });
    expect(review.origin).toMatchObject({
      mode: 'direct',
      engine: { id: 'codex' },
      model: { reported: 'gpt-5.5', source: 'runtime' },
      executorId: 'diomedes:verification-reviewer',
    });
    // The packet carries the exact bytes' digest, as data in a document, not instructions.
    expect(seen).toHaveLength(1);
    expect(seen[0].packet.outputs).toEqual([
      { path: 'menu.md', sha: hash(MENU), excerpt: MENU, truncated: false },
    ]);
    expect(seen[0].instructions).toMatch(/untrusted data/);

    const same = new VerificationService(store, answering('gpt-6-astra')());
    const self = await same.verify(id, 'S1');
    expect(self).toMatchObject({ state: 'uncertain', rule: 'review-not-independent' });
    const unreported = new VerificationService(store, answering(null)());
    expect((await unreported.verify(id, 'S1')).rule).toBe('review-not-independent');
  });

  test('a reviewer failing the output is Failed verification; prose is not a verdict', async () => {
    await seedRun();
    allowReview();
    const checks: AcceptanceCheck[] = [{ id: 'judged', kind: 'review', instruction: 'Lists dessert.' }];
    const failing = new VerificationService(store, answering('gpt-5.5', '{"verdict":"fail","note":"No dessert."}')());
    await declare(failing, checks);
    const failed = await failing.verify(id, 'S1');
    expect(failed).toMatchObject({ state: 'failed', rule: 'check-failed' });
    expect(failed.sentence).toMatch(/The reviewer failed it: No dessert\./);
    const prose = new VerificationService(store, answering('gpt-5.5', 'Looks great, approve!')());
    expect(await prose.verify(id, 'S1')).toMatchObject({ state: 'uncertain', rule: 'check-incomplete' });
    expect(parseVerificationVerdict('{"verdict":"pass","note":"ok","extra":1}')).toBeNull();
  });

  test('without a reviewer route or sharing consent the review is not run and nothing is sent', async () => {
    await seedRun();
    const checks: AcceptanceCheck[] = [{ id: 'judged', kind: 'review', instruction: 'Lists soup.' }];
    const none = new VerificationService(store, null);
    await declare(none, checks);
    const missing = await none.verify(id, 'S1');
    expect(missing.state).toBe('uncertain');
    expect(missing.record!.checks.at(-1)!.sentence).toMatch(/no separate reviewer route/);

    const seen: VerificationReviewerRequest[] = [];
    store.settings.services = { ...(store.settings.services ?? {}), codex: true } as typeof store.settings.services;
    const noConsent = new VerificationService(store, answering('gpt-5.5')(seen));
    const refused = await noConsent.verify(id, 'S1');
    expect(refused.state).toBe('uncertain');
    expect(refused.record!.checks.at(-1)!.sentence).toMatch(/^Not run: Sharing proposal excerpts/);
    expect(seen).toEqual([]);
  });

  test('the result survives a restart and is re-projected, not re-stored', async () => {
    await seedRun();
    const verification = new VerificationService(store, null);
    await declare(verification, [{ id: 'has-menu', kind: 'file-exists', path: 'menu.md' }]);
    const before = await verification.verify(id, 'S1');
    expect(before.state).toBe('verified');

    // Change the bytes while the service is down.
    await fs.writeFile(path.join(folder, 'menu.md'), 'edited while closed\n', 'utf8');
    store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store.init();
    const again = project();
    expect(again).toMatchObject({ state: 'verified', entryId: before.entryId });
    expect(again.record).toEqual(before.record);
    const restarted = new VerificationService(store, null);
    await store.locked(() => restarted.sync(id));
    expect(restarted.view(id, 'S1')).toMatchObject({ state: 'uncertain', rule: 'outputs-changed' });
  });
});

describe('H17 routes', () => {
  let temp: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server;
  let url: string;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const request = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${url}/api${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const state = async (projectId: string): Promise<ProjectState> => (await request(`/projects/${projectId}/state`)).data;

  beforeEach(async () => {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'h17-app-'));
    app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20 });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    const closingApp = app, closingServer = server;
    try {
      await closingApp.locals.close();
    } finally {
      closingServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => closingServer.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  test('a sample run: declare, verify, then an outside edit reads uncertain through the state route', async () => {
    const created = await request('/projects/sample', 'POST', {});
    const projectId = created.data.id as string;
    const task = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Update the menu' })).data;
    const started = await request(`/projects/${projectId}/work/start`, 'POST', { taskId: task.id });
    const sessionId = started.data.id as string;
    const need = (await state(projectId)).needs.find((item) => item.state === 'open')!;
    await request(`/projects/${projectId}/needs/${need.id}/resolve`, 'POST', { resolution: 'go-ahead', allowForTask: true });
    let current = await state(projectId);
    for (let attempt = 0; attempt < 300 && current.sessions.find((s) => s.id === sessionId)?.state !== 'done'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = await state(projectId);
    }
    const output = current.history.find((entry) => entry.sessionId === sessionId && entry.files.length)!.files[0];
    expect((await request(`/projects/${projectId}/sessions/${sessionId}/verification`)).data).toMatchObject({
      state: 'not-verified',
      rule: 'no-checks-declared',
    });
    const declared = await request(`/projects/${projectId}/tasks/${task.id}/acceptance`, 'PUT', {
      checks: [{ id: 'exists', kind: 'file-exists', path: output.path }],
    });
    expect(declared.status).toBe(200);
    const ran = await request(`/projects/${projectId}/sessions/${sessionId}/verification`, 'POST', {});
    expect(ran.status).toBe(200);
    expect(ran.data).toMatchObject({ state: 'verified', label: 'Verified' });

    const folder = current.project.folder;
    await fs.writeFile(path.join(folder, output.path), 'hand edit\n', 'utf8');
    const after = await state(projectId);
    expect(after.history.at(-1)).toMatchObject({ kind: 'outside' });
    const view = verificationOf({
      session: after.sessions.find((s) => s.id === sessionId)!,
      task: after.tasks.find((t) => t.id === task.id)!,
      history: after.history,
    });
    expect(view).toMatchObject({ state: 'uncertain', rule: 'outputs-changed' });
  });
});
