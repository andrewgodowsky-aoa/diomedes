import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store, hash } from '../server/store.js';
import { keepPartially } from '../server/change-review/partial-keep.js';
import { documentDiff, ReviewComments } from '../server/review-comments.js';
import { VerificationService } from '../server/verification/service.js';
import { createApp } from '../server/app.js';
import { verificationOf } from '../shared/verification.js';
import { directOrigin } from '../shared/attribution.js';
import { revisionRequest, type ReviewComment } from '../shared/review-comments.js';
import type { QueueFollowUpRequest, FollowUpCommand } from '../shared/work-control.js';
import type { ProjectState, Session, Task } from '../shared/types.js';

/**
 * P06: a waiting Change kept hunk by hunk as one recorded, base-hash-checked
 * write whose History entry says exactly what was kept and undone and by whom;
 * the conflict when the file moved on; review comments that persist, resolve
 * and reach a run only as a visible follow-up; readable diffs between History
 * versions; and H17's result turning uncertain when a partial keep changes the
 * verified bytes.
 */

const ORIGINAL = ['# Prices', '', 'Soup $7', 'Bread $3', 'Tea $2', 'Coffee $3', 'Cake $5', 'Pie $6', 'Juice $4', ''].join('\n');
// Three places: a raised price, a removed line and an added line.
const PROPOSED = ORIGINAL.replace('Soup $7', 'Soup $8').replace('Coffee $3\n', '') + 'Water $1\n';
const PATH = 'Menu/Prices.md';
const WORKER = directOrigin({ engine: 'codex', reportedModel: 'gpt-6-astra', version: '0.153.4' });

let root: string;
let store: Store;
let id: string;
let folder: string;

async function seedRun(sessionState: Session['state'] = 'done', proposed = PROPOSED) {
  await fs.mkdir(path.join(folder, 'Menu'), { recursive: true });
  await store.locked(() => store.writeRecorded(id, [{ path: PATH, text: ORIGINAL, expected: null }]));
  const state = store.state(id);
  const task: Task = {
    id: 'T1',
    name: 'Update the menu prices',
    description: 'Raise soup, drop coffee, add water.',
    from: null,
    owner: 'diomedes',
    state: 'working',
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
    store.writeRecorded(id, [{ path: PATH, text: proposed, expected: hash(ORIGINAL) }], {
      actor: 'diomedes-with-ok',
      kind: 'changed',
      sessionId: 'S1',
      taskId: 'T1',
      origin: WORKER,
      review: true,
    }),
  );
  const after = store.state(id);
  const stored = after.sessions.find((item) => item.id === 'S1')!;
  stored.state = sessionState;
  stored.endedAt = sessionState === 'done' ? '2026-09-24T00:00:05.000Z' : null;
  after.tasks[0].state = 'waiting';
  await store.persist(after);
  return after.changes.find((change) => change.path === PATH)!;
}

