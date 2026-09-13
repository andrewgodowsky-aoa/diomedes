/**
 * The unified-20260913 coordination root: atomic exclusive file claims, one
 * heavy-test/live-call slot, separate journals, and the rule that a missing
 * partner leads to read-only work rather than a second implementation.
 *
 * These tests run against a temporary root; they never touch the real one
 * under the Git common directory.
 */
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimPaths,
  releaseClaim,
  requestSlot,
  releaseSlot,
  workMode,
  writeJournal,
  readJournal,
  CHARTER_HOT_FILES,
  type Owner,
} from '../scripts/coordination.js';

let root = '';
const fable: Owner = {
  role: 'fable',
  host: 'test-host',
  pid: 100,
  processStart: '2026-09-13T01:00:00.000Z',
  worktree: 'F:/wt/fable',
};
const astra: Owner = {
  role: 'astra',
  host: 'test-host',
  pid: 200,
  processStart: '2026-09-13T01:00:01.000Z',
  worktree: 'F:/wt/astra',
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-coordination-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('exclusive file claims', () => {
  test('two workers claiming the same path: exactly one wins, and the loser is told who holds it', async () => {
    const paths = ['server/task-admission.ts', 'tests/task-admission.test.ts'];
    const [first, second] = await Promise.all([
      claimPaths(root, { owner: fable, node: 'C00.I', baseSha: '212106e', paths }),
      claimPaths(root, { owner: astra, node: 'C00.R', baseSha: '212106e', paths }),
    ]);
    const outcomes = [first, second].map((item) => item.ok).sort();
    expect(outcomes).toEqual([false, true]);
    const loser = first.ok ? second : first;
    const winner = first.ok ? first : second;
    if (loser.ok || !winner.ok) throw new Error('unreachable');
    expect(loser.reason).toBe('held');
    expect(loser.heldBy?.claimId).toBe(winner.claim.claimId);
    expect(loser.heldBy?.owner.role).toBe(winner.claim.owner.role);
    // Nothing partial is left behind for the loser.
    const claimFiles = await fs.readdir(path.join(root, 'claims'));
    expect(claimFiles.filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  test('a stale timestamp alone is not permission to steal a claim', async () => {
    const held = await claimPaths(root, {
      owner: { ...astra, processStart: '2026-09-01T00:00:00.000Z' },
      node: 'H01.I',
      baseSha: '212106e',
      paths: ['server/harness/adapters.ts'],
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(held.ok).toBe(true);
    const attempt = await claimPaths(root, {
      owner: fable,
      node: 'H01.I',
      baseSha: '212106e',
      paths: ['server/harness/adapters.ts'],
      now: '2026-09-13T12:00:00.000Z',
    });
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.reason).toBe('held');
    expect(attempt.detail).toMatch(/handoff|release/i);
  });

  test('a released claim can be taken again, and the release record names the releaser', async () => {
    const first = await claimPaths(root, {
      owner: fable,
      node: 'C00.I',
      baseSha: '212106e',
      paths: ['tests/contract-revision.test.ts'],
    });
    if (!first.ok) throw new Error('claim failed');
    await releaseClaim(root, first.claim.claimId, { by: fable, note: 'returned' });
    const second = await claimPaths(root, {
      owner: astra,
      node: 'C00.R',
      baseSha: '212106e',
      paths: ['tests/contract-revision.test.ts'],
    });
    expect(second.ok).toBe(true);
    const released = JSON.parse(
      await fs.readFile(path.join(root, 'claims', first.claim.claimId + '.released.json'), 'utf8'),
    );
    expect(released.releasedBy.role).toBe('fable');
  });

  test('a charter hot file can only be claimed by the integrator', async () => {
    expect(CHARTER_HOT_FILES).toContain('shared/types.ts');
    const attempt = await claimPaths(root, {
      owner: astra,
      node: 'H03.I',
      baseSha: '212106e',
      paths: ['shared/types.ts'],
    });
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.reason).toBe('integrator-owned');
    const integrator = await claimPaths(root, {
      owner: fable,
      node: 'H03.I',
      baseSha: '212106e',
      paths: ['shared/types.ts'],
    });
    expect(integrator.ok).toBe(true);
  });
});

describe('the heavy-test / live-call slot', () => {
  test('two verifiers requesting the slot: one holds it, the other waits with the holder named', async () => {
    const [a, b] = await Promise.all([
      requestSlot(root, { owner: fable, purpose: 'playwright', node: 'C00.I' }),
      requestSlot(root, { owner: astra, purpose: 'playwright', node: 'C00.R' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const waiter = a.ok ? b : a;
    if (waiter.ok) throw new Error('unreachable');
    expect(waiter.heldBy?.purpose).toBe('playwright');
    const holder = a.ok ? a : b;
    if (!holder.ok) throw new Error('unreachable');
    await releaseSlot(root, holder.slot.slotId, { by: holder.slot.owner });
    const again = await requestSlot(root, { owner: astra, purpose: 'vitest-full', node: 'C00.R' });
    expect(again.ok).toBe(true);
  });

  test('releasing with a different owner than the holder is refused', async () => {
    const held = await requestSlot(root, { owner: fable, purpose: 'packaging', node: 'G01' });
    if (!held.ok) throw new Error('unreachable');
    await expect(releaseSlot(root, held.slot.slotId, { by: astra })).rejects.toThrow(/holder/);
  });
});

describe('journals and work mode', () => {
  test('journals are separate per role and append-only', async () => {
    await writeJournal(root, fable, { at: '2026-09-13T01:00:00.000Z', event: 'started C00.I' });
    await writeJournal(root, fable, { at: '2026-09-13T01:01:00.000Z', event: 'claimed paths' });
    await writeJournal(root, astra, { at: '2026-09-13T01:02:00.000Z', event: 'read launcher' });
    expect((await readJournal(root, 'fable')).map((entry) => entry.event)).toEqual([
      'started C00.I',
      'claimed paths',
    ]);
    expect(await readJournal(root, 'astra')).toHaveLength(1);
  });

  test('a missing partner journal leads to read-only work, not a second implementation', async () => {
    const mode = await workMode(root, {
      me: fable,
      partner: 'astra',
      wantsToEdit: ['server/harness/adapters.ts'],
    });
    expect(mode.mode).toBe('read-only');
    expect(mode.why).toMatch(/astra/);
    await writeJournal(root, astra, { at: '2026-09-13T01:02:00.000Z', event: 'present' });
    const present = await workMode(root, {
      me: fable,
      partner: 'astra',
      wantsToEdit: ['server/harness/adapters.ts'],
    });
    expect(present.mode).toBe('edit');
  });

  test('a non-integrator asking to edit a hot file is read-only even with the partner present', async () => {
    await writeJournal(root, fable, { at: '2026-09-13T01:02:00.000Z', event: 'present' });
    const mode = await workMode(root, {
      me: astra,
      partner: 'fable',
      wantsToEdit: ['server/app.ts'],
    });
    expect(mode.mode).toBe('read-only');
    expect(mode.why).toMatch(/integrator/);
  });
});
