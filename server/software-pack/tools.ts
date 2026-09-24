/**
 * The Software Engineering pack's typed tools (P07), under H12's contract.
 *
 * Reads (`git_status`, `git_file`, `git_diff`) are `read` tools: they look at
 * the project folder the Files pane can already read, and change nothing.
 * Writes (`worktree_add`, `worktree_remove`, `run_command`) are
 * `non-idempotent-effect` tools: each declares the targets it may change,
 * needs `write-project-file` and waits for an exact approval of its intent,
 * and its effect record is written before it runs (`ToolRegistry.dispatch`).
 *
 * A known outcome is returned, never thrown. A non-zero exit, a timeout that
 * ended the process tree, a dirty worktree that was left alone: each is what
 * happened, and saying so is not an error. Only something unforeseen throws,
 * and H12 then records the effect as uncertain rather than guess.
 *
 * Every tool refuses in a Project that has not turned the pack on.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  COMMAND_LIMITS,
  CONTEXT_LIMITS,
  GIT_LIMITS,
  MAX_WORKTREES,
  WORKTREE_FOLDER,
  WORKTREE_NAME,
  branchProblem,
  parseCommandLine,
} from '../../shared/software-pack.js';
import { containedPath, containedSpawn } from '../harness/containment.js';
import { HarnessError } from '../harness/policy.js';
import type { ToolRegistry } from '../harness/tools.js';
import { readTextOrNull } from '../paths.js';
import {
  diffAgainstHead,
  fileAtHead,
  fingerprint,
  git,
  listWorktrees,
  newFileDiff,
  readRepository,
  repositoryProblem,
  worktreeDirty,
} from './git.js';

export const SOFTWARE_READ_TOOLS = ['git_status', 'git_file', 'git_diff'] as const;
export const SOFTWARE_WRITE_TOOLS = ['worktree_add', 'worktree_remove', 'run_command'] as const;

export interface SoftwareToolHost {
  /** The project folder. */
  root(projectId: string): string;
  /** Whether the pack is on in this Project right now. */
  active(projectId: string): boolean;
  now(): string;
}

const projectId = z.string().min(1).max(100);

const changedFile = z.strictObject({
  path: z.string(),
  from: z.string().nullable(),
  kind: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted', 'type-changed']),
  staged: z.boolean(),
  unstaged: z.boolean(),
});
export const repositoryView = z.strictObject({
  state: z.enum(['repository', 'not-a-repository', 'git-unavailable', 'unreadable']),
  detail: z.string().nullable(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  head: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  changes: z.array(changedFile),
  moreChanges: z.number().int().nonnegative(),
  privateChanges: z.number().int().nonnegative(),
  commits: z.array(z.strictObject({ sha: z.string(), author: z.string(), date: z.string(), subject: z.string() })),
  readAt: z.string(),
});

export const commandOutcome = z.strictObject({
  outcome: z.enum(['passed', 'failed', 'timed-out', 'output-capped', 'error', 'refused']),
  code: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  fingerprint: z.strictObject({ head: z.string().nullable(), digest: z.string().nullable() }).nullable(),
  detail: z.string(),
});
export type CommandOutcome = z.infer<typeof commandOutcome>;

export const worktreeOutcome = z.strictObject({
  outcome: z.enum(['done', 'refused', 'error']),
  code: z.string().nullable(),
  path: z.string(),
  branch: z.string().nullable(),
  detail: z.string(),
});
export type WorktreeOutcome = z.infer<typeof worktreeOutcome>;

const tail = (text: string) => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= COMMAND_LIMITS.tailBytes) return text;
  return `…${bytes.subarray(bytes.byteLength - COMMAND_LIMITS.tailBytes).toString('utf8')}`;
};

const base = { version: 'v1', destination: 'local', trustedInputRequired: false, cost: 1 } as const;

const inactive = () =>
  new HarnessError('pack_inactive', 'The Software Engineering pack is off in this project, so its tools do not run here.');

