/**
 * H13 slice 2 / H14: the change set a sandboxed child returns. An entry inside
 * the scope the person gave the loop is applied through the one recorded
 * writer, attributed to the model that wrote it; anything else waits under an
 * ordinary Need; a file that moved on after the snapshot is a conflict and is
 * never written over; a person keeps or discards each entry, or part of one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OriginSnapshot } from '../shared/attribution.js';
import type { SandboxManifest } from '../shared/sandbox.js';
import { Store } from '../server/store.js';
import { SandboxStore } from '../server/sandbox/sandbox.js';
import { ChangeSetService } from '../server/sandbox/change-sets.js';

let base: string, store: Store, sandboxes: SandboxStore, changeSets: ChangeSetService;
let projectId: string, folder: string, taskId: string;
const SESSION = 'S-loop';
const MODEL: OriginSnapshot = {
  protocolVersion: 1,
  mode: 'direct',
  engine: { id: 'google-vertex', version: 'v1' },
  model: { requested: 'gemini-3.8-flash-001', reported: 'gemini-3.8-flash-001', source: 'runtime' },
};
const PRICES = '# Prices\n\nSoup 6\nBread 3\nPie 5\n\n\n\n\n\n\nTea 2\n';

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegate-change-sets-')));
  store = new Store(path.join(base, 'data'), path.join(base, 'projects'));
  await store.init();
  sandboxes = new SandboxStore(store, store.dataDir);
  changeSets = new ChangeSetService(store, sandboxes);
  const project = await store.locked(() => store.createProject('Bistro'));
  projectId = project.id;
  folder = project.folder;
  await fs.mkdir(path.join(folder, 'Menu'));
  await fs.mkdir(path.join(folder, 'Staff'));
  await fs.writeFile(path.join(folder, 'Menu', 'Prices.md'), PRICES);
  await fs.writeFile(path.join(folder, 'Staff', 'Rota.md'), '# Rota\n\nMon: Ana\n');
  taskId = await store.locked(async () => {
    const task = store.createTask(store.state(projectId), { name: 'Update the menu' });
    await store.persist(store.state(projectId));
    return task.id;
  });
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function sandbox(scope: readonly string[] | null, runId = 'Rloop-d0', parent = 'Rloop', depth = 1, fromSandbox?: string) {
  return sandboxes.create({
    projectId,
    runId,
    parentRunId: parent,
    rootRunId: 'Rloop',
    depth,
    role: 'delegate',
    base: fromSandbox ? { kind: 'sandbox', runId: fromSandbox } : { kind: 'project' },
    scope,
  });
}
/** What a child's `write_file` leaves in its copy. */
const childWrites = (manifest: SandboxManifest, relative: string, text: string) =>
  sandboxes.writeInto(manifest, relative, text);
const record = (manifest: SandboxManifest, applyScope: readonly string[] | null) =>
  changeSets.record({ manifest, handoffId: `${manifest.runId}-h`, taskId, sessionId: SESSION, origin: MODEL, models: [{ engine: 'google-vertex', reported: 'gemini-3.8-flash-001', calls: 2 }], applyScope });
const read = (relative: string) => fs.readFile(path.join(folder, ...relative.split('/')), 'utf8');