const read = () => fs.readFile(path.join(folder, PATH), 'utf8');
const keep = (changeId: string, body: unknown) => store.locked(() => keepPartially(store, id, changeId, body));

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-p06-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  const created = await store.createProject('Menu fixture');
  id = created.id;
  folder = created.folder;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('P06 partial keep', () => {
  test('keeping two of three hunks writes one recorded revision with the exact decisions as evidence', async () => {
    const change = await seedRun();
    expect(change.state).toBe('waiting');
    const before = store.state(id).history.length;
    const result = await keep(change.id, { after: hash(PROPOSED), keep: [0, 2], undo: [1] });
    const expected = ORIGINAL.replace('Soup $7', 'Soup $8') + 'Water $1\n';
    expect(await read()).toBe(expected);

    const state = store.state(id);
    expect(state.history.length).toBe(before + 2); // the write, and the task moving to Done
    const entry = state.history.find((item) => item.id === result.entryId)!;
    expect(entry).toMatchObject({
      kind: 'partial-keep',
      actor: 'you',
      sessionId: null,
      taskId: 'T1',
      sentence: `You kept 2 of 3 changes to ${PATH} and undid 1`,
      files: [{ path: PATH, op: 'modified', before: hash(PROPOSED), after: hash(expected), recorded: true }],
    });
    expect(entry.origin?.mode).toBe('application');
    const record = entry.hunkReview!;
    expect(record).toMatchObject({
      changeId: change.id,
      sourceEntryId: change.entryId,
      path: PATH,
      beforeSha: hash(ORIGINAL),
      afterSha: hash(PROPOSED),
      resultSha: hash(expected),
      by: 'you',
    });
    expect(record.hunks.map((h) => [h.index, h.decision, h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [0, 'kept', 3, 1, 3, 1],
      [1, 'undone', 6, 1, 5, 0],
      [2, 'kept', 9, 0, 9, 1],
    ]);
    expect(record.hunks.every((h) => /^[a-f0-9]{64}$/.test(h.sha))).toBe(true);

    const settled = state.changes.find((item) => item.id === change.id)!;
    expect(settled).toMatchObject({ state: 'kept', partial: { entryId: entry.id, kept: [0, 2], undone: [1] } });
    expect(state.tasks[0].state).toBe('done');

    // The evidence survives a restart exactly.
    const again = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await again.init();
    const reloaded = again.state(id);
    expect(reloaded.history.find((item) => item.id === entry.id)!.hunkReview).toEqual(record);
    expect(reloaded.changes.find((item) => item.id === change.id)!.partial).toEqual(settled.partial);
  });

  test('a file that moved on after the run is refused with a conflict and nothing is written', async () => {
    const change = await seedRun();
    const mine = `${PROPOSED}Note from me\n`;
    await store.locked(() => store.writeRecorded(id, [{ path: PATH, text: mine, expected: hash(PROPOSED) }]));
    const before = store.state(id).history.length;
    await expect(keep(change.id, { after: hash(PROPOSED), keep: [0], undo: [1, 2] })).rejects.toMatchObject({
      status: 409,
      message: `${PATH} was changed by you after this change was made, so nothing was written. Review it again against the current file.`,
      details: { code: 'change_conflict', path: PATH, expectedSha: hash(PROPOSED), currentSha: hash(mine) },
    });
    expect(await read()).toBe(mine);
    expect(store.state(id).history.length).toBe(before);
    expect(store.state(id).changes.find((item) => item.id === change.id)!.state).toBe('waiting');

    // An edit Diomedes never recorded is named as such.
    await fs.writeFile(path.join(folder, PATH), 'edited by hand\n', 'utf8');
    await expect(keep(change.id, { after: hash(PROPOSED), keep: [0], undo: [1, 2] })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('changed by someone outside Diomedes'),
    });
    expect(await read()).toBe('edited by hand\n');
  });

  test('a stale review, an undecided hunk and a one-sided choice are refused before anything is written', async () => {
    const change = await seedRun();
    const before = store.state(id).history.length;
    await expect(keep(change.id, { after: hash(ORIGINAL), keep: [0], undo: [1, 2] })).rejects.toMatchObject({
      status: 409,
      details: { code: 'change_moved' },
    });
    await expect(keep(change.id, { after: hash(PROPOSED), keep: [0], undo: [1] })).rejects.toMatchObject({ status: 400 });
    await expect(keep(change.id, { after: hash(PROPOSED), keep: [0, 0], undo: [1, 2] })).rejects.toMatchObject({ status: 400 });
    await expect(keep(change.id, { after: hash(PROPOSED), keep: [0, 1, 2], undo: [] })).rejects.toMatchObject({
      status: 400,
      message: 'Every change is kept, so use Keep.',
    });
    await expect(keep(change.id, { after: hash(PROPOSED), keep: [0], undo: [1, 7] })).rejects.toMatchObject({ status: 400 });
    await expect(keep(change.id, { keep: [0], undo: [1, 2] })).rejects.toMatchObject({ status: 400 });
    expect(await read()).toBe(PROPOSED);
    expect(store.state(id).history.length).toBe(before);
  });

  test('a one-hunk change and a change whose run is still working are refused', async () => {
    const one = await seedRun('done', ORIGINAL.replace('Soup $7', 'Soup $8'));
    await expect(keep(one.id, { after: hash(ORIGINAL.replace('Soup $7', 'Soup $8')), keep: [0], undo: [] })).rejects.toMatchObject({
      status: 409,
      message: 'This change has one part, so keep or undo it whole.',
    });
    const state = store.state(id);
    state.sessions[0].state = 'working';
    await store.persist(state);
    await expect(keep(one.id, { after: hash(ORIGINAL.replace('Soup $7', 'Soup $8')), keep: [0], undo: [1] })).rejects.toMatchObject({
      status: 409,
      message: 'The run that made this change is still working. Wait for it to finish.',
    });
  });

  test('a partial keep flips a Verified result to uncertain against the new digest (H17)', async () => {
    const change = await seedRun();
    const verification = new VerificationService(store, null);
    await store.locked(() =>
      verification.declare(id, 'T1', {
        checks: [{ id: 'has-water', kind: 'text-contains', path: PATH, text: 'Water $1' }],
      }),
    );
    const project = () => {
      const state = store.state(id);
      return verificationOf({ session: state.sessions[0], task: state.tasks[0], history: state.history });
    };
    expect((await verification.verify(id, 'S1')).state).toBe('verified');
    expect(project().state).toBe('verified');
    // The kept result still contains the checked text, but it is not the bytes that were verified.
    await keep(change.id, { after: hash(PROPOSED), keep: [0, 2], undo: [1] });
    const result = ORIGINAL.replace('Soup $7', 'Soup $8') + 'Water $1\n';
    expect(project()).toMatchObject({
      state: 'uncertain',
      rule: 'outputs-changed',
      changed: [{ path: PATH, verified: hash(PROPOSED), current: hash(result) }],
    });
  });
});