export function registerSoftwareTools(tools: ToolRegistry, host: SoftwareToolHost) {
  const rootOf = (id: string) => {
    if (!host.active(id)) throw inactive();
    return host.root(id);
  };

  tools.register({
    ...base,
    name: 'git_status',
    description: "Read the project repository's branch, changed files and recent commits. Changes nothing.",
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    schema: z.strictObject({ projectId }),
    outputSchema: repositoryView,
    limits: { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 },
    execute: async ({ input }) => repositoryView.parse(await readRepository(rootOf(input.projectId), host.now())),
  });

  tools.register({
    ...base,
    name: 'git_file',
    description: 'Read one changed file as it is at HEAD and as it is now, for a diff. Changes nothing.',
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    schema: z.strictObject({ projectId, path: z.string().min(1).max(1000) }),
    outputSchema: z.strictObject({
      path: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
      binary: z.boolean(),
      tooLarge: z.boolean(),
    }),
    limits: { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 },
    execute: async ({ input }) => {
      const root = rootOf(input.projectId);
      const found = await containedPath(root, input.path, { write: false });
      const head = await fileAtHead(root, found.relative);
      let after: string | null = null;
      let binary = head.binary;
      let tooLarge = head.tooLarge;
      try {
        const stat = await fs.lstat(found.absolute).catch(() => null);
        if (stat && stat.size > GIT_LIMITS.maxFileBytes) tooLarge = true;
        else after = await readTextOrNull(found.absolute);
      } catch {
        binary = true;
      }
      return { path: found.relative, before: head.text, after, binary, tooLarge };
    },
  });

  tools.register({
    ...base,
    name: 'git_diff',
    description: 'The unified diff of chosen changed files against HEAD, whole or not at all. Changes nothing.',
    effect: 'read',
    effectClass: 'read',
    permission: null,
    approval: false,
    schema: z.strictObject({
      projectId,
      paths: z.array(z.string().min(1).max(1000)).min(1).max(GIT_LIMITS.maxChanges),
      untracked: z.array(z.string().min(1).max(1000)).max(GIT_LIMITS.maxChanges),
    }),
    outputSchema: z.strictObject({ text: z.string(), tooLarge: z.boolean() }),
    limits: { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 },
    execute: async ({ input }) => {
      const root = rootOf(input.projectId);
      const tracked = [];
      for (const name of input.paths) tracked.push((await containedPath(root, name, { write: false })).relative);
      const untracked = new Set<string>();
      for (const name of input.untracked) untracked.add((await containedPath(root, name, { write: false })).relative);
      const max = CONTEXT_LIMITS.maxDiffBytes;
      const diff = await diffAgainstHead(root, tracked.filter((name) => !untracked.has(name)), max + 1);
      if (diff.tooLarge) return { text: '', tooLarge: true };
      let text = diff.text;
      for (const name of untracked) {
        const found = await containedPath(root, name, { write: false });
        const body = await readTextOrNull(found.absolute).catch(() => null);
        if (body !== null) text += newFileDiff(found.relative, body);
        if (Buffer.byteLength(text, 'utf8') > max) return { text: '', tooLarge: true };
      }
      if (Buffer.byteLength(text, 'utf8') > max) return { text: '', tooLarge: true };
      return { text, tooLarge: false };
    },
  });

  const worktreeInput = z.strictObject({
    projectId,
    name: z.string().regex(WORKTREE_NAME),
    branch: z.string().min(1).max(100),
  });
  const worktreePath = (name: string) => `${WORKTREE_FOLDER}/${name}`;

  tools.register({
    ...base,
    name: 'worktree_add',
    description: `Add a git worktree on a new branch under ${WORKTREE_FOLDER}, so work happens away from your checkout.`,
    effect: 'non-idempotent',
    effectClass: 'non-idempotent-effect',
    permission: 'write-project-file',
    approval: true,
    schema: worktreeInput,
    outputSchema: worktreeOutcome,
    targets: (input) => [worktreePath(input.name), `git-branch:${input.branch}`],
    limits: { timeoutMs: 120_000 },
    execute: async ({ input }) => {
      const relative = worktreePath(input.name);
      const refused = (code: string, detail: string): WorktreeOutcome => ({
        outcome: 'refused',
        code,
        path: relative,
        branch: input.branch,
        detail,
      });
      if (!host.active(input.projectId)) return refused('pack_inactive', inactive().message);
      const root = host.root(input.projectId);
      const problem = branchProblem(input.branch);
      if (problem) return refused('branch_invalid', problem);
      const repository = await repositoryProblem(root);
      if (repository) return refused('not_a_repository', repository);
      const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (head.code !== 0) return refused('no_commit', 'This repository has no commit yet, so there is nothing to branch from.');
      let found;
      try {
        found = await containedPath(root, relative, { write: true });
      } catch (error) {
        if (error instanceof HarnessError) return refused(error.code, `${error.message} Nothing was changed.`);
        throw error;
      }
      if (await fs.lstat(found.absolute).catch(() => null))
        return refused('worktree_exists', `${relative} already exists. Nothing was changed.`);
      if ((await listWorktrees(root)).length - 1 >= MAX_WORKTREES)
        return refused('worktree_limit', `This project already has ${MAX_WORKTREES} worktrees. Remove one first.`);
      const format = await git(root, ['check-ref-format', '--branch', input.branch]);
      if (format.code !== 0) return refused('branch_invalid', 'That branch name is not one git accepts.');
      const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`]);
      if (exists.code === 0)
        return refused('branch_exists', `A branch called ${input.branch} already exists. Choose a new name; nothing was changed.`);
      const added = await git(root, ['worktree', 'add', '-b', input.branch, relative, 'HEAD'], { timeoutMs: 90_000 });
      if (added.code !== 0)
        return {
          outcome: 'error',
          code: null,
          path: relative,
          branch: input.branch,
          detail: `git could not add the worktree: ${added.stderr.trim().slice(0, 400) || `it exited ${added.code}`}.`,
        };
      return {
        outcome: 'done',
        code: null,
        path: relative,
        branch: input.branch,
        detail: `Added ${relative} on the new branch ${input.branch}, from ${head.stdout.trim().slice(0, 12)}. Your checkout was not touched.`,
      };
    },
  });

  tools.register({
    ...base,
    name: 'worktree_remove',
    description: 'Remove a worktree this pack added, only when nothing in it is uncommitted. Never forced.',
    effect: 'non-idempotent',
    effectClass: 'non-idempotent-effect',
    permission: 'write-project-file',
    approval: true,
    schema: z.strictObject({ projectId, name: z.string().regex(WORKTREE_NAME) }),
    outputSchema: worktreeOutcome,
    targets: (input) => [worktreePath(input.name)],
    limits: { timeoutMs: 120_000 },
    execute: async ({ input }) => {
      const relative = worktreePath(input.name);
      const refused = (code: string, detail: string): WorktreeOutcome => ({
        outcome: 'refused',
        code,
        path: relative,
        branch: null,
        detail,
      });
      if (!host.active(input.projectId)) return refused('pack_inactive', inactive().message);
      const root = host.root(input.projectId);
      let found;
      try {
        found = await containedPath(root, relative, { write: false });
      } catch (error) {
        if (error instanceof HarnessError) return refused(error.code, `${error.message} Nothing was changed.`);
        throw error;
      }
      const stat = await fs.lstat(found.absolute).catch(() => null);
      if (!stat?.isDirectory()) return refused('worktree_missing', `${relative} is not there. Nothing was changed.`);
      const real = await fs.realpath(found.absolute);
      const known = await Promise.all((await listWorktrees(root)).map((item) => fs.realpath(item).catch(() => item)));
      const fold = (value: string) => (process.platform === 'linux' ? value : value.toLowerCase());
      if (!known.some((item) => fold(path.resolve(item)) === fold(real)))
        return refused('not_a_worktree', `${relative} is not a worktree of this repository. Nothing was changed.`);
      const dirty = await worktreeDirty(root, relative);
      if (dirty.length)
        return refused(
          'worktree_dirty',
          `${relative} has ${dirty.length === 1 ? '1 file' : `${dirty.length} files`} with uncommitted changes (${dirty
            .slice(0, 3)
            .join(', ')}${dirty.length > 3 ? ', …' : ''}). Commit or discard them yourself first; Diomedes never force-removes a worktree. Nothing was removed.`,
        );
      // No --force: git refuses a dirty or locked worktree itself, a second guard behind the check above.
      const removed = await git(root, ['worktree', 'remove', relative], { timeoutMs: 90_000 });
      if (removed.code !== 0)
        return {
          outcome: 'error',
          code: null,
          path: relative,
          branch: null,
          detail: `git did not remove the worktree: ${removed.stderr.trim().slice(0, 400) || `it exited ${removed.code}`}. Nothing was forced.`,
        };
      return {
        outcome: 'done',
        code: null,
        path: relative,
        branch: null,
        detail: `Removed ${relative}. Its branch and commits are kept.`,
      };
    },
  });

  tools.register({
    ...base,
    name: 'run_command',
    description: 'Run one command declared for this project, as plain words with no shell, a minimal environment, bounded output and a timeout.',
    effect: 'non-idempotent',
    effectClass: 'non-idempotent-effect',
    permission: 'write-project-file',
    approval: true,
    schema: z.strictObject({
      projectId,
      commandId: z.string().min(1).max(80),
      argv: z.array(z.string().min(1).max(COMMAND_LIMITS.maxLength)).min(1).max(COMMAND_LIMITS.maxWords),
      cwd: z.string().max(1000),
      timeoutMs: z.number().int().min(COMMAND_LIMITS.minTimeoutMs).max(COMMAND_LIMITS.maxTimeoutMs),
    }),
    outputSchema: commandOutcome,
    targets: (input) => [input.cwd || '.', `command:${input.argv.join(' ')}`],
    // H12's hard cap. The process's own timeout is below it, so the tool reports a timeout itself.
    limits: { timeoutMs: 10 * 60_000 },
    execute: async ({ input, signal }): Promise<CommandOutcome> => {
      const startedAt = host.now();
      const began = Date.now();
      const result = (
        outcome: CommandOutcome['outcome'],
        detail: string,
        rest: Partial<CommandOutcome> = {},
      ): CommandOutcome => ({
        outcome,
        code: null,
        exitCode: null,
        startedAt,
        endedAt: host.now(),
        durationMs: Date.now() - began,
        stdoutTail: '',
        stderrTail: '',
        fingerprint: null,
        detail,
        ...rest,
      });
      if (!host.active(input.projectId)) return result('refused', inactive().message, { code: 'pack_inactive' });
      // The words are judged again here, at the point of use, never trusted from the request.
      const parsed = parseCommandLine(input.argv.join(' '));
      if (!parsed.ok || parsed.argv.join('\0') !== input.argv.join('\0'))
        return result('refused', parsed.ok ? 'The command changed between approval and use.' : parsed.message, {
          code: parsed.ok ? 'command_changed' : parsed.code,
        });
      const root = host.root(input.projectId);
      const state = await fingerprint(root);
      try {
        const ran = await containedSpawn(root, input.cwd || '.', parsed.argv[0]!, parsed.argv.slice(1), {
          timeoutMs: input.timeoutMs,
          maxOutputBytes: COMMAND_LIMITS.maxOutputBytes,
          signal,
        });
        return result(
          ran.code === 0 ? 'passed' : 'failed',
          ran.code === 0 ? 'It exited 0.' : `It exited ${ran.code ?? 'without a code (stopped by a signal)'}.`,
          { exitCode: ran.code, stdoutTail: tail(ran.stdout), stderrTail: tail(ran.stderr), fingerprint: state },
        );
      } catch (error) {
        const partial = (error as { partial?: { stdout: string; stderr: string } }).partial;
        const tails = { stdoutTail: tail(partial?.stdout ?? ''), stderrTail: tail(partial?.stderr ?? ''), fingerprint: state };
        if (error instanceof HarnessError && error.code === 'tool_timeout')
          return result('timed-out', `It did not finish within ${Math.round(input.timeoutMs / 1000)} s, so it and every process it started were ended.`, tails);
        if (error instanceof HarnessError && error.code === 'tool_output_too_large')
          return result('output-capped', `It wrote more than ${COMMAND_LIMITS.maxOutputBytes / 1024 / 1024} MB, so it and every process it started were ended.`, tails);
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'ENOENT' || code === 'EINVAL' || code === 'EACCES')
          return result(
            'error',
            process.platform === 'win32'
              ? `${parsed.argv[0]} could not be started directly. Diomedes runs a program without a shell, and on Windows a .cmd or .bat script needs one; declare the program it runs instead, such as node.`
              : `${parsed.argv[0]} could not be started: it was not found on the search path or cannot be run.`,
            { code: 'program_unavailable', fingerprint: state },
          );
        if (error instanceof HarnessError && error.code?.startsWith('path_'))
          return result('refused', error.message, { code: error.code });
        throw error;
      }
    },
  });
}
