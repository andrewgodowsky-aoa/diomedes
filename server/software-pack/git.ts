/**
 * Reading a Project's repository with the `git` program, for the Software
 * Engineering pack (P07).
 *
 * Every call goes through H12's `containedSpawn`: no shell, a working folder
 * inside the project through the containment funnel, a minimal environment,
 * bounded output and a timeout that ends the process tree. On top of that,
 * each call is pinned so that reading a repository cannot run anything the
 * repository names:
 *
 * - `GIT_CEILING_DIRECTORIES` is the project folder's parent, so git never
 *   walks up and reads a repository that contains the project. A project
 *   that is a subfolder of someone's repository is honestly "not a
 *   repository" here, because that repository reaches outside the project.
 * - no HOME and `GIT_CONFIG_NOSYSTEM`, so no global or system configuration;
 * - `core.fsmonitor=false` (a configured monitor is a program git would run),
 *   `--no-ext-diff` and `--no-textconv` on every diff, `--no-optional-locks`
 *   so a read never rewrites the index, and hooks pointed at a folder that
 *   does not exist, so a worktree change runs none of the repository's hooks.
 *
 * Nothing here decides authority. The tools in `tools.ts` call these, and
 * the writes among them wait for an exact approval first.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  GIT_LIMITS,
  WORKTREE_FOLDER,
  notRepository,
  type ChangeKind,
  type ChangedFile,
  type CommitSummary,
  type RepositoryFingerprint,
  type RepositoryView,
} from '../../shared/software-pack.js';
import { containedSpawn } from '../harness/containment.js';
import { HarnessError } from '../harness/policy.js';
import { relativeName } from '../paths.js';

/** Settings every git call carries, ahead of its own arguments. */
const PINNED = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=off',
  '-c',
  'color.ui=false',
  '-c',
  'core.hooksPath=.diomedes-no-hooks',
  '-c',
  'advice.detachedHead=false',
  '--no-pager',
];

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class GitUnavailable extends Error {
  constructor() {
    super('Git is not installed or not on the search path, so the repository cannot be read.');
  }
}

