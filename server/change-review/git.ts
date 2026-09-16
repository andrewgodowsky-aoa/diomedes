/**
 * The Git change source — Software Engineering pack territory.
 *
 * It observes a repository the way the research spikes proved safe: never
 * through the person's index and never through repository-controlled
 * configuration. Every call runs the installed `git` binary with an explicit
 * argument array (no shell), a scrubbed environment, repository hooks and
 * fsmonitor disabled, `GIT_OPTIONAL_LOCKS=0`, and a temporary index seeded
 * from the real one — so opportunistic refreshes can never touch the person's
 * staging state.
 *
 * File content is hashed with `git hash-object --no-filters`, which never runs
 * clean filters, so a planted `.gitattributes`/`filter.*.clean` cannot turn a
 * review into code execution. `status`/`diff` may still consult repo config
 * for filter processes on content comparison — the residual is documented in
 * the implementation record and the source reports itself `unavailable`
 * rather than guessing when Git refuses.
 *
 * Binary classification comes from Git's own verdict wherever one exists —
 * `diff --numstat` marks binary paths with `-` — and from a bounded 8 KB NUL
 * probe for worktree content Git has no record of (untracked files). File
 * modes come straight out of porcelain v2 (`mH`/`mI`/`mW`), so an executable-
 * bit transition is reported as exactly that and never inferred from a name.
 *
 * Baseline semantics are honest in a dirty workspace: whatever the baseline
 * saw (staged, unstaged or untracked) is pre-existing; only paths whose state
 * or content moved after it are reported as changed-while-the-task-ran.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { capture } from '../engines/process.js';
import { engineEnvironment } from '../engines/process.js';
import { probeBinary, probeFileHead } from './snapshot.js';
import {
  EMPTY_TEXT_EVIDENCE,
  type ChangeEntry,
  type ChangeEvidenceRef,
} from '../../shared/change-manifest.js';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 8 * 1024 * 1024;
const HASH_CONCURRENCY = 16;

export interface GitWorktreeFile {
  readonly path: string;
  /** Porcelain v2 XY status, '.' when clean. */
  readonly x: string;
  readonly y: string;
  /** HEAD / index / worktree modes ('100644', '100755', ...); null when Git has none. */
  readonly headMode: string | null;
  readonly indexMode: string | null;
  readonly worktreeMode: string | null;
  /** HEAD blob oid — addresses the committed content directly. */
  readonly headSha: string | null;
  /** Index blob sha — staged content moves even when the worktree matches it. */
  readonly stagedSha: string | null;
  /** Raw-content hash when the file differs from the index/HEAD. */
  readonly blobSha: string | null;
  readonly renamedFrom: string | null;
  /** Git's binary verdict (numstat) or the bounded head probe for untracked paths. */
  readonly binary: boolean;
}

/**
 * The mode a snapshot would report for this path: worktree when it moved away
 * from HEAD, otherwise the index (which carries staged transitions), otherwise
 * HEAD itself.
 */
export function effectiveGitMode(file: {
  headMode: string | null;
  indexMode: string | null;
  worktreeMode: string | null;
}): string | null {
  if (file.worktreeMode !== null && file.worktreeMode !== file.headMode)
    return file.worktreeMode;
  return file.indexMode ?? file.headMode;
}

export interface GitSnapshot {
  readonly captured: true;
  readonly head: string | null;
  readonly toplevel: string;
  readonly files: readonly GitWorktreeFile[];
  readonly statusDigest: string;
}

export interface GitUnavailable {
  readonly captured: false;
  readonly reason: string;
}

export type GitProbe = GitSnapshot | GitUnavailable;

const devNull = () => (process.platform === 'win32' ? 'NUL' : '/dev/null');

/**
 * The scrubbed Git environment. Inherited env is already filtered to a safe
 * list by `engineEnvironment`; on top of it every repo-config execution hook
 * is neutralized and every write path is pointed at throwaway state.
 */