describe('settling a change set into the project', () => {
  test('an in-scope change applies through the recorded writer, attributed to the model that wrote it', async () => {
    const manifest = await sandbox(['Menu']);
    await childWrites(manifest, 'Menu/Prices.md', PRICES.replace('Soup 6', 'Soup 7'));
    // Until the parent applies, the project holds what it held.
    expect(await read('Menu/Prices.md')).toBe(PRICES);
    const recorded = await record(manifest, ['Menu']);
    expect(recorded.entries).toEqual([expect.objectContaining({ path: 'Menu/Prices.md', op: 'modified', proposed: false })]);
    // Recording removes the copy; the texts stay, kept by sha.
    await expect(fs.lstat(sandboxes.work(projectId, manifest.runId))).rejects.toThrow();
    const summary = await changeSets.settleIntoProject(recorded, { canWrite: true });
    expect(summary).toMatchObject({ applied: ['Menu/Prices.md'], waiting: [], conflicts: [], needId: null });
    expect(await read('Menu/Prices.md')).toContain('Soup 7');
    const state = store.state(projectId);
    const entry = state.history.find((item) => item.kind === 'delegate-change')!;
    expect(entry.actor).toBe('diomedes');
    expect(entry.origin).toMatchObject({ mode: 'direct', model: { reported: 'gemini-3.8-flash-001', source: 'runtime' } });
    expect(entry.sessionId).toBe(SESSION);
    // It is an ordinary waiting Change of the loop's run, so P06's review, keep and Undo apply.
    expect(state.changes.find((change) => change.entryId === entry.id)).toMatchObject({ path: 'Menu/Prices.md', state: 'waiting', sessionId: SESSION });
    expect(state.needs).toHaveLength(0);
    // Settling again changes nothing.
    await changeSets.settleIntoProject(recorded, { canWrite: true });
    expect(store.state(projectId).history.filter((item) => item.kind === 'delegate-change')).toHaveLength(1);
  });

  test('an out-of-scope change becomes a Need, and the project is untouched until a person keeps it', async () => {
    const manifest = await sandbox(null);
    await childWrites(manifest, 'Menu/Prices.md', PRICES.replace('Soup 6', 'Soup 7'));
    await childWrites(manifest, 'Staff/Rota.md', '# Rota\n\nMon: Bo\n');
    const recorded = await record(manifest, ['Menu']);
    const summary = await changeSets.settleIntoProject(recorded, { canWrite: true });
    expect(summary.applied).toEqual(['Menu/Prices.md']);
    expect(summary.waiting).toEqual(['Staff/Rota.md']);
    expect(await read('Staff/Rota.md')).toBe('# Rota\n\nMon: Ana\n');
    const need = store.state(projectId).needs.find((item) => item.changeSet)!;
    expect(need).toMatchObject({
      state: 'open',
      sessionId: SESSION,
      taskId,
      files: ['Staff/Rota.md'],
      changeSet: { changeSetId: recorded.id, indexes: [1] },
      origin: { model: { reported: 'gemini-3.8-flash-001' } },
    });
    expect(need.why).toMatch(/outside what this loop may apply \(Menu\)/);
    const waiting = await changeSets.view(projectId, recorded.id);
    expect(waiting.entries[1]).toMatchObject({ state: 'waiting', decision: { needId: need.id } });
    const kept = await store.locked(() =>
      changeSets.decide(projectId, recorded.id, { protocolVersion: 1, commandId: 'keep-rota', decisions: [{ index: 1, decision: 'keep' }] }),
    );
    expect(kept.entries[1].state).toBe('kept');
    expect(await read('Staff/Rota.md')).toBe('# Rota\n\nMon: Bo\n');
    const entry = store.state(projectId).history.find((item) => item.kind === 'delegate-change-kept')!;
    expect(entry).toMatchObject({ actor: 'you', sessionId: null });
    expect(entry.sentence).toMatch(/You kept a sub-task's change to Staff\/Rota\.md, written by gemini-3\.8-flash-001/);
    expect(store.state(projectId).needs.find((item) => item.id === need.id)!.state).toBe('go-ahead');
    // The same command again is a replay, not a second write.
    await store.locked(() =>
      changeSets.decide(projectId, recorded.id, { protocolVersion: 1, commandId: 'keep-rota', decisions: [{ index: 1, decision: 'keep' }] }),
    );
    expect(store.state(projectId).history.filter((item) => item.kind === 'delegate-change-kept')).toHaveLength(1);
  });

  test('with no scope to apply in, a proposed file, or a deletion, everything waits for a person', async () => {
    const manifest = await sandbox(['Menu', 'Staff']);
    await childWrites(manifest, 'Menu/Prices.md', PRICES.replace('Soup 6', 'Soup 7'));
    await sandboxes.markProposed(projectId, manifest.runId, ['Menu/Prices.md']);
    await sandboxes.writeInto(manifest, 'Staff/Rota.md', null);
    const recorded = await record(manifest, ['Menu', 'Staff']);
    expect(recorded.entries.map((entry) => [entry.path, entry.op, entry.proposed])).toEqual([
      ['Menu/Prices.md', 'modified', true],
      ['Staff/Rota.md', 'deleted', true],
    ]);
    const summary = await changeSets.settleIntoProject(recorded, { canWrite: true });
    expect(summary.waiting).toEqual(['Menu/Prices.md', 'Staff/Rota.md']);
    const unscoped = await sandbox(['Menu'], 'Rloop-d1');
    await childWrites(unscoped, 'Menu/Prices.md', 'x\n');
    expect((await changeSets.settleIntoProject(await record(unscoped, null), { canWrite: true })).waiting).toEqual(['Menu/Prices.md']);
    const unwritable = await sandbox(['Menu'], 'Rloop-d2');
    await childWrites(unwritable, 'Menu/Prices.md', 'y\n');
    expect((await changeSets.settleIntoProject(await record(unwritable, ['Menu']), { canWrite: false })).waiting).toEqual(['Menu/Prices.md']);
    expect(await read('Menu/Prices.md')).toBe(PRICES);
    await expect(read('Staff/Rota.md')).resolves.toBe('# Rota\n\nMon: Ana\n');
    // Discarding leaves the project exactly as it is, and answers the Need.
    const need = store.state(projectId).needs.find((item) => item.changeSet?.changeSetId === recorded.id)!;
    await store.locked(() => changeSets.resolveNeed(projectId, need, 'declined', 'decline-all'));
    expect(store.state(projectId).needs.find((item) => item.id === need.id)!.state).toBe('declined');
    expect((await changeSets.view(projectId, recorded.id)).counts).toMatchObject({ discarded: 2 });
    expect(await read('Menu/Prices.md')).toBe(PRICES);
  });

  test('a project change made after the snapshot is a conflict, and it is never written over', async () => {
    const manifest = await sandbox(['Menu']);
    await childWrites(manifest, 'Menu/Prices.md', PRICES.replace('Soup 6', 'Soup 7'));
    // Someone edits the project while the sub-task works.
    await fs.writeFile(path.join(folder, 'Menu', 'Prices.md'), PRICES.replace('Tea 2', 'Tea 3'));
    const recorded = await record(manifest, ['Menu']);
    const summary = await changeSets.settleIntoProject(recorded, { canWrite: true });
    expect(summary).toMatchObject({ applied: [], conflicts: ['Menu/Prices.md'] });
    expect(await read('Menu/Prices.md')).toBe(PRICES.replace('Tea 2', 'Tea 3'));
    const view = await changeSets.view(projectId, recorded.id);
    expect(view.entries[0].decision!.reason).toMatch(/changed by someone outside Diomedes after the sub-task's copy was taken, so nothing was written over it/);
    // A conflict is decided; it cannot be kept over the newer file.
    await expect(
      store.locked(() => changeSets.decide(projectId, recorded.id, { protocolVersion: 1, commandId: 'force', decisions: [{ index: 0, decision: 'keep' }] })),
    ).rejects.toMatchObject({ status: 409 });
    // The same is true for a waiting entry a person keeps late.
    const late = await sandbox(null, 'Rloop-d1');
    await childWrites(late, 'Staff/Rota.md', '# Rota\n\nMon: Bo\n');
    const lateRecord = await record(late, ['Menu']);
    await changeSets.settleIntoProject(lateRecord, { canWrite: true });
    await fs.writeFile(path.join(folder, 'Staff', 'Rota.md'), '# Rota\n\nMon: Cy\n');
    const decided = await store.locked(() =>
      changeSets.decide(projectId, lateRecord.id, { protocolVersion: 1, commandId: 'late', decisions: [{ index: 0, decision: 'keep' }] }),
    );
    expect(decided.entries[0].state).toBe('conflict');
    expect(await read('Staff/Rota.md')).toBe('# Rota\n\nMon: Cy\n');
  });

  test('a person may keep part of a waiting change, hunk by hunk, with P06’s readable diff', async () => {
    const manifest = await sandbox(null);
    await childWrites(manifest, 'Menu/Prices.md', PRICES.replace('Soup 6', 'Soup 7').replace('Tea 2', 'Tea 4'));
    const recorded = await record(manifest, []);
    await changeSets.settleIntoProject(recorded, { canWrite: true });
    const { diff, before, after } = await changeSets.diff(projectId, recorded.id, 0);
    expect(before).toBe(PRICES);
    expect(after).toContain('Tea 4');
    expect(diff.hunks).toHaveLength(2);
    expect(diff.header).toMatch(/Menu\/Prices\.md/);
    await store.locked(() =>
      changeSets.decide(projectId, recorded.id, { protocolVersion: 1, commandId: 'part', decisions: [{ index: 0, decision: 'keep', hunks: [1] }] }),
    );
    const now = await read('Menu/Prices.md');
    expect(now).toContain('Soup 6');
    expect(now).toContain('Tea 4');
    expect((await changeSets.view(projectId, recorded.id)).entries[0]).toMatchObject({ state: 'kept', decision: { hunks: [1] } });
  });
});

describe('a depth-2 change set settles into its parent delegate’s copy', () => {
  test('its changes reach the delegate’s copy, never the project, and a proposal stays a proposal', async () => {
    const parent = await sandbox(['Menu']);
    const nested = await sandbox(['Menu'], 'Rloop-d0-d0', parent.runId, 2, parent.runId);
    await childWrites(nested, 'Menu/Prices.md', PRICES.replace('Soup 6', 'Soup 8'));
    await childWrites(nested, 'Menu/Specials.md', '# Specials\n');
    await sandboxes.markProposed(projectId, nested.runId, ['Menu/Specials.md']);
    const recorded = await changeSets.record({ manifest: nested, handoffId: 'h', taskId, sessionId: SESSION, origin: MODEL, models: [], applyScope: null });
    const summary = await changeSets.settleIntoSandbox(recorded, parent);
    expect([...summary.applied].sort()).toEqual(['Menu/Prices.md', 'Menu/Specials.md']);
    expect(await read('Menu/Prices.md')).toBe(PRICES);
    const carried = await changeSets.record({ manifest: parent, handoffId: 'h0', taskId, sessionId: SESSION, origin: MODEL, models: [], applyScope: ['Menu'] });
    expect(carried.entries.map((entry) => [entry.path, entry.proposed])).toEqual([
      ['Menu/Prices.md', false],
      ['Menu/Specials.md', true],
    ]);
  });
});
