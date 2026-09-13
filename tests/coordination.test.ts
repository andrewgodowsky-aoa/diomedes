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
  PROGRAM,
  canonicalPath,
  coordinationLayout,
  isHotFile,
  issueHandoff,
  orderEntryName,
  ownerFromArgs,
  processStartOf,
  type Claim,
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

// --- C00.R repair: C00-R1 path identity and overlap, C00-R2 handoffs, C00-R3 identity ---

const keyOf = (spelling: string) => {
  const result = canonicalPath(spelling);
  if (!result.ok) throw new Error(`${spelling}: ${result.detail}`);
  return result.value.key;
};
/** Test-local overlap: equal identities, or one is a directory above the other. */
const overlaps = (left: readonly string[], right: readonly string[]) =>
  left.some((a) =>
    right.some((b) => {
      const [x, y] = [keyOf(a), keyOf(b)];
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
    }),
  );
const worker = (index: number): Owner => ({
  ...astra,
  pid: 1000 + index,
  worktree: `F:/wt/contender-${index}`,
});
const expectHeld = (result: Awaited<ReturnType<typeof claimPaths>>) => {
  if (result.ok) throw new Error(`expected a refusal, got claim ${result.claim.claimId}`);
  return result;
};

describe('canonical path identity', () => {
  test('spellings of one repository path resolve to one identity', () => {
    const spellings = [
      'tests/a.ts',
      './tests/a.ts',
      'tests\\a.ts',
      'TESTS/A.TS',
      'tests/../tests/a.ts',
      'tests//a.ts',
      'tests/./a.ts',
    ];
    expect(new Set(spellings.map(keyOf))).toEqual(new Set(['tests/a.ts']));
    expect(canonicalPath('evidence/unified-20260913/')).toEqual({
      ok: true,
      value: {
        path: 'evidence/unified-20260913/',
        key: 'evidence/unified-20260913',
        directory: true,
      },
    });
    expect(canonicalPath('evidence/x/..')).toEqual({
      ok: true,
      value: { path: 'evidence/', key: 'evidence', directory: true },
    });
  });

  test.each([
    '',
    '   ',
    '.',
    'tests/..',
    '/etc/passwd',
    '\\\\server\\share\\a.ts',
    'C:/Diomedes/a.ts',
    'c:a.ts',
    '../outside.ts',
    'tests/../../outside.ts',
    'a.ts:stream',
    'con',
    'tests/NUL.txt',
    'tests/a.ts.',
    'tests/a.ts ',
    ' tests/a.ts',
    'PROGRA~1/a.ts',
    'tests/\u0000a.ts',
    'tests/\u00e9.ts',
    'tests/a?.ts',
    'x'.repeat(1025),
  ])('refuses the ambiguous or escaping spelling %j', (spelling) => {
    expect(canonicalPath(spelling).ok).toBe(false);
  });

  test('hot-file identity covers respellings, parents and descendants, and fails closed', () => {
    for (const hot of [
      'SERVER/APP.TS',
      'server/../server/app.ts',
      '.\\server\\app.ts',
      'shared/',
      'shared',
      'desktop/main.ts',
      'DESKTOP',
      '',
      '../server/app.ts',
    ])
      expect([hot, isHotFile(hot)]).toEqual([hot, true]);
    for (const cold of ['server/apps.ts', 'server/app.ts.bak', 'desktopx/a.ts', 'tests/app.ts'])
      expect([cold, isHotFile(cold)]).toEqual([cold, false]);
  });

  test('a claim records canonical paths, sorted, without paths its own directory covers', async () => {
    const result = await claimPaths(root, {
      owner: astra,
      node: 'C00.R',
      baseSha: 'b',
      paths: ['tests/a.ts', 'tests/', './TESTS/', 'b.md'],
    });
    if (!result.ok) throw new Error(result.detail);
    expect(result.claim.paths).toEqual(['b.md', 'tests/']);
  });

  test('one invalid path refuses the whole claim', async () => {
    const result = expectHeld(
      await claimPaths(root, {
        owner: astra,
        node: 'C00.R',
        baseSha: 'b',
        paths: ['tests/a.ts', '../x.ts'],
      }),
    );
    expect(result.reason).toBe('invalid');
    expect(result.detail).toContain('../x.ts');
  });

  test('a parent directory spelled without a slash conflicts with files under it, a sibling prefix does not', async () => {
    const claim = (owner: Owner, paths: string[]) =>
      claimPaths(root, { owner, node: 'C00.R', baseSha: 'b', paths });
    expect((await claim(fable, ['tests/unit/a.ts'])).ok).toBe(true);
    expect(expectHeld(await claim(astra, ['tests/unit'])).reason).toBe('held');
    expect(expectHeld(await claim(astra, ['TESTS'])).reason).toBe('held');
    expect((await claim(astra, ['tests/unit-other.ts'])).ok).toBe(true);
  });
});