function gitEnv(indexFile: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...engineEnvironment(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull(),
    GIT_CONFIG_SYSTEM: devNull(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1',
    // -c config equivalent via env: no hooks, no fsmonitor, no untracked cache,
    // no external diff drivers or textconv.
    GIT_CONFIG_COUNT: '6',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: devNull(),
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.untrackedCache',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'diff.external',
    GIT_CONFIG_VALUE_3: '',
    GIT_CONFIG_KEY_4: 'core.autocrlf',
    GIT_CONFIG_VALUE_4: 'false',
    GIT_CONFIG_KEY_5: 'core.eol',
    GIT_CONFIG_VALUE_5: 'native',
  };
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  return env;
}

async function git(root: string, args: string[], indexFile: string | null, input?: string) {
  const result = await capture(
    {
      file: 'git',
      args: ['-C', root, ...args],
      cwd: root,
      env: gitEnv(indexFile),
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: GIT_MAX_BYTES,
    },
    input,
  );
  if (result.code !== 0) throw new Error(`git ${args[0]} exited ${String(result.code)}`);
  return result.stdout;
}

/** Read one object from the repository's own object store — bounded, read-only. */
export async function gitBlobText(
  env: GitEnvironment,
  sha: string,
): Promise<string | null> {
  try {
    return await git(env.toplevel, ['cat-file', 'blob', sha], env.indexFile);
  } catch {
    return null;
  }
}

type PorcelainRow = Omit<GitWorktreeFile, 'blobSha' | 'binary'>;

/** Parse `status --porcelain=v2 -z`: NUL-separated records, rename entries carry a second field. */
export function parsePorcelainV2(output: string): PorcelainRow[] {
  const records = output.split('\0').filter((record) => record.length > 0);
  const files: PorcelainRow[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('#')) continue; // branch/header lines
    const kind = record[0];
    if (kind === '1') {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — path is token 8.
      const parts = record.split(' ');
      const pathText = parts.slice(8).join(' ');
      files.push({
        path: pathText,
        x: record[2],
        y: record[3],
        headMode: parts[3] ?? null,
        indexMode: parts[4] ?? null,
        worktreeMode: parts[5] ?? null,
        headSha: parts[6] ?? null,
        stagedSha: parts[7] ?? null,
        renamedFrom: null,
      });
    } else if (kind === '2') {
      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>` —
      // the score token makes the path token 9; the original name follows NUL.
      const parts = record.split(' ');
      const pathText = parts.slice(9).join(' ');
      const orig = records[index + 1] ?? null;
      index += 1;
      files.push({
        path: pathText,
        x: record[2],
        y: record[3],
        headMode: parts[3] ?? null,
        indexMode: parts[4] ?? null,
        worktreeMode: parts[5] ?? null,
        headSha: parts[6] ?? null,
        stagedSha: parts[7] ?? null,
        renamedFrom: orig,
      });
    } else if (kind === 'u') {
      // unmerged `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const parts = record.split(' ');
      files.push({
        path: parts.slice(10).join(' '),
        x: record[2],
        y: record[3],
        headMode: null,
        indexMode: null,
        worktreeMode: parts[5] ?? null,
        headSha: null,
        stagedSha: parts.slice(7, 10).join('+') || null,
        renamedFrom: null,
      });
    } else if (kind === '?') {
      files.push({
        path: record.slice(2),
        x: '.',
        y: '?',
        headMode: null,
        indexMode: null,
        worktreeMode: null,
        headSha: null,
        stagedSha: null,
        renamedFrom: null,
      });
    }
  }
  return files;
}

/**
 * Parse `diff --numstat -z --no-renames`: `added\tdeleted\tpath` records where
 * binary paths carry `-` for both counts. Git's own binary verdict — content-
 * level, attribute-aware, and it never reads the filename.
 */
export function parseNumstat(output: string): Set<string> {
  const binary = new Set<string>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tabA = record.indexOf('\t');
    const tabB = record.indexOf('\t', tabA + 1);
    if (tabA < 0 || tabB < 0) continue;
    if (record.slice(0, tabA) === '-' && record.slice(tabA + 1, tabB) === '-')
      binary.add(record.slice(tabB + 1));
  }
  return binary;
}

/**
 * Binary verdicts for tracked changes the way Git itself reports them:
 * index→worktree plus HEAD→index numstat against the private index. Returns
 * null when Git refuses — the caller falls back to the bounded head probe.
 */
