/**
 * The Software Engineering pack's repository slice (P07): what it records and
 * shows about a Project's repository, its worktrees and its declared commands.
 *
 * Everything here is data and pure functions. The host runs `git` and the
 * declared commands through H12's contained spawn (`server/software-pack/`);
 * nothing here touches a process, a file or the clock.
 *
 * Three rules the rest of the slice leans on:
 *
 * 1. **It loads only where the pack is on.** Every route and tool refuses in a
 *    Project that has not activated `diomedes.software-engineering`, and the
 *    Console shows nothing of it there.
 * 2. **Reads are reads; every write asks.** Reading status and history is a
 *    read of the project folder the Files pane can already read. Creating or
 *    removing a worktree and running a declared command are H12
 *    `non-idempotent-effect` tools with recorded intent and targets, each
 *    waiting for an exact approval of that one intent.
 * 3. **argv only, never a shell.** A declared command is split on spaces into
 *    plain words. A word carrying anything a shell would interpret is refused
 *    rather than quoted, and a shell spelled as the program is refused too.
 */

export const SOFTWARE_PACK_ID = 'diomedes.software-engineering' as const;

/** Bounds on every `git` read. A read that passes them is refused, never cut part way. */
export const GIT_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxOutputBytes: 2 * 1024 * 1024,
  /** Changed files listed at most; the rest are counted. */
  maxChanges: 500,
  /** Recent commits shown. */
  commits: 20,
  /** One file's text, at HEAD or now, for a diff. */
  maxFileBytes: 512 * 1024,
});

/** Bounds on a declared command run. */
export const COMMAND_LIMITS = Object.freeze({
  defaultTimeoutMs: 120_000,
  /** Under H12's 10 minute hard cap on one tool call, with room to record the result. */
  maxTimeoutMs: 9 * 60_000,
  minTimeoutMs: 1_000,
  maxOutputBytes: 1024 * 1024,
  /** What is kept of each stream on the record: the end, which is where a test runner reports. */
  tailBytes: 16 * 1024,
  maxCommands: 32,
  maxWords: 32,
  maxLength: 500,
  /** Run records kept on the project; older ones stay in their harness run files. */
  maxRuns: 200,
});

/** Where the pack puts worktrees: inside the project, so the path guard judges them. */
export const WORKTREE_FOLDER = '.diomedes-worktrees';
export const MAX_WORKTREES = 16;

/** Bounds on repository context offered to a message. */
export const CONTEXT_LIMITS = Object.freeze({
  /** A diff offered as message text goes whole or not at all. */
  maxDiffBytes: 48 * 1024,
});

// --- commands ---------------------------------------------------------------------

/**
 * One word of a command. Letters, digits and `_ @ + = : , . / -` only: enough
 * for `npm test`, `npx vitest run --reporter=dot`, `./gradlew build` or
 * `node scripts/check.js`, and nothing a shell would expand, join, redirect,
 * substitute or glob.
 */
const PLAIN_WORD = /^[A-Za-z0-9_@+=:,./-]+$/;
/** Programs that are shells, or that run their arguments as another program under a different authority. */
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'env',
  'sudo',
  'doas',
  'su',
  'runas',
  'xargs',
  'eval',
  'exec',
  'start',
]);

export type CommandRefusal =
  | 'command_empty'
  | 'command_too_long'
  | 'command_shell_refused'
  | 'command_shell_program';

export type ParsedCommand =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly code: CommandRefusal; readonly message: string };

/**
 * Split a declared command into argv, or refuse it with a reason a person reads.
 * Never quotes, escapes or rewrites anything: what runs is exactly these words.
 */
