/**
 * The Git change source seen from outside: what it reports about a repository
 * the person did not touch, and what it costs to ask.
 *
 * Two properties are pinned here that the rest of the change-review suite does
 * not reach, because its fixture sets `core.autocrlf false` on the test
 * repository and always makes the project folder the repository root:
 *
 *  - change review's view of "modified" must agree with the person's own Git.
 *    Git only compares content for entries whose recorded stat data it cannot
 *    vouch for; on Windows, where `core.autocrlf` defaults to `true`, those
 *    entries read as modified against their LF blobs unless the inspection
 *    environment shares the person's end-of-line configuration.
 *  - the subject of a snapshot is the project folder, not whatever repository
 *    happens to enclose it.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  diffGitSnapshots,
  prepareGit,
  snapshotGit,
} from '../server/change-review/git.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/** The sha `git hash-object` gives raw bytes: sha1 over `blob <len>\0` + content. */
const rawBlobSha = (bytes: Buffer): string =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${String(bytes.length)}\0`), bytes]))
    .digest('hex');

type Repo = { dir: string; run: (...args: string[]) => string; cleanup: () => Promise<void> };

/**
 * A repository outside any other repository — `prepareGit` resolves
 * `--show-toplevel`, so a fixture nested in this checkout would make the
 * Diomedes repository the subject instead of the fixture.
 */
const makeRepo = async (autocrlf: 'true' | 'false' | 'input'): Promise<Repo> => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cr-git-eol-')));
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'core.autocrlf', autocrlf);
  return { dir, run, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
};

/**
 * Make one file's index stat data unvouchable without changing a byte of it —
 * the state a fresh clone, a branch switch or a build that rewrites timestamps
 * leaves behind. No Git command may run against the repository afterwards, or
 * it refreshes the index and writes the staleness away.
 */
const staleStat = async (file: string): Promise<void> => {
  const past = new Date(Date.now() - 86_400_000);
  await fs.utimes(file, past, past);
};

describe('git source — end-of-line agreement with the person’s own Git', () => {
  test.skipIf(!gitAvailable)(
    'a file nobody edited is never reported, however stale its stat data',
    async () => {
      const repo = await makeRepo('true');
      const file = path.join(repo.dir, 'notes.txt');
      await fs.writeFile(file, 'alpha\r\nbeta\r\n');
      repo.run('add', '.');
      repo.run('commit', '-q', '-m', 'init');
      // `core.autocrlf true` normalised the blob to LF; the worktree stays CRLF.
      expect(repo.run('cat-file', 'blob', 'HEAD:notes.txt')).toBe('alpha\nbeta\n');
      expect(repo.run('status', '--porcelain').trim()).toBe('');

      await staleStat(file);
      const env = (await prepareGit(repo.dir))!;
      expect(env).not.toBeNull();
      const baseline = await snapshotGit(env);
      expect(baseline.captured).toBe(true);
      if (!baseline.captured) return;
      // The person's Git calls this tree clean. So must change review.
      expect(baseline.files.map((f) => f.path)).toEqual([]);

      // Anything at all refreshes the index — here, the person's own status.
      expect(repo.run('status', '--porcelain').trim()).toBe('');
      const build = await snapshotGit(env);
      expect(build.captured).toBe(true);
      if (!build.captured) return;

      // A baseline taken stale and a build taken refreshed must not disagree
      // about a file nobody edited: that disagreement reaches the manifest as
      // a `modified` entry whose before-sha names no object in the repository.
      const entries = diffGitSnapshots(baseline.files, build.files, []);
      expect(entries).toEqual([]);
      await env.cleanup();
      await repo.cleanup();
    },
  );

  test.skipIf(!gitAvailable)(
    'a real edit is still reported, and its recorded sha is the raw bytes',
    async () => {
      const repo = await makeRepo('true');
      const file = path.join(repo.dir, 'notes.txt');
      await fs.writeFile(file, 'alpha\r\nbeta\r\n');
      repo.run('add', '.');
      repo.run('commit', '-q', '-m', 'init');
      const env = (await prepareGit(repo.dir))!;
      const baseline = await snapshotGit(env);
      if (!baseline.captured) return;
      expect(baseline.files.map((f) => f.path)).toEqual([]);

      const edited = Buffer.from('alpha\r\nbeta\r\ngamma\r\n');
      await fs.writeFile(file, edited);
      const build = await snapshotGit(env);
      if (!build.captured) return;
      const row = build.files.find((f) => f.path === 'notes.txt');
      expect(row).toBeDefined();
      expect(row!.y).toBe('M');
      // `hash-object --no-filters` hashes the bytes on disk and nothing else,
      // so no end-of-line configuration can move a recorded sha. This is the
      // evidence that aligning that configuration is safe for the record.
      expect(row!.blobSha).toBe(rawBlobSha(edited));

      const entries = diffGitSnapshots(baseline.files, build.files, []);
      expect(entries.map((e) => e.path)).toEqual(['notes.txt']);
      expect(entries[0].kind).toBe('modified');
      expect(entries[0].afterSha).toBe(rawBlobSha(edited));
      await env.cleanup();
      await repo.cleanup();
    },
  );

  test.skipIf(!gitAvailable)(
    'a repository that stores CRLF is read the same way its owner reads it',
    async () => {
      // `core.autocrlf false` is the other direction: the blob keeps CRLF and
      // the worktree matches it byte for byte. A stale entry must still be
      // clean, which it is only if change review does not impose a conversion
      // of its own.
      const repo = await makeRepo('false');
      const file = path.join(repo.dir, 'notes.txt');
      await fs.writeFile(file, 'alpha\r\nbeta\r\n');
      repo.run('add', '.');
      repo.run('commit', '-q', '-m', 'init');
      expect(repo.run('cat-file', 'blob', 'HEAD:notes.txt')).toBe('alpha\r\nbeta\r\n');
      await staleStat(file);
      const env = (await prepareGit(repo.dir))!;
      const snapshot = await snapshotGit(env);
      if (!snapshot.captured) return;
      expect(snapshot.files.map((f) => f.path)).toEqual([]);
      await env.cleanup();
      await repo.cleanup();
    },
  );
});

describe('git source — the subject is the project folder', () => {
  test.skipIf(!gitAvailable)(
    'a project inside a larger repository does not snapshot the repository',
    async () => {
      const repo = await makeRepo('false');
      const project = path.join(repo.dir, 'apps', 'project');
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(path.join(repo.dir, 'elsewhere'), { recursive: true });
      await fs.writeFile(path.join(project, 'kept.txt'), 'in the project\n');
      await fs.writeFile(path.join(repo.dir, 'elsewhere', 'other.txt'), 'not the project\n');
      await fs.writeFile(path.join(repo.dir, 'root.txt'), 'not the project\n');
      repo.run('add', '.');
      repo.run('commit', '-q', '-m', 'init');

      const env = (await prepareGit(project))!;
      expect(env).not.toBeNull();
      const baseline = await snapshotGit(env);
      if (!baseline.captured) return;
      expect(baseline.files.map((f) => f.path)).toEqual([]);

      // One write inside the project, two outside it. Only the project's own
      // write is this project's change.
      await fs.writeFile(path.join(project, 'kept.txt'), 'edited in the project\n');
      await fs.writeFile(path.join(repo.dir, 'elsewhere', 'other.txt'), 'edited outside\n');
      await fs.writeFile(path.join(repo.dir, 'untracked-outside.txt'), 'new outside\n');
      const build = await snapshotGit(env);
      if (!build.captured) return;

      const entries = diffGitSnapshots(baseline.files, build.files, []);
      expect(entries.map((e) => e.path)).toEqual(['apps/project/kept.txt']);
      await env.cleanup();
      await repo.cleanup();
    },
  );

  test.skipIf(!gitAvailable)(
    'content hashes are recorded for a project below the repository root',
    async () => {
      const repo = await makeRepo('false');
      const project = path.join(repo.dir, 'apps', 'project');
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(project, 'kept.txt'), 'v0\n');
      repo.run('add', '.');
      repo.run('commit', '-q', '-m', 'init');
      const env = (await prepareGit(project))!;
      const baseline = await snapshotGit(env);
      if (!baseline.captured) return;

      const edited = Buffer.from('v1\n');
      await fs.writeFile(path.join(project, 'kept.txt'), edited);
      const untracked = Buffer.from('new\n');
      await fs.writeFile(path.join(project, 'added.txt'), untracked);
      const build = await snapshotGit(env);
      if (!build.captured) return;

      // `hash-object` resolves its argument against the working directory,
      // which is the project folder, while porcelain paths are relative to the
      // repository root. A recorded sha of null here means every change under
      // a subdirectory project reached the manifest with no content behind it.
      const kept = build.files.find((f) => f.path === 'apps/project/kept.txt');
      expect(kept).toBeDefined();
      expect(kept!.blobSha).toBe(rawBlobSha(edited));
      const added = build.files.find((f) => f.path === 'apps/project/added.txt');
      expect(added).toBeDefined();
      expect(added!.blobSha).toBe(rawBlobSha(untracked));
      await env.cleanup();
      await repo.cleanup();
    },
  );

  test.skipIf(!gitAvailable)(
    'a project folder named like a glob bounds to itself and nothing else',
    async () => {
      const repo = await makeRepo('false');
      // `[1]` is a Git pathspec character class and a legal directory name on
      // both Windows and POSIX. Bounded literally it matches one directory;
      // bounded as a glob it would match `app1` and miss `app[1]` entirely.
      const project = path.join(repo.dir, 'app[1]');
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(path.join(repo.dir, 'app1'), { recursive: true });
      await fs.writeFile(path.join(project, 'mine.txt'), 'v0\n');
      await fs.writeFile(path.join(repo.dir, 'app1', 'theirs.txt'), 'v0\n');
      repo.run('add', '.');
      repo.run('commit', '-q', '-m', 'init');
      const env = (await prepareGit(project))!;
      const baseline = await snapshotGit(env);
      if (!baseline.captured) return;
      await fs.writeFile(path.join(project, 'mine.txt'), 'v1\n');
      await fs.writeFile(path.join(repo.dir, 'app1', 'theirs.txt'), 'v1\n');
      const build = await snapshotGit(env);
      if (!build.captured) return;
      const entries = diffGitSnapshots(baseline.files, build.files, []);
      expect(entries.map((e) => e.path)).toEqual(['app[1]/mine.txt']);
      await env.cleanup();
      await repo.cleanup();
    },
  );

  test.skipIf(!gitAvailable)(
    'a project at the repository root still sees the whole repository',
    async () => {
      const repo = await makeRepo('false');
      await fs.mkdir(path.join(repo.dir, 'nested'), { recursive: true });
      await fs.writeFile(path.join(repo.dir, 'root.txt'), 'v0\n');
      await fs.writeFile(path.join(repo.dir, 'nested', 'deep.txt'), 'v0\n');
      repo.run('add', '.');
      repo.run('commit', '-q', '-m', 'init');
      const env = (await prepareGit(repo.dir))!;
      const baseline = await snapshotGit(env);
      if (!baseline.captured) return;
      await fs.writeFile(path.join(repo.dir, 'root.txt'), 'v1\n');
      await fs.writeFile(path.join(repo.dir, 'nested', 'deep.txt'), 'v1\n');
      const build = await snapshotGit(env);
      if (!build.captured) return;
      const entries = diffGitSnapshots(baseline.files, build.files, []);
      expect(entries.map((e) => e.path)).toEqual(['nested/deep.txt', 'root.txt']);
      await env.cleanup();
      await repo.cleanup();
    },
  );
});
