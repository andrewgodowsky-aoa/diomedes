import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rejectForbidden, safeAbsolute, ApiError } from '../server/paths.js';

const windows = process.platform === 'win32';

const refusalOf = (candidate: string) => {
  try {
    rejectForbidden(candidate);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

const statusOf = async (candidate: string) => {
  try {
    await safeAbsolute(candidate);
    return null;
  } catch (error) {
    return error instanceof ApiError ? error.status : (error as Error).message;
  }
};

/**
 * Read the 8.3 alias Windows generated for one directory, or null when the
 * volume does not generate them. Short-name creation is per-volume and is off
 * on plenty of machines, so every test that needs a real alias skips rather
 * than pretending.
 */
const shortNameOf = (parent: string, name: string): string | null => {
  if (!windows) return null;
  try {
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', '/ad', parent], {
      encoding: 'utf8',
    });
    const line = listing.split(/\r?\n/).find((row) => row.trimEnd().endsWith(` ${name}`));
    // `dir /x` puts the alias between the <DIR> marker and the long name, and
    // leaves the column blank when the volume generated none. Splitting on the
    // column gap is steadier than counting characters.
    const columns = line?.match(/<DIR>\s+(.*)$/)?.[1].trim().split(/\s{2,}/) ?? [];
    const [alias, long] = columns;
    return columns.length === 2 && long === name && alias !== name ? alias : null;
  } catch {
    return null;
  }
};

/**
 * Does the volume holding the temp directory generate 8.3 aliases at all?
 *
 * Short-name creation is per-volume and off on plenty of machines, including
 * this project's own F: drive. Answering at module load lets the test that
 * needs a real alias report itself as skipped instead of returning early and
 * rendering as a pass that asserted nothing.
 */
const volumeGeneratesShortNames = (() => {
  if (!windows) return false;
  const probe = fsSync.mkdtempSync(path.join(os.tmpdir(), 'diomedes-alias-probe-'));
  try {
    return shortNameOf(os.tmpdir(), path.basename(probe)) !== null;
  } finally {
    fsSync.rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * The 8.3 guard refuses on shape, and the shape it refuses is also the shape
 * Windows hands back for an ordinary profile whose name runs past eight
 * characters. `C:\Users\RUNNER~1\AppData\Local\Temp` is not an evasion; it is
 * where the operating system says temporary files go.
 *
 * Written against the observed CI failure on run 34532148878, where ten test
 * files went red at once on `os.tmpdir()` while the same suite was green on a
 * machine whose temp directory happens to carry no short name.
 *
 * The refusal has to keep its teeth: a short name that really does stand in for
 * a guarded directory must still be refused, which is why the fix resolves the
 * alias rather than trusting it.
 */
describe('path privacy and 8.3 aliases', () => {
  test.skipIf(!windows)('a short name that resolves somewhere benign is openable', async () => {
    // PROGRA~1 is C:\Program Files on every Windows install, so this needs no
    // fixture and no writable location.
    await expect(safeAbsolute('C:/PROGRA~1')).resolves.toBeDefined();
  });

  test('the operating system temp directory is openable', async () => {
    expect(await statusOf(path.join(os.tmpdir(), 'diomedes-scratch'))).toBeNull();
  });

  test.skipIf(!volumeGeneratesShortNames)(
    'a short name standing in for a guarded directory is still refused',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-shortname-'));
      try {
        await fs.mkdir(path.join(root, 'node_modules'));
        // The volume generates aliases, so a missing one is a reading bug in
        // shortNameOf rather than an environment without them.
        const alias = shortNameOf(root, 'node_modules');
        expect(alias).not.toBeNull();
        expect(alias).not.toBe('node_modules');
        expect(await statusOf(path.join(root, alias!))).toBe(403);
        expect(await statusOf(path.join(root, alias!, 'pkg', 'index.js'))).toBe(403);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test('a short name that resolves nowhere is still refused', async () => {
    // Nothing exists to expand, so the guard cannot clear it and does not.
    expect(await statusOf('F:/proj/NODEMO~1/pkg/index.js')).toBe(403);
  });

  test('the sync guard still refuses shapes and literal names', () => {
    // rejectForbidden does no IO, so its answer stays shape-based. These
    // document that the widening did not reach it.
    expect(refusalOf('F:/proj/NODEMO~1/pkg/index.js')).not.toBeNull();
    expect(refusalOf('F:/proj/CREDEN~1.JSO')).not.toBeNull();
    for (const guarded of ['node_modules', '.git', '.ssh', '.aws', '.claude', 'memories'])
      expect(refusalOf(`F:/proj/${guarded}/thing`)).not.toBeNull();
    expect(refusalOf('F:/proj/.env')).not.toBeNull();
    expect(refusalOf('F:/proj/.env.local')).not.toBeNull();
    expect(refusalOf('F:/proj/auth.json')).not.toBeNull();
  });

  test('ordinary tilde filenames stay valid', () => {
    expect(refusalOf('F:/proj/notes~backup.md')).toBeNull();
    expect(refusalOf('F:/proj/main.py~')).toBeNull();
  });
});