describe('overlap exclusion under concurrency', () => {
  test('contenders racing for spellings of one path and its directories: exactly one winner, and every loser names it', async () => {
    const spellings = [
      'tests/a.ts',
      'TESTS/A.TS',
      'tests/../tests/a.ts',
      './tests/a.ts',
      'tests/',
      'tests',
      'tests\\a.ts',
      'tests/./a.ts',
    ];
    for (let round = 0; round < 5; round += 1) {
      const roundRoot = path.join(root, `round-${round}`);
      const ordered = spellings.map((_, index) => spellings[(index + round) % spellings.length]);
      const results = await Promise.all(
        ordered.map((spelling, index) =>
          claimPaths(roundRoot, {
            owner: worker(index),
            node: 'race',
            baseSha: 'b',
            paths: [spelling],
          }),
        ),
      );
      const winners = results.flatMap((result) => (result.ok ? [result.claim] : []));
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (result.ok) continue;
        expect(result.reason).toBe('held');
        expect(result.heldBy?.claimId).toBe(winners[0].claimId);
      }
      const claimFiles = (await fs.readdir(path.join(roundRoot, 'claims'))).filter((name) =>
        name.endsWith('.json'),
      );
      expect(claimFiles).toEqual([`${winners[0].claimId}.json`]);
    }
  });

  test('racing nested and disjoint claims never leaves two overlapping winners', async () => {
    const sets = [
      ['tests/a.ts'],
      ['tests/'],
      ['tests/b.ts', 'docs/x.md'],
      ['docs/'],
      ['server/harness/run.ts'],
      ['server/harness/'],
      ['client/a.tsx'],
      ['client/b.tsx'],
    ];
    for (let rotation = 0; rotation < sets.length; rotation += 1) {
      const rotationRoot = path.join(root, `rotation-${rotation}`);
      const ordered = sets.map((_, index) => sets[(index + rotation) % sets.length]);
      const results = await Promise.all(
        ordered.map((paths, index) =>
          claimPaths(rotationRoot, { owner: worker(index), node: 'mixed', baseSha: 'b', paths }),
        ),
      );
      const winners: Claim[] = results.flatMap((result) => (result.ok ? [result.claim] : []));
      for (const [index, left] of winners.entries())
        for (const right of winners.slice(index + 1))
          expect([left.paths, right.paths, overlaps(left.paths, right.paths)]).toEqual([
            left.paths,
            right.paths,
            false,
          ]);
      for (const [index, result] of results.entries()) {
        if (result.ok) continue;
        expect(result.reason).toBe('held');
        const holder = winners.find((claim) => claim.claimId === result.heldBy?.claimId);
        expect(holder).toBeDefined();
        expect(overlaps(holder?.paths ?? [], ordered[index])).toBe(true);
      }
      expect(winners.map((claim) => claim.paths)).toEqual(
        expect.arrayContaining([['client/a.tsx'], ['client/b.tsx']]),
      );
    }
  });

  test('an attempt that never decides blocks overlapping claims until its holder or the integrator ends it', async () => {
    const layout = coordinationLayout(root);
    await fs.mkdir(layout.attempts, { recursive: true });
    await fs.mkdir(layout.order, { recursive: true });
    const stuck: Claim = {
      schema_version: 1,
      claimId: 'claim_stuck00_0000abcd',
      program: PROGRAM,
      node: 'crashed',
      owner: astra,
      paths: ['tests/a.ts'],
      baseSha: 'b',
      createdAt: '2026-09-13T01:00:00.000Z',
      handoffFrom: null,
    };
    const attemptFile = path.join(layout.attempts, `${stuck.claimId}.json`);
    await fs.writeFile(attemptFile, JSON.stringify(stuck, null, 2));
    await fs.link(attemptFile, path.join(layout.order, orderEntryName(0)));
    const claim = (paths: string[]) =>
      claimPaths(root, { owner: fable, node: 'C00.R', baseSha: 'b', paths, settleMs: 30 });

    const blocked = expectHeld(await claim(['TESTS/A.TS']));
    expect(blocked.reason).toBe('held');
    expect(blocked.heldBy?.claimId).toBe(stuck.claimId);
    expect(blocked.detail).toMatch(/not finished deciding/);
    expect((await claim(['docs/b.md'])).ok).toBe(true);

    await expect(
      releaseClaim(root, stuck.claimId, { by: { ...astra, pid: 201 }, note: 'not mine' }),
    ).rejects.toThrow(/holder/);
    await expect(releaseClaim(root, stuck.claimId, { by: fable, note: '  ' })).rejects.toThrow(
      /reason/,
    );
    const ended = await releaseClaim(root, stuck.claimId, {
      by: fable,
      note: 'astra exited while claiming',
    });
    expect(ended.authority).toBe('integrator');
    expect((await claim(['tests/a.ts'])).ok).toBe(true);
  });

  test('a claim written by the earlier tool still excludes overlapping claims until it is released', async () => {
    const layout = coordinationLayout(root);
    await fs.mkdir(layout.locks, { recursive: true });
    const legacy: Claim = {
      schema_version: 1,
      claimId: 'claim_legacy0_0000beef',
      program: PROGRAM,
      node: 'C00.I',
      owner: fable,
      paths: ['evidence/unified-20260913/'],
      baseSha: '212106e',
      createdAt: '2026-09-13T01:00:00.000Z',
      handoffFrom: null,
    };
    await fs.writeFile(
      path.join(layout.claims, `${legacy.claimId}.json`),
      JSON.stringify(legacy, null, 2),
    );
    const lock = path.join(layout.locks, `${encodeURIComponent(legacy.paths[0])}.lock`);
    await fs.writeFile(lock, legacy.claimId);
    const attempt = () =>
      claimPaths(root, {
        owner: astra,
        node: 'C00.R',
        baseSha: 'b',
        paths: ['EVIDENCE/unified-20260913/C00.I.json'],
      });

    expect(expectHeld(await attempt()).heldBy?.claimId).toBe(legacy.claimId);
    await releaseClaim(root, legacy.claimId, { by: fable, note: 'C00.I evidence returned' });
    await expect(fs.access(lock)).rejects.toThrow();
    expect((await attempt()).ok).toBe(true);
  });

  test('a won claim leaves the lock file the earlier tool checks, and release removes it', async () => {
    const won = await claimPaths(root, {
      owner: fable,
      node: 'C00.R',
      baseSha: 'b',
      paths: ['tests/a.ts'],
    });
    if (!won.ok) throw new Error(won.detail);
    const lock = path.join(
      coordinationLayout(root).locks,
      `${encodeURIComponent('tests/a.ts')}.lock`,
    );
    expect(await fs.readFile(lock, 'utf8')).toBe(won.claim.claimId);
    await releaseClaim(root, won.claim.claimId, { by: fable, note: 'done' });
    await expect(fs.access(lock)).rejects.toThrow();
  });
});