export function parseCommandLine(text: unknown): ParsedCommand {
  if (typeof text !== 'string' || !text.trim())
    return { ok: false, code: 'command_empty', message: 'Write the command to run, such as npm test.' };
  if (text.length > COMMAND_LIMITS.maxLength)
    return {
      ok: false,
      code: 'command_too_long',
      message: `A command is at most ${COMMAND_LIMITS.maxLength} characters.`,
    };
  const argv = text.trim().split(/ +/);
  if (argv.length > COMMAND_LIMITS.maxWords)
    return { ok: false, code: 'command_too_long', message: `A command is at most ${COMMAND_LIMITS.maxWords} words.` };
  const bad = argv.find((word) => !PLAIN_WORD.test(word));
  if (bad !== undefined)
    return {
      ok: false,
      code: 'command_shell_refused',
      message: `“${bad.slice(0, 40)}” has a character a shell would interpret. Diomedes runs commands as plain words without a shell, so it cannot run this one.`,
    };
  const program = argv[0]!.toLowerCase().split('/').at(-1)!;
  if (SHELLS.has(program))
    return {
      ok: false,
      code: 'command_shell_program',
      message: `${argv[0]} runs other commands as a shell would. Declare the command it runs instead.`,
    };
  return { ok: true, argv };
}

/** The same command however it was spaced, for matching a declared check to a run. */
export const normalCommand = (text: string) => text.trim().split(/ +/).join(' ');

export type CommandKind = 'test' | 'build' | 'check';