describe('P06 review comments', () => {
  let queued: QueueFollowUpRequest[];
  let refuse: string | null;
  const comments = () =>
    new ReviewComments(store, async (_projectId, request) => {
      if (refuse) throw new Error(refuse);
      queued.push(request);
      return { id: `F${queued.length}`, ...request } as unknown as FollowUpCommand;
    });
  beforeEach(() => {
    queued = [];
    refuse = null;
  });

  test('a comment anchors to a changed line, quotes the recorded text, and persists', async () => {
    const change = await seedRun();
    const service = comments();
    const comment = await store.locked(() =>
      service.add(id, { target: { kind: 'change', changeId: change.id }, side: 'new', line: 3, text: 'Soup should be $9.' }),
    );
    expect(comment).toMatchObject({
      target: { kind: 'change', changeId: change.id, path: PATH, sha: hash(PROPOSED) },
      taskId: 'T1',
      anchor: { hunk: 0, side: 'new', line: 3, quote: 'Soup $8' },
      text: 'Soup should be $9.',
      by: 'you',
      resolved: null,
      sent: null,
    });
    // A removed line is anchored on the earlier side; a context line has no hunk.
    const removed = await store.locked(() =>
      service.add(id, { target: { kind: 'change', changeId: change.id }, side: 'old', line: 6, text: 'Keep coffee.' }),
    );
    expect(removed.anchor).toEqual({ hunk: 1, side: 'old', line: 6, quote: 'Coffee $3' });
    const context = await store.locked(() =>
      service.add(id, { target: { kind: 'change', changeId: change.id }, side: 'new', line: 1, text: 'Title is fine.' }),
    );
    expect(context.anchor.hunk).toBeNull();

    const again = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await again.init();
    expect(again.state(id).reviewComments).toEqual([comment, removed, context]);
  });

  test('a line outside the text, a wrong hunk, empty text and an old-side version comment are refused', async () => {
    const change = await seedRun();
    const service = comments();
    const add = (body: unknown) => store.locked(() => service.add(id, body));
    await expect(add({ target: { kind: 'change', changeId: change.id }, side: 'new', line: 99, text: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(add({ target: { kind: 'change', changeId: change.id }, side: 'new', line: 3, hunk: 2, text: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(add({ target: { kind: 'change', changeId: change.id }, side: 'new', line: 3, text: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(add({ target: { kind: 'change', changeId: 'nope' }, side: 'new', line: 3, text: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(add({ target: { kind: 'version', path: PATH, sha: hash(ORIGINAL) }, side: 'old', line: 1, text: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(add({ target: { kind: 'version', path: PATH, sha: 'a'.repeat(64) }, side: 'new', line: 1, text: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(store.state(id).reviewComments ?? []).toEqual([]);
  });

  test('a comment on a recorded file version quotes that version, and resolving keeps it', async () => {
    await seedRun();
    const service = comments();
    const comment = await store.locked(() =>
      service.add(id, { target: { kind: 'version', path: PATH, sha: hash(ORIGINAL) }, side: 'new', line: 6, text: 'Coffee was here.' }),
    );
    expect(comment).toMatchObject({ target: { kind: 'version', path: PATH, sha: hash(ORIGINAL) }, taskId: null, anchor: { hunk: null, quote: 'Coffee $3' } });
    const resolved = await store.locked(() => service.resolve(id, comment.id, { resolved: true }));
    expect(resolved.resolved).toMatchObject({ by: 'you' });
    expect(store.state(id).reviewComments).toHaveLength(1);
    const reopened = await store.locked(() => service.resolve(id, comment.id, { resolved: false }));
    expect(reopened.resolved).toBeNull();
    await expect(store.locked(() => service.resolve(id, 'C-missing', { resolved: true }))).rejects.toMatchObject({ status: 404 });
  });

  test('revise queues exactly the words shown as an ordinary follow-up, and marks only what was sent', async () => {
    const change = await seedRun();
    const service = comments();
    const first = await store.locked(() =>
      service.add(id, { target: { kind: 'change', changeId: change.id }, side: 'new', line: 3, text: 'Soup should be $9.' }),
    );
    const second = await store.locked(() =>
      service.add(id, { target: { kind: 'change', changeId: change.id }, side: 'old', line: 6, text: 'Keep coffee,\nit sells.' }),
    );
    const resolved = await store.locked(() =>
      service.add(id, { target: { kind: 'change', changeId: change.id }, side: 'new', line: 1, text: 'Done already.' }),
    );
    await store.locked(() => service.resolve(id, resolved.id, { resolved: true }));
    const body = { protocolVersion: 1, commandId: 'cmd-1', taskId: 'T1', route: 'codex', note: 'Two notes.' };

    await expect(store.locked(() => service.revise(id, { ...body, commentIds: [resolved.id] }))).rejects.toMatchObject({ status: 409 });
    refuse = 'The queue refused it.';
    await expect(store.locked(() => service.revise(id, { ...body, commentIds: [first.id] }))).rejects.toThrow('The queue refused it.');
    expect(store.state(id).reviewComments!.every((c) => c.sent === null)).toBe(true);
    refuse = null;

    const result = await store.locked(() => service.revise(id, { ...body, commentIds: [first.id, second.id] }));
    const text = revisionRequest([first, second], 'Two notes.');
    expect(text).toBe(
      [
        'Revise your changes with these 2 review comments.',
        '',
        'Two notes.',
        '',
        `1. ${PATH}, change 1, line 3: "Soup $8"`,
        '   Soup should be $9.',
        '',
        `2. ${PATH}, change 2, line 6 of the earlier text: "Coffee $3"`,
        '   Keep coffee,',
        '   it sells.',
      ].join('\n'),
    );
    expect(queued).toEqual([
      {
        protocolVersion: 1,
        commandId: 'cmd-1',
        taskId: 'T1',
        text,
        waitsFor: 'turn',
        route: 'codex',
        model: null,
        agentId: null,
        sources: [PATH],
      },
    ]);
    const stored = store.state(id).reviewComments!;
    expect(stored.find((c) => c.id === first.id)!.sent).toMatchObject({ followUpId: result.followUp.id });
    expect(stored.find((c) => c.id === second.id)!.sent).toMatchObject({ followUpId: result.followUp.id });
    expect(stored.find((c) => c.id === resolved.id)!.sent).toBeNull();
    // Sent is sent: the same comment is not sent twice under a new command.
    await expect(
      store.locked(() => service.revise(id, { ...body, commandId: 'cmd-2', commentIds: [first.id] })),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('another task’s comment cannot ride along', async () => {
    const change = await seedRun();
    const service = comments();
    const comment = await store.locked(() =>
      service.add(id, { target: { kind: 'change', changeId: change.id }, side: 'new', line: 3, text: 'x' }),
    );
    const state = store.state(id);
    state.tasks.push({ ...state.tasks[0], id: 'T2', name: 'Other', sessionIds: [], changeIds: [] });
    await store.persist(state);
    await expect(
      store.locked(() =>
        service.revise(id, { protocolVersion: 1, commandId: 'c', taskId: 'T2', route: 'codex', commentIds: [comment.id] }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(queued).toEqual([]);
  });
});

describe('P06 diffs between History versions', () => {
  test('two recorded versions compare by identity; an unrecorded one is refused', async () => {
    await seedRun();
    const result = await documentDiff(store, id, PATH, hash(ORIGINAL), hash(PROPOSED));
    expect(result.diff).toMatchObject({ state: 'changed', header: `2 lines added, 2 removed in ${PATH}` });
    expect(result.diff.hunks).toHaveLength(3);
    expect(result.from).toMatchObject({ sha: hash(ORIGINAL), versionId: expect.stringMatching(/^v\d{4}$/) });
    expect(result.to).toMatchObject({ sha: hash(PROPOSED) });
    // `to` absent is the current file; `from` absent is the file as first written.
    expect((await documentDiff(store, id, PATH, hash(ORIGINAL), undefined)).diff.hunks).toHaveLength(3);
    expect((await documentDiff(store, id, PATH, undefined, hash(ORIGINAL))).diff.op).toBe('created');
    await expect(documentDiff(store, id, PATH, 'b'.repeat(64), undefined)).rejects.toMatchObject({ status: 404 });
    await expect(documentDiff(store, id, PATH, 'nope', undefined)).rejects.toMatchObject({ status: 400 });
  });

  test('a picture is described as not text', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d60000000049454e44ae426082', 'hex');
    await fs.writeFile(path.join(folder, 'photo.png'), png);
    const result = await documentDiff(store, id, 'photo.png', undefined, undefined);
    expect(result.diff).toMatchObject({ state: 'binary', reason: 'photo.png is not text, so no line differences are shown.' });
  });
});

describe('P06 routes', () => {
  let temp: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server;
  let url: string;
  const request = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${url}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  beforeEach(async () => {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'p06-app-'));
    app = await createApp({ dataDir: path.join(temp, 'data'), projectRoot: path.join(temp, 'projects'), stepMs: 20 });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    try {
      await app.locals.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  test('partial keep, conflict, comments and revise travel the real routes into the follow-up queue', async () => {
    store = app.locals.store as Store;
    const created = await store.createProject('Menu route fixture');
    id = created.id;
    folder = created.folder;
    const change = await seedRun();
    const conflictFree = await request(`/projects/${id}/review/${encodeURIComponent(change.id)}/partial`, 'POST', {
      after: hash(ORIGINAL),
      keep: [0],
      undo: [1, 2],
    });
    expect(conflictFree).toMatchObject({ status: 409, data: { code: 'change_moved' } });

    const comment = await request(`/projects/${id}/review-comments`, 'POST', {
      target: { kind: 'change', changeId: change.id },
      side: 'new',
      line: 3,
      text: 'Soup should be $9.',
    });
    expect(comment.status).toBe(200);
    const listed = await request(`/projects/${id}/review-comments`);
    expect(listed.data.comments).toHaveLength(1);

    const kept = await request(`/projects/${id}/review/${encodeURIComponent(change.id)}/partial`, 'POST', {
      after: hash(PROPOSED),
      keep: [0, 2],
      undo: [1],
    });
    expect(kept.status).toBe(200);
    expect(await read()).toBe(ORIGINAL.replace('Soup $7', 'Soup $8') + 'Water $1\n');

    const diff = await request(
      `/projects/${id}/documents/diff?path=${encodeURIComponent(PATH)}&from=${hash(PROPOSED)}`,
    );
    expect(diff.data.diff).toMatchObject({ state: 'changed', header: `1 line added in ${PATH}` });

    const revise = await request(`/projects/${id}/review-comments/revise`, 'POST', {
      protocolVersion: 1,
      commandId: 'route-revise-1',
      taskId: 'T1',
      route: 'codex',
      commentIds: [comment.data.comment.id],
    });
    expect(revise.status).toBe(200);
    const state = (await request(`/projects/${id}/state`)).data as ProjectState;
    const followUp = state.followUps!.find((item) => item.commandId === 'route-revise-1')!;
    // The task is done after the keep, so the follow-up waits for "the task", and it is visible
    // in the queue with the exact message whatever its delivery then decides.
    expect(followUp).toMatchObject({ taskId: 'T1', waitsFor: 'task', route: 'codex', sources: [PATH] });
    expect(followUp.text).toBe(revisionRequest([comment.data.comment as ReviewComment]));
    expect(state.reviewComments![0].sent).toMatchObject({ followUpId: followUp.id });
    expect(state.history.some((entry) => entry.kind === 'follow-up' && entry.actor === 'you')).toBe(true);
  });
});