type HandoffInput = Parameters<typeof issueHandoff>[1];
type ClaimInput = Parameters<typeof claimPaths>[1];

describe('recorded handoffs', () => {
  const issue = (change: Partial<HandoffInput> = {}) =>
    issueHandoff(root, {
      by: fable,
      to: astra,
      node: 'H03.I',
      baseSha: '212106e',
      paths: ['shared/types.ts'],
      note: 'astra carries the shared type change for H03',
      ...change,
    });
  const claimWith = (handoffFrom: string, change: Partial<ClaimInput> = {}) =>
    claimPaths(root, {
      owner: astra,
      node: 'H03.I',
      baseSha: '212106e',
      paths: ['shared/types.ts'],
      handoffFrom,
      ...change,
    });

  test('an integrator-issued handoff lets exactly its recipient claim exactly its scope, once', async () => {
    const handoff = await issue();
    const taken = await claimWith(handoff.handoffId, { paths: ['SHARED/types.ts'] });
    if (!taken.ok) throw new Error(taken.detail);
    expect(taken.claim.handoffFrom).toBe(handoff.handoffId);
    await releaseClaim(root, taken.claim.claimId, { by: astra, note: 'done' });
    const replay = expectHeld(await claimWith(handoff.handoffId));
    expect(replay.reason).toBe('handoff-invalid');
    expect(replay.detail).toMatch(/already used/);
  });

  test.each<[string, Partial<HandoffInput>, Partial<ClaimInput>]>([
    ['another process of the recipient role claims', {}, { owner: { ...astra, pid: 201 } }],
    [
      'another lifetime of the recipient pid claims',
      {},
      { owner: { ...astra, processStart: '2026-09-14T00:00:00.000Z' } },
    ],
    ['the node differs', {}, { node: 'H04.I' }],
    ['the base differs', {}, { baseSha: 'ffffff0' }],
    ['the claim is wider than the scope', {}, { paths: ['shared/types.ts', 'shared/harness.ts'] }],
    [
      'the claim is narrower than the scope',
      { paths: ['shared/types.ts', 'shared/harness.ts'] },
      {},
    ],
    ['the claim names the parent directory', {}, { paths: ['shared/'] }],
  ])('a handoff does not apply when %s', async (_case, handoffChange, claimChange) => {
    const handoff = await issue(handoffChange);
    expect(expectHeld(await claimWith(handoff.handoffId, claimChange)).reason).toBe(
      'handoff-invalid',
    );
  });

  test('an id nobody issued, or a record the integrator did not issue, authorizes nothing', async () => {
    for (const id of ['never-issued', 'handoff_mtzaaaaa_0000cafe'])
      expect([id, expectHeld(await claimWith(id)).reason]).toEqual([id, 'handoff-invalid']);
    const layout = coordinationLayout(root);
    await fs.mkdir(layout.handoffs, { recursive: true });
    const forgedId = 'handoff_forged0_0000f00d';
    await fs.writeFile(
      path.join(layout.handoffs, `${forgedId}.json`),
      JSON.stringify({
        schema_version: 1,
        handoffId: forgedId,
        program: PROGRAM,
        issuedBy: astra,
        recipient: astra,
        node: 'H03.I',
        baseSha: '212106e',
        paths: ['shared/types.ts'],
        note: 'self-issued',
        issuedAt: '2026-09-13T01:00:00.000Z',
      }),
    );
    const forged = expectHeld(await claimWith(forgedId));
    expect(forged.reason).toBe('handoff-invalid');
    expect(forged.detail).toMatch(/integrator/);
  });

  test('only the integrator issues a handoff, and it records why, to whom and for which paths', async () => {
    await expect(issue({ by: astra })).rejects.toThrow(/integrator/);
    await expect(issue({ note: '  ' })).rejects.toThrow(/note/);
    await expect(issue({ paths: ['../shared/types.ts'] })).rejects.toThrow(/path/);
    await expect(issue({ paths: [] })).rejects.toThrow(/path/);
    await expect(issue({ to: { ...astra, pid: 0 } })).rejects.toThrow(/identity/);
  });

  test('a valid handoff does not displace a live claim, and a refused attempt does not use it up', async () => {
    const live = await claimPaths(root, {
      owner: fable,
      node: 'H03.I',
      baseSha: '212106e',
      paths: ['shared/types.ts'],
    });
    if (!live.ok) throw new Error(live.detail);
    const handoff = await issue();
    const refused = expectHeld(await claimWith(handoff.handoffId));
    expect(refused.reason).toBe('held');
    expect(refused.heldBy?.claimId).toBe(live.claim.claimId);
    await releaseClaim(root, live.claim.claimId, { by: fable, note: 'handing H03 types to astra' });
    expect((await claimWith(handoff.handoffId)).ok).toBe(true);
  });

  test('work mode lets a handoff recipient edit only the hot path its own claim covers', async () => {
    await writeJournal(root, fable, { at: '2026-09-13T01:02:00.000Z', event: 'present' });
    const taken = await claimWith((await issue()).handoffId);
    if (!taken.ok) throw new Error(taken.detail);
    const mode = (me: Owner, wantsToEdit: string[]) =>
      workMode(root, { me, partner: 'fable', wantsToEdit });
    expect((await mode(astra, ['shared/types.ts'])).mode).toBe('edit');
    const elsewhere = await mode(astra, ['shared/harness.ts']);
    expect(elsewhere.mode).toBe('read-only');
    expect(elsewhere.why).toMatch(/integrator/);
    expect((await mode({ ...astra, pid: 201 }, ['shared/types.ts'])).mode).toBe('read-only');
  });
});