/** A command the person declared for this project. Declaring it runs nothing. */
export interface DeclaredCommand {
  /** Stable from the words: the same command keeps its id. */
  readonly id: string;
  readonly label: string;
  readonly kind: CommandKind;
  /** Exactly what was declared, single-spaced. */
  readonly command: string;
  readonly argv: readonly string[];
  /** The folder it runs in, relative to the project; `''` is the project folder. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly declaredAt: string;
  readonly declaredBy: 'you';
}

/** A declared command offered to run, and where the declaration came from. */
export interface RunnableCommand {
  readonly id: string;
  readonly label: string;
  readonly kind: CommandKind;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** `project`: declared for the project here. `acceptance`: a task's H17 command check. */
  readonly source: 'project' | 'acceptance';
  /** The argv, or why it cannot run. */
  readonly parsed: ParsedCommand;
  /** Whether a run of exactly this command in this folder has ever been approved here. */
  readonly approvedBefore: boolean;
}

export type CommandRunState =
  | 'waiting-approval'
  | 'running'
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'output-capped'
  | 'declined'
  | 'error'
  | 'uncertain';

/**
 * What the repository looked like when a command ran, so a result can later be
 * matched against the bytes it judged. Null fields mean the folder is not a
 * repository or the state was too large to fingerprint.
 */
export interface RepositoryFingerprint {
  readonly head: string | null;
  /** sha-256 of the porcelain status and the full diff against HEAD. */
  readonly digest: string | null;
}

/** One request to run one declared command, from approval to outcome. Appended, then settled once. */
export interface CommandRunRecord {
  readonly id: string;
  readonly commandId: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** The harness run that carries the intent, the approval and the effect record. */
  readonly runId: string;
  /** The exact intent the approval binds. */
  readonly intentHash: string;
  state: CommandRunState;
  readonly requestedAt: string;
  decidedAt: string | null;
  decidedBy: 'you' | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  /** The end of each stream, never more than `COMMAND_LIMITS.tailBytes`. */
  stdoutTail: string;
  stderrTail: string;
  /** The repository before the command ran. */
  fingerprint: RepositoryFingerprint | null;
  /** The newest History entry when it ran; a later recorded write makes the result stale. */
  historyMark: string | null;
  detail: string;
}

/** A worktree the pack made for a Task. Removal is recorded, never erased. */
export interface WorktreeRecord {
  readonly id: string;
  /** Folder name under `WORKTREE_FOLDER`. */
  readonly name: string;
  readonly branch: string;
  /** Project-relative. */
  readonly path: string;
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly createRunId: string;
  removedAt: string | null;
  removeRunId: string | null;
}

export type WorktreeOperation = 'add' | 'remove';

/** A worktree change waiting for its approval, or settled. */
export interface WorktreeRequest {
  readonly id: string;
  readonly operation: WorktreeOperation;
  readonly name: string;
  readonly branch: string;
  readonly path: string;
  readonly taskId: string | null;
  readonly runId: string;
  readonly intentHash: string;
  state: 'waiting-approval' | 'running' | 'done' | 'refused' | 'declined' | 'error' | 'uncertain';
  readonly requestedAt: string;
  decidedAt: string | null;
  endedAt: string | null;
  detail: string;
}

/** What the pack keeps on the project. Absent until the pack first records something. */
export interface SoftwarePackRecord {
  readonly v: 1;
  commands: DeclaredCommand[];
  runs: CommandRunRecord[];
  worktrees: WorktreeRecord[];
  worktreeRequests: WorktreeRequest[];
}

export const emptySoftwarePackRecord = (): SoftwarePackRecord => ({
  v: 1,
  commands: [],
  runs: [],
  worktrees: [],
  worktreeRequests: [],
});

// --- repository view --------------------------------------------------------------

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'type-changed';

export interface ChangedFile {
  readonly path: string;
  /** For a rename or copy, where it came from. */
  readonly from: string | null;
  readonly kind: ChangeKind;
  /** Staged in the index. */
  readonly staged: boolean;
  /** Changed in the working folder beyond the index. */
  readonly unstaged: boolean;
}

export interface CommitSummary {
  readonly sha: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export type RepositoryState = 'repository' | 'not-a-repository' | 'git-unavailable' | 'unreadable';

export interface RepositoryView {
  readonly state: RepositoryState;
  /** One plain sentence for every state but `repository`. */
  readonly detail: string | null;
  readonly branch: string | null;
  /** True when HEAD names a commit, not a branch. */
  readonly detached: boolean;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly changes: readonly ChangedFile[];
  /** Changed files not listed: past the limit. */
  readonly moreChanges: number;
  /** Changed files not listed because the path guard keeps their names private. */
  readonly privateChanges: number;
  readonly commits: readonly CommitSummary[];
  readonly readAt: string;
}

export const notRepository = (
  state: Exclude<RepositoryState, 'repository'>,
  detail: string,
  readAt: string,
): RepositoryView => ({
  state,
  detail,
  branch: null,
  detached: false,
  head: null,
  upstream: null,
  ahead: null,
  behind: null,
  changes: [],
  moreChanges: 0,
  privateChanges: 0,
  commits: [],
  readAt,
});

/** Everything the Console's Repository section shows, read from the records. */
export interface SoftwarePackView {
  readonly active: true;
  readonly repository: RepositoryView;
  readonly commands: readonly RunnableCommand[];
  readonly runs: readonly CommandRunRecord[];
  readonly worktrees: readonly WorktreeRecord[];
  readonly worktreeRequests: readonly WorktreeRequest[];
  /** What the writes need, as requests. Trust decides at use. */
  readonly requests: readonly { readonly capability: string; readonly reason: string }[];
}

/** The writes this slice asks for. Declared, never granted: each one waits for an exact approval. */
export const SOFTWARE_PACK_REQUESTS = Object.freeze([
  {
    capability: 'read-project-files',
    reason: 'To read the repository’s branch, changed files and recent commits with git.',
  },
  {
    capability: 'write-project-file',
    reason: `To add or remove a worktree under ${WORKTREE_FOLDER}, and to run a command you declared. Each one asks first.`,
  },
]);

/** A folder name git and every filesystem accept, and that names nothing guarded. */
export const WORKTREE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A branch name this slice creates: plain, never an option or a ref path trick. */
export const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
export function branchProblem(branch: string): string | null {
  if (!BRANCH_NAME.test(branch)) return 'A branch name is letters, digits, dots, dashes, underscores and slashes.';
  if (/\.\.|\/\/|\/$|\.lock$|\.$|@\{/.test(branch) || branch.split('/').some((part) => part.startsWith('.')))
    return 'That branch name is not one git accepts.';
  return null;
}