async function numstatBinaryPaths(env: GitEnvironment): Promise<Set<string> | null> {
  try {
    const unstaged = await git(
      env.toplevel,
      ['diff', '--numstat', '-z', '--no-renames'],
      env.indexFile,
    );
    const staged = await git(
      env.toplevel,
      ['diff', '--cached', '--numstat', '-z', '--no-renames'],
      env.indexFile,
    );
    return new Set([...parseNumstat(unstaged), ...parseNumstat(staged)]);
  } catch {
    return null;
  }
}

async function inspectWorktreeFiles(
  env: GitEnvironment,
  files: PorcelainRow[],
): Promise<GitWorktreeFile[]> {
  const binarySet = await numstatBinaryPaths(env);
  const result: GitWorktreeFile[] = [];
  for (let index = 0; index < files.length; index += HASH_CONCURRENCY) {
    const batch = files.slice(index, index + HASH_CONCURRENCY);
    const hashed = await Promise.all(
      batch.map(async (file): Promise<GitWorktreeFile> => {
        // Only worktree-visible states carry content; staged-only or deleted
        // paths have nothing to hash or probe on disk.
        if (file.y === '.' || file.y === 'D' || file.x === 'D')
          return { ...file, blobSha: null, binary: binarySet?.has(file.path) ?? false };
        let blobSha: string | null = null;
        let binary = binarySet?.has(file.path) ?? false;
        try {
          blobSha =
            (await git(env.toplevel, ['hash-object', '--no-filters', '--', file.path], env.indexFile)).trim() ||
            null;
        } catch {
          blobSha = null;
        }
        if (!binary) {
          try {
            binary = probeBinary(await probeFileHead(path.join(env.toplevel, file.path)));
          } catch {
            /* unreadable content stays non-binary rather than guessed */
          }
        }
        return { ...file, blobSha, binary };
      }),
    );
    result.push(...hashed);
  }
  return result;
}

export function statusDigest(files: readonly GitWorktreeFile[]): string {
  const hash = createHash('sha256');
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered)
    hash.update(
      `${file.path}\0${file.x}${file.y}\0${effectiveGitMode(file) ?? ''}\0${file.blobSha ?? ''}\0${file.stagedSha ?? ''}\0${file.renamedFrom ?? ''}\n`,
    );
  return `sha256:${hash.digest('hex')}`;
}