describe('complete owner identity', () => {
  const holdBoth = async () => {
    const claim = await claimPaths(root, {
      owner: astra,
      node: 'C00.R',
      baseSha: 'b',
      paths: ['tests/a.ts'],
    });
    const slot = await requestSlot(root, { owner: astra, purpose: 'vitest', node: 'C00.R' });
    if (!claim.ok || !slot.ok) throw new Error('fixture setup failed');
    await writeJournal(root, fable, { at: '2026-09-13T01:02:00.000Z', event: 'present' });
    return { claimId: claim.claim.claimId, slotId: slot.slot.slotId };
  };

  test.each<[string, Partial<Owner>]>([
    ['another pid', { pid: 201 }],
    ['another lifetime of the same pid', { processStart: '2026-09-14T00:00:00.000Z' }],
    ['the same pid on another host', { host: 'other-host' }],
    ['another worktree', { worktree: 'F:/wt/elsewhere' }],
    ['another non-integrator role', { role: 'opus' }],
  ])('%s is not the holder of a live claim or the slot', async (_case, change) => {
    const impostor: Owner = { ...astra, ...change };
    const { claimId, slotId } = await holdBoth();
    await expect(
      releaseClaim(root, claimId, { by: impostor, note: 'not the holder' }),
    ).rejects.toThrow(/holder/);
    await expect(releaseSlot(root, slotId, { by: impostor })).rejects.toThrow(/holder/);
    const mode = await workMode(root, {
      me: impostor,
      partner: 'fable',
      wantsToEdit: ['tests/a.ts'],
    });
    expect(mode.mode).toBe('read-only');
    await releaseClaim(root, claimId, { by: astra, note: 'done' });
    await releaseSlot(root, slotId, { by: astra });
  });

  test('the same identity respelled is still the holder', async () => {
    const respelled: Owner = {
      ...astra,
      host: 'TEST-HOST',
      processStart: '2026-09-12T21:00:01-04:00',
      worktree: 'F:\\wt\\astra\\',
    };
    const { claimId, slotId } = await holdBoth();
    const mode = await workMode(root, {
      me: respelled,
      partner: 'fable',
      wantsToEdit: ['tests/a.ts'],
    });
    expect(mode.mode).toBe('edit');
    expect((await releaseClaim(root, claimId, { by: respelled, note: 'done' })).authority).toBe(
      'holder',
    );
    await releaseSlot(root, slotId, { by: respelled });
  });

  test("the integrator may end another worker's claim only with a recorded reason", async () => {
    const { claimId } = await holdBoth();
    await expect(releaseClaim(root, claimId, { by: fable, note: '' })).rejects.toThrow(/reason/);
    const release = await releaseClaim(root, claimId, { by: fable, note: 'astra session ended' });
    expect(release.authority).toBe('integrator');
    expect(release.releasedBy).toEqual(fable);
  });

  test.each<[string, Record<string, unknown>]>([
    ['pid 0', { pid: 0 }],
    ['a negative pid', { pid: -1 }],
    ['a fractional pid', { pid: 1.5 }],
    ['a NaN pid', { pid: Number.NaN }],
    ['an undated start', { processStart: 'yesterday' }],
    ['an empty start', { processStart: '' }],
    ['an empty host', { host: '' }],
    ['a blank worktree', { worktree: ' ' }],
    ['an unknown role', { role: 'root' }],
  ])(
    'a malformed identity (%s) cannot claim, take the slot or write a journal',
    async (_case, change) => {
      const malformed = { ...astra, ...change } as unknown as Owner;
      const claim = expectHeld(
        await claimPaths(root, { owner: malformed, node: 'C00.R', baseSha: 'b', paths: ['a.ts'] }),
      );
      expect(claim.reason).toBe('invalid');
      expect(
        await requestSlot(root, { owner: malformed, purpose: 'vitest', node: 'C00.R' }),
      ).toMatchObject({ ok: false, heldBy: null });
      await expect(
        writeJournal(root, malformed, { at: '2026-09-13T01:00:00.000Z', event: 'x' }),
      ).rejects.toThrow(/identity/);
    },
  );

  test('a journal entry records the full process identity', async () => {
    await writeJournal(root, astra, { at: '2026-09-13T01:02:00.000Z', event: 'present' });
    expect((await readJournal(root, 'astra'))[0]).toMatchObject({
      pid: astra.pid,
      host: astra.host,
      processStart: astra.processStart,
      worktree: astra.worktree,
    });
  });
});

