/**
 * Regression coverage for the pack index reader in
 * scripts/write-capability-record.ts (`packHolds`, `gitDirectories`,
 * `commitPresent`). These fixtures are hand-built in a temp directory so the
 * tests are independent of this machine's own object store: they would have
 * caught the inverted binary-search comparison that made `commitPresent`
 * report `false` for a commit that a repack had moved out of loose storage
 * and into a pack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitPresent, gitDirectories, packHolds } from '../scripts/write-capability-record.js';

const ownedRoots = new Set<string>();

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ownedRoots.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of ownedRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ownedRoots.clear();
});

/** A 40-character lowercase hex id, as `commitPresent`'s own `sha()` requires. */
const id = (hex: string): string => {
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not a fixture-valid id: ${hex}`);
  return hex;
};

/**
 * A hand-built, fully-shaped version 2 pack index: the 8-byte header, the
 * 256-entry fanout table, the sorted 20-byte object names, then a CRC32
 * table, an offset table and the two trailing 20-byte checksums so the file
 * is byte-shaped like a real one. `packHolds` never reads past the names
 * table, but a fixture that only had the parts it reads would not be "a
 * valid v2 .idx".
 */
function buildV2Idx(hexIds: string[]): Buffer {
  // A real index is always sorted, regardless of the order objects were
  // added in, so the fixture sorts too rather than trusting the caller.
  const ids = hexIds.map((h) => Buffer.from(h, 'hex')).sort(Buffer.compare);
  const count = ids.length;

  const header = Buffer.alloc(8);
  header.writeUInt32BE(0xff744f63, 0);
  header.writeUInt32BE(2, 4);

  const fanout = Buffer.alloc(1024);
  let cursor = 0;
  for (let byte = 0; byte < 256; byte++) {
    while (cursor < count && ids[cursor][0] <= byte) cursor += 1;
    fanout.writeUInt32BE(cursor, byte * 4);
  }

  const names = Buffer.concat(ids);
  const crc32Table = Buffer.alloc(count * 4);
  const offsetTable = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i += 1) offsetTable.writeUInt32BE(i * 64, i * 4);
  const packChecksum = Buffer.alloc(20, 0xaa);
  const idxChecksum = Buffer.alloc(20, 0xbb);

  return Buffer.concat([header, fanout, names, crc32Table, offsetTable, packChecksum, idxChecksum]);
}

/** Lays out `objects/pack/<name>` under `root/.git` (or `root` itself, when it already ends in `.git`). */
function writePack(gitDir: string, name: string, hexIds: string[]): void {
  const dir = path.join(gitDir, 'objects', 'pack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.idx`), buildV2Idx(hexIds));
}

describe('packHolds reads a hand-built v2 index directly', () => {
  it('finds an id in the very first fanout bucket (0x00)', async () => {
    const first = id('00' + '11'.repeat(19));
    const neighbor = id('00' + '22'.repeat(19));
    const elsewhere = id('7f' + '33'.repeat(19));
    const dir = tmpDir('idx-bucket-00-');
    const file = path.join(dir, 'pack.idx');
    fs.writeFileSync(file, buildV2Idx([first, neighbor, elsewhere]));

    expect(await packHolds(file, first)).toBe(true);
    expect(await packHolds(file, neighbor)).toBe(true);
    // Same bucket (0x00), never inserted: must not be reported present.
    expect(await packHolds(file, id('00' + '99'.repeat(19)))).toBe(false);
  });

  it('finds an id in the very last fanout bucket (0xff)', async () => {
    const last = id('ff' + 'ee'.repeat(19));
    const neighbor = id('ff' + 'dd'.repeat(19));
    const elsewhere = id('01' + '33'.repeat(19));
    const dir = tmpDir('idx-bucket-ff-');
    const file = path.join(dir, 'pack.idx');
    fs.writeFileSync(file, buildV2Idx([elsewhere, neighbor, last]));

    expect(await packHolds(file, last)).toBe(true);
    expect(await packHolds(file, neighbor)).toBe(true);
    expect(await packHolds(file, id('ff' + '00'.repeat(19)))).toBe(false);
  });

  it('finds every id in a multi-entry bucket, not only the one the middle probe lands on', async () => {
    // This is the shape that exposed the bug: a bucket with several entries,
    // where a mis-directed binary search silently drops whichever half holds
    // the id actually being searched for. Every position in the bucket must
    // resolve, not just the one the first probe happens to hit.
    const bucket = Array.from({ length: 9 }, (_, i) =>
      id(('52' + i.toString(16).padStart(2, '0')).padEnd(40, '0')),
    );
    const dir = tmpDir('idx-bucket-wide-');
    const file = path.join(dir, 'pack.idx');
    fs.writeFileSync(file, buildV2Idx(bucket));

    for (const entry of bucket) {
      expect(await packHolds(file, entry), entry).toBe(true);
    }
    expect(await packHolds(file, id('52' + 'ab'.repeat(19)))).toBe(false);
  });

  it('returns null, not false, for an index with an unrecognized version', async () => {
    const dir = tmpDir('idx-bad-version-');
    const file = path.join(dir, 'pack.idx');
    const bad = buildV2Idx([id('52'.padEnd(40, '0'))]);
    bad.writeUInt32BE(1, 4); // claim version 1 instead of 2
    fs.writeFileSync(file, bad);

    expect(await packHolds(file, id('52'.padEnd(40, '0')))).toBeNull();
  });

  it('returns null, not false, for a buffer too small to hold a v2 header and fanout table', async () => {
    const dir = tmpDir('idx-truncated-');
    const file = path.join(dir, 'pack.idx');
    fs.writeFileSync(file, Buffer.alloc(100));

    expect(await packHolds(file, id('52'.padEnd(40, '0')))).toBeNull();
  });

  it('returns null, not false, when the fanout table claims more names than the file holds', async () => {
    const dir = tmpDir('idx-short-names-');
    const file = path.join(dir, 'pack.idx');
    const real = buildV2Idx([id('01'.padEnd(40, '0')), id('99'.padEnd(40, '1'))]);
    // Keep the header and fanout table, but cut the file off partway through
    // the names table so `high` names cannot actually be there.
    const truncated = real.subarray(0, 8 + 1024 + 10);
    fs.writeFileSync(file, truncated);

    expect(await packHolds(file, id('99'.padEnd(40, '1')))).toBeNull();
  });

  it('returns null, not false, for a missing pack index', async () => {
    const dir = tmpDir('idx-missing-');
    expect(await packHolds(path.join(dir, 'nope.idx'), id('52'.padEnd(40, '0')))).toBeNull();
  });
});