export interface GitEnvironment {
  readonly dir: string;
  readonly toplevel: string;
  readonly head: string | null;
  readonly indexFile: string;
  /** The repository's real index — re-read per snapshot, never written. */
  readonly realIndex: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Prepare an isolated inspection context for one repository: a temp directory
 * holding a private index seeded from the real one. Nothing here writes to
 * `.git` — the only object path used is read-only hashing.
 */
export async function prepareGit(root: string): Promise<GitEnvironment | null> {
  let toplevel: string;
  try {
    toplevel = (await git(root, ['rev-parse', '--show-toplevel'], null)).trim();
  } catch {
    return null; // Not a repository.
  }
  const gitDir = (
    await git(toplevel, ['rev-parse', '--absolute-git-dir'], null)
  ).trim();
  const head = (await git(toplevel, ['rev-parse', '--verify', 'HEAD'], null)).trim() || null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-git-'));
  const indexFile = path.join(dir, 'index');
  const realIndex = path.join(gitDir, 'index');
  try {
    await fs.copyFile(realIndex, indexFile);
  } catch {
    // No index yet (fresh init): seed the temp index from HEAD.
    try {
      if (head) await git(toplevel, ['read-tree', 'HEAD'], indexFile);
    } catch {
      /* an empty index is still a valid baseline */
    }
  }
  return {
    dir,
    toplevel,
    head,
    indexFile,
    realIndex,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** One worktree status read against the private index. */
export async function snapshotGit(env: GitEnvironment): Promise<GitProbe> {
  try {
    // Refresh the private index copy so staging that happened since the last
    // snapshot is visible. A torn copy fails the read honestly below.
    await fs.copyFile(env.realIndex, env.indexFile).catch(() => undefined);
    const raw = await git(
      env.toplevel,
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--no-ahead-behind',
      ],
      env.indexFile,
    );
    const parsed = parsePorcelainV2(raw);
    const files = await inspectWorktreeFiles(env, parsed);
    return {
      captured: true,
      head: env.head,
      toplevel: env.toplevel,
      files,
      statusDigest: statusDigest(files),
    };
  } catch (error) {
    return {
      captured: false,
      reason: error instanceof Error ? error.message : 'Git status could not be read.',
    };
  }
}

const KIND_BY_STATUS: Record<string, ChangeEntry['kind']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  T: 'modified',
  '?': 'added',
};

function entryKind(file: GitWorktreeFile): ChangeEntry['kind'] {
  if (file.renamedFrom) return 'renamed';
  const code = file.y !== '.' ? file.y : file.x;
  return KIND_BY_STATUS[code] ?? 'modified';
}

const sameFile = (a: GitWorktreeFile, b: GitWorktreeFile): boolean =>
  a.x === b.x &&
  a.y === b.y &&
  a.blobSha === b.blobSha &&
  a.stagedSha === b.stagedSha &&
  a.renamedFrom === b.renamedFrom &&
  effectiveGitMode(a) === effectiveGitMode(b) &&
  a.binary === b.binary;

function gitEvidence(
  file: GitWorktreeFile,
  was: GitWorktreeFile | undefined,
  base: readonly ChangeEvidenceRef[],
): ChangeEvidenceRef[] {
  const evidence: ChangeEvidenceRef[] = [
    ...base,
    { kind: 'git-record', record: `status:${file.x}${file.y}`, path: file.path },
  ];
  const before = was ? effectiveGitMode(was) : null;
  const after = effectiveGitMode(file);
  if (before !== after)
    evidence.push({
      kind: 'git-record',
      record: `mode:${before ?? 'untracked'}->${after ?? 'gone'}`,
      path: file.path,
    });
  if (file.binary)
    evidence.push({ kind: 'git-record', record: 'binary:numstat-or-content', path: file.path });
  return evidence;
}

/**
 * Diff two Git snapshots. A path present before and after with identical
 * status, content hash and mode is pre-existing work — not this run's.
 * Everything new or moved is `observed` evidence: changed while the task ran.
 */
export function diffGitSnapshots(
  before: readonly GitWorktreeFile[],
  after: readonly GitWorktreeFile[],
  evidence: readonly ChangeEvidenceRef[],
): ChangeEntry[] {
  const beforeMap = new Map(before.map((f) => [f.path, f]));
  const entries: ChangeEntry[] = [];
  for (const file of after) {
    const was = beforeMap.get(file.path);
    if (was && sameFile(was, file)) continue;
    // A path dirty at baseline in exactly the same state is pre-existing.
    // When the baseline never listed the path it was clean then — a tracked
    // row still carries its HEAD mode and blob, which is the real before-state
    // for a clean file. Untracked rows have neither and stay null.
    entries.push({
      id: `git:${file.path}`,
      path: file.path,
      kind: entryKind(file),
      attribution: 'observed',
      source: 'git',
      beforeSha: was ? (was.blobSha ?? was.headSha) : file.headSha,
      afterSha: file.blobSha,
      sizeBefore: null,
      sizeAfter: null,
      addedLines: null,
      removedLines: null,
      binary: file.binary,
      modeBefore: was ? effectiveGitMode(was) : file.headMode,
      modeAfter: effectiveGitMode(file),
      renamedFrom: file.renamedFrom,
      textEvidence: EMPTY_TEXT_EVIDENCE,
      changeIds: [],
      settled: null,
      historyEntryIds: [],
      fields: [],
      evidence: gitEvidence(file, was, evidence),
    });
  }
  // Paths dirty at baseline and clean now also changed while the task ran —
  // e.g. work committed or reverted mid-run.
  const afterMap = new Map(after.map((f) => [f.path, f]));
  for (const file of before) {
    if (afterMap.has(file.path)) continue;
    entries.push({
      id: `git:${file.path}`,
      path: file.path,
      kind: 'modified',
      attribution: 'observed',
      source: 'git',
      beforeSha: file.blobSha,
      afterSha: null,
      sizeBefore: null,
      sizeAfter: null,
      addedLines: null,
      removedLines: null,
      binary: file.binary,
      modeBefore: effectiveGitMode(file),
      modeAfter: null,
      renamedFrom: null,
      textEvidence: EMPTY_TEXT_EVIDENCE,
      changeIds: [],
      settled: null,
      historyEntryIds: [],
      fields: [],
      evidence: [
        ...evidence,
        { kind: 'git-record', record: `status:${file.x}${file.y}->clean`, path: file.path },
      ],
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