describe('command-line identity', () => {
  const start = '2026-09-13T01:00:00.5556400Z';

  test('the command line refuses to guess which process it speaks for', async () => {
    const lookup = async () => start;
    await expect(ownerFromArgs(['--role', 'fable'], lookup)).rejects.toThrow(/--pid is required/);
    await expect(ownerFromArgs(['--role', 'fable', '--pid', 'abc'], lookup)).rejects.toThrow(
      /--pid/,
    );
    await expect(ownerFromArgs(['--pid', '4242'], lookup)).rejects.toThrow(/--role/);
    await expect(
      ownerFromArgs(['--role', 'fable', '--pid', '4242', '--start', 'yesterday'], lookup),
    ).rejects.toThrow(/start/);
  });

  test('the start time is read for the named process, never taken from the command-line process', async () => {
    const asked: number[] = [];
    const owner = await ownerFromArgs(
      ['--role', 'fable', '--pid', '4242', '--host', 'test-host', '--worktree', 'F:/wt/fable'],
      async (pid) => {
        asked.push(pid);
        return start;
      },
    );
    expect(asked).toEqual([4242]);
    expect(owner).toEqual({
      role: 'fable',
      host: 'test-host',
      pid: 4242,
      processStart: start,
      worktree: 'F:/wt/fable',
    });
    await expect(
      ownerFromArgs(['--role', 'fable', '--pid', '4242'], async () => null),
    ).rejects.toThrow(/not running/);
    const explicit = await ownerFromArgs(
      ['--role', 'fable', '--pid', '4242', '--start', '2026-09-13T01:00:00.000Z'],
      async () => {
        throw new Error('the lookup must not run');
      },
    );
    expect(explicit.processStart).toBe('2026-09-13T01:00:00.000Z');
  });

  test.runIf(process.platform === 'win32' || process.platform === 'linux')(
    'the operating system reports when this process started, and nothing for an absent process',
    async () => {
      const reported = await processStartOf(process.pid);
      expect(reported).not.toBeNull();
      const expected = Date.now() - process.uptime() * 1000;
      expect(Math.abs(Date.parse(reported ?? '') - expected)).toBeLessThan(10_000);
      expect(await processStartOf(2 ** 31 - 2)).toBeNull();
    },
    60_000,
  );
});