describe('gitDirectories resolves a linked worktree through commondir', () => {
  it('returns the private worktree gitdir and the common dir it points at', async () => {
    const root = tmpDir('gitdirs-worktree-');
    const worktreeRoot = path.join(root, 'worktree');
    const mainGitDir = path.join(root, 'main', '.git');
    const privateGitDir = path.join(mainGitDir, 'worktrees', 'wt1');

    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.mkdirSync(privateGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${privateGitDir}\n`);
    // Real git writes this as the relative path from the private gitdir back
    // to the common one: worktrees/<name>/commondir -> ../.. -> .git.
    fs.writeFileSync(path.join(privateGitDir, 'commondir'), '../..\n');

    const dirs = await gitDirectories(worktreeRoot);
    expect(dirs).toEqual([privateGitDir, mainGitDir]);
  });

  it('returns just the gitdir for an ordinary, non-worktree checkout', async () => {
    const root = tmpDir('gitdirs-plain-');
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(gitDir, { recursive: true });

    const dirs = await gitDirectories(root);
    expect(dirs).toEqual([gitDir]);
  });
});

describe('commitPresent against a hand-built repository', () => {
  it('finds a commit that exists only in a pack, never loose', async () => {
    const root = tmpDir('commit-single-pack-');
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    const target = id('c0ffee'.padEnd(40, '0'));
    writePack(gitDir, 'pack-only', [target, id('01'.padEnd(40, 'a'))]);

    expect(await commitPresent(target, root)).toBe(true);
    expect(await commitPresent(id('deadbe'.padEnd(40, 'f')), root)).toBe(false);
  });

  it('finds a commit held by the second pack even when the first does not have it', async () => {
    const target = id('feedfa'.padEnd(40, '0'));
    const decoy = id('01'.padEnd(40, 'a'));

    // Try both orderings, since directory scan order is not guaranteed: the
    // pack that does not hold the target must never stop the search from
    // reaching the one that does.
    for (const [firstIds, secondIds] of [
      [[decoy], [target, decoy]],
      [[target, decoy], [decoy]],
    ]) {
      const root = tmpDir('commit-two-packs-');
      const gitDir = path.join(root, '.git');
      fs.mkdirSync(gitDir, { recursive: true });
      writePack(gitDir, 'pack-a', firstIds);
      writePack(gitDir, 'pack-b', secondIds);

      expect(await commitPresent(target, root)).toBe(true);
    }
  });

  it('resolves a linked worktree through commondir to find a commit in the main checkout', async () => {
    const root = tmpDir('commit-worktree-');
    const worktreeRoot = path.join(root, 'worktree');
    const mainGitDir = path.join(root, 'main', '.git');
    const privateGitDir = path.join(mainGitDir, 'worktrees', 'wt1');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.mkdirSync(privateGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${privateGitDir}\n`);
    fs.writeFileSync(path.join(privateGitDir, 'commondir'), '../..\n');

    const target = id('52db51'.padEnd(40, '0'));
    // The pack lives in the COMMON directory, exactly as it does for a real
    // linked worktree: the private gitdir has no objects of its own.
    writePack(mainGitDir, 'pack-common', [target, id('01'.padEnd(40, 'a'))]);

    expect(await commitPresent(target, worktreeRoot)).toBe(true);
  });

  it('says "cannot tell", not "absent", when a pack index cannot be read', async () => {
    const root = tmpDir('commit-bad-index-');
    const gitDir = path.join(root, '.git');
    const packDir = path.join(gitDir, 'objects', 'pack');
    fs.mkdirSync(packDir, { recursive: true });
    const bad = buildV2Idx([id('01'.padEnd(40, 'a'))]);
    bad.writeUInt32BE(3, 4); // unknown version
    fs.writeFileSync(path.join(packDir, 'pack-bad.idx'), bad);

    const target = id('52db51'.padEnd(40, '0'));
    expect(await commitPresent(target, root)).toBeNull();
  });

  it('says "cannot tell" even when a readable pack proves absence and a second index is unreadable', async () => {
    const root = tmpDir('commit-mixed-index-');
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    const target = id('52db51'.padEnd(40, '0'));
    writePack(gitDir, 'pack-good', [id('01'.padEnd(40, 'a'))]);
    const packDir = path.join(gitDir, 'objects', 'pack');
    const bad = buildV2Idx([id('01'.padEnd(40, 'a'))]);
    bad.writeUInt32BE(1, 4);
    fs.writeFileSync(path.join(packDir, 'pack-bad.idx'), bad);

    expect(await commitPresent(target, root)).toBeNull();
  });
});