/** The environment git runs in: the minimal one, plus the pins above. */
async function gitEnv(root: string): Promise<Record<string, string>> {
  let real = root;
  try {
    real = await fs.realpath(root);
  } catch {
    // The funnel below refuses a missing root with its own reason.
  }
  return {
    GIT_CEILING_DIRECTORIES: path.dirname(real),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** Run git once. `cwd` is project-relative and goes through the containment funnel. */
export async function git(
  root: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {},
): Promise<GitResult> {
  try {
    return await containedSpawn(root, options.cwd ?? '.', 'git', [...PINNED, ...args], {
      timeoutMs: options.timeoutMs ?? GIT_LIMITS.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? GIT_LIMITS.maxOutputBytes,
      env: await gitEnv(root),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new GitUnavailable();
    throw error;
  }
}

const sameFolder = async (a: string, b: string) => {
  try {
    const [x, y] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return process.platform === 'win32' || process.platform === 'darwin'
      ? x.toLowerCase() === y.toLowerCase()
      : x === y;
  } catch {
    return false;
  }
};

/**
 * Whether the project folder is itself the top of a repository. Returns the
 * reason it is not, in a plain sentence, or null when it is.
 */
export async function repositoryProblem(root: string): Promise<string | null> {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return 'This project folder is not a Git repository.';
  const named = top.stdout.trim();
  if (!named || !(await sameFolder(named, root)))
    return 'This project folder is inside a repository but is not its top folder, so Diomedes does not read it as one.';
  return null;
}

// --- parsing -----------------------------------------------------------------------

const KIND: Record<string, ChangeKind> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'conflicted',
};

export interface StatusHeader {
  head: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

/**
 * `git status --porcelain=v2 --branch -z`, as data. Paths are exactly as git
 * wrote them, with forward slashes; a rename carries where it came from.
 */
export function parseStatusV2(output: string): { header: StatusHeader; changes: ChangedFile[] } {
  const header: StatusHeader = { head: null, branch: null, detached: false, upstream: null, ahead: null, behind: null };
  const changes: ChangedFile[] = [];
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') header.head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        header.detached = value === '(detached)';
        header.branch = header.detached ? null : value;
      } else if (key === 'branch.upstream') header.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          header.ahead = Number(match[1]);
          header.behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = record[0];
    if (type === '?') {
      changes.push({ path: record.slice(2), from: null, kind: 'untracked', staged: false, unstaged: true });
      continue;
    }
    if (type === '!') continue;
    if (type === '1' || type === '2' || type === 'u') {
      // Fixed fields before the path: 8 for an ordinary entry, 9 for a rename or
      // copy, 10 for an unmerged one. The path is everything after them.
      const fields = type === '1' ? 8 : type === '2' ? 9 : 10;
      const parts = record.split(' ');
      const xy = parts[1] ?? '..';
      const file = parts.slice(fields).join(' ');
      const from = type === '2' ? (records[++index] ?? null) : null;
      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      const kind: ChangeKind =
        type === 'u' ? 'conflicted' : type === '2' ? KIND[x] ?? KIND[y] ?? 'renamed' : KIND[x !== '.' ? x : y] ?? 'modified';
      changes.push({ path: file, from, kind, staged: x !== '.', unstaged: y !== '.' });
    }
  }
  return { header, changes };
}

const UNIT = '\x1f';
const RECORD = '\x1e';
export const LOG_FORMAT = `--format=%H${UNIT}%an${UNIT}%aI${UNIT}%s${RECORD}`;

export function parseLog(output: string): CommitSummary[] {
  return output
    .split(RECORD)
    .map((item) => item.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((item) => {
      const [sha = '', author = '', date = '', subject = ''] = item.split(UNIT);
      return { sha, author, date, subject };
    })
    .filter((commit) => /^[0-9a-f]{40,64}$/.test(commit.sha));
}

/** A name the path guard would refuse to open is not listed by name either. */
const privateName = (name: string) => {
  try {
    relativeName(name);
    return false;
  } catch {
    return true;
  }
};

const EXCLUDE_WORKTREES = `:(exclude)${WORKTREE_FOLDER}`;

// --- the reads ---------------------------------------------------------------------

/** Branch, changed files and recent commits, or an honest reason there are none. */
export async function readRepository(root: string, at: string): Promise<RepositoryView> {
  let problem: string | null;
  try {
    problem = await repositoryProblem(root);
  } catch (error) {
    if (error instanceof GitUnavailable) return notRepository('git-unavailable', error.message, at);
    return notRepository('unreadable', error instanceof Error ? error.message : 'The repository could not be read.', at);
  }
  if (problem) return notRepository('not-a-repository', problem, at);
  const status = await git(root, [
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
    EXCLUDE_WORKTREES,
  ]);
  if (status.code !== 0)
    return notRepository('unreadable', firstLine(status.stderr) ?? 'git status did not finish.', at);
  const { header, changes } = parseStatusV2(status.stdout);
  const visible = changes.filter((change) => !privateName(change.path) && (change.from === null || !privateName(change.from)));
  let commits: CommitSummary[] = [];
  if (header.head) {
    const log = await git(root, ['log', `-n${GIT_LIMITS.commits}`, '--no-show-signature', LOG_FORMAT]);
    if (log.code === 0) commits = parseLog(log.stdout);
  }
  return {
    state: 'repository',
    detail: null,
    branch: header.branch,
    detached: header.detached,
    head: header.head,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    changes: visible.slice(0, GIT_LIMITS.maxChanges),
    moreChanges: Math.max(0, visible.length - GIT_LIMITS.maxChanges),
    privateChanges: changes.length - visible.length,
    commits,
    readAt: at,
  };
}

const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;

/** One file's text at HEAD, or null when HEAD does not have it. Refuses a binary or oversized file. */
export async function fileAtHead(root: string, name: string): Promise<{ text: string | null; binary: boolean; tooLarge: boolean }> {
  const relative = relativeName(name);
  try {
    const shown = await git(root, ['--no-optional-locks', 'show', `HEAD:${relative}`], {
      maxOutputBytes: GIT_LIMITS.maxFileBytes,
    });
    if (shown.code !== 0) return { text: null, binary: false, tooLarge: false };
    if (shown.stdout.includes('\0')) return { text: null, binary: true, tooLarge: false };
    return { text: shown.stdout, binary: false, tooLarge: false };
  } catch (error) {
    if (error instanceof HarnessError && error.code === 'tool_output_too_large') return { text: null, binary: false, tooLarge: true };
    throw error;
  }
}

/** The unified diff of these files against HEAD, as git writes it. Bounded by `maxBytes`. */
export async function diffAgainstHead(root: string, names: readonly string[], maxBytes: number): Promise<{ text: string; tooLarge: boolean }> {
  const paths = names.map((name) => relativeName(name));
  if (!paths.length) return { text: '', tooLarge: false };
  try {
    const diff = await git(root, ['--no-optional-locks', 'diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--', ...paths], {
      maxOutputBytes: maxBytes,
    });
    return { text: diff.code === 0 ? diff.stdout : '', tooLarge: false };
  } catch (error) {
    if (error instanceof HarnessError && error.code === 'tool_output_too_large') return { text: '', tooLarge: true };
    throw error;
  }
}

/** A new file as a unified diff, the way git prints one, for a file git does not track yet. */
export function newFileDiff(name: string, text: string): string {
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  return [
    `diff --git a/${name} b/${name}`,
    'new file',
    '--- /dev/null',
    `+++ b/${name}`,
    ...(lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)] : []),
    ...(text.length && !text.endsWith('\n') ? ['\\ No newline at end of file'] : []),
  ].join('\n') + '\n';
}

/**
 * What the repository looked like, as one digest: HEAD, the porcelain status,
 * the full diff against HEAD and the content of every untracked file. Two
 * equal fingerprints mean a command would be judging the same bytes. Null
 * digest when the folder is not a repository or the state is too large.
 */
export async function fingerprint(root: string): Promise<RepositoryFingerprint | null> {
  try {
    if (await repositoryProblem(root)) return null;
    const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const headSha = head.code === 0 ? head.stdout.trim() || null : null;
    const status = await git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', EXCLUDE_WORKTREES]);
    if (status.code !== 0) return { head: headSha, digest: null };
    const hashed = createHash('sha256');
    hashed.update(`head:${headSha ?? ''}\0status:${status.stdout}\0`);
    if (headSha) {
      const diff = await git(root, ['--no-optional-locks', 'diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--no-color']);
      if (diff.code !== 0) return { head: headSha, digest: null };
      hashed.update(`diff:${diff.stdout}\0`);
    }
    const untracked = status.stdout
      .split('\0')
      .filter((item) => item.startsWith('?? '))
      .map((item) => item.slice(3));
    if (untracked.length) {
      const objects = await git(root, ['hash-object', '--no-filters', '--', ...untracked]);
      if (objects.code !== 0) return { head: headSha, digest: null };
      hashed.update(`untracked:${objects.stdout}\0`);
    }
    return { head: headSha, digest: hashed.digest('hex') };
  } catch {
    return null;
  }
}

/** The folders git knows as worktrees of this repository, as resolved absolute paths. */
export async function listWorktrees(root: string): Promise<string[]> {
  const listed = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  if (listed.code !== 0) return [];
  return listed.stdout
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

/** Whether a worktree has anything git would lose on removal: changes, staged or not, or untracked files. */
export async function worktreeDirty(root: string, relative: string): Promise<string[]> {
  const status = await git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: relative });
  if (status.code !== 0) throw new Error(firstLine(status.stderr) ?? 'git status did not finish in the worktree.');
  return status.stdout
    .split('\0')
    .filter(Boolean)
    .map((item) => item.slice(3))
    .filter(Boolean);
}
