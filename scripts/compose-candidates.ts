#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Compose finished candidate branches onto a staging branch, gate the result and
 * report. Nothing here lands anything.
 *
 *   tsx scripts/compose-candidates.ts --branches a,b --role fable --pid 1234 --start <ISO>
 *
 * Two candidates can each be finished, each gate green on their own base, and
 * still not compose: they are only ever tested apart. Finding that out by hand
 * costs a worktree, a merge and a full suite every time, so it is usually
 * skipped until the merge to main is already underway. This does that work in a
 * disposable worktree and answers one question: do these branches compose onto
 * today's main, and do the gates pass on the result.
 *
 * What it deliberately does not do:
 * - It never reads a verdict record to decide what to compose. In this
 *   repository "accepted" and "authorized to land" are separate facts, and
 *   several accepted candidates carry merge_authorized: false. Branches are
 *   named explicitly by the caller.
 * - It never checks out, merges into, or pushes main, and it never pushes
 *   anything at all. A green report is evidence for a human decision, not the
 *   decision. Landing stays a person's call, made with the report in hand.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

if (has('help') || argv.length === 0) {
  process.stdout.write(
    `usage: tsx scripts/compose-candidates.ts --branches a,b [options]\n` +
      `  --onto REF        base to compose onto (default origin/main)\n` +
      `  --worktree DIR    where to build the composition (default a sibling of this checkout)\n` +
      `  --role/--pid/--start   identity for the heavy slot, passed to scripts/gates.ts\n` +
      `  --with a,b        extra gates (responsive, connections)\n` +
      `  --no-gates        compose and report conflicts only\n` +
      `  --keep            leave the worktree in place on success\n` +
      `  --report FILE     where to write the JSON report\n`,
  );
  process.exit(0);
}

const branches = (flag('branches') ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
if (!branches.length) {
  process.stderr.write('--branches is required.\n');
  process.exit(2);
}
const onto = flag('onto') ?? 'origin/main';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], cwd = root): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const git = (args: readonly string[], cwd = root) => run('git', args, cwd);
const gitOut = async (args: readonly string[], cwd = root) => (await git(args, cwd)).stdout.trim();

const say = (message: string) => process.stdout.write(`[compose] ${message}\n`);

async function main() {
  // Resolve every input before anything is created, so a typo fails immediately.
  const baseSha = await gitOut(['rev-parse', `${onto}^{commit}`]);
  if (!baseSha) throw new Error(`${onto} does not resolve to a commit.`);
  const resolved: { branch: string; sha: string }[] = [];
  for (const branch of branches) {
    const sha = await gitOut(['rev-parse', `${branch}^{commit}`]);
    if (!sha) throw new Error(`${branch} does not resolve to a commit.`);
    resolved.push({ branch, sha });
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const stagingBranch = `staging/compose-${stamp}`;
  const worktree = path.resolve(
    flag('worktree') ?? path.join(root, '..', `compose-${stamp}`),
  );
  // A composition that could write to main would defeat the point of the tool.
  const currentBranch = await gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (stagingBranch === 'main' || currentBranch === stagingBranch)
    throw new Error('The staging branch must not be main or the current branch.');

  say(`base ${onto} = ${baseSha.slice(0, 7)}`);
  for (const entry of resolved) say(`candidate ${entry.branch} = ${entry.sha.slice(0, 7)}`);
  say(`staging branch ${stagingBranch} in ${worktree}`);

  const add = await git(['worktree', 'add', '-b', stagingBranch, worktree, baseSha]);
  if (add.code !== 0) throw new Error(`Could not create the worktree:\n${add.stderr}`);

  const report = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/compose-candidates.ts',
    onto,
    baseCommit: baseSha,
    stagingBranch,
    worktree,
    candidates: [] as {
      branch: string;
      commit: string;
      merged: boolean;
      conflicts: string[];
      detail: string;
    }[],
    composed: false,
    gates: null as null | { ran: boolean; passed: boolean; summary: string },
    // Said in the artefact as well as the code, because the report is what
    // travels: a person reads this, not this file.
    authorization:
      'This report is evidence, not permission. Composing and gating a staging branch ' +
      'authorizes nothing: landing on main remains a human decision, taken per patch.',
  };

  let composed = true;
  for (const entry of resolved) {
    const merge = await git(
      ['merge', '--no-ff', '-m', `compose: ${entry.branch}`, entry.sha],
      worktree,
    );
    if (merge.code === 0) {
      say(`merged ${entry.branch}`);
      report.candidates.push({
        branch: entry.branch,
        commit: entry.sha,
        merged: true,
        conflicts: [],
        detail: 'merged cleanly',
      });
      continue;
    }
    // Name the conflicting paths, then put the tree back so the next candidate
    // is still measured against a clean base rather than a half-merged one.
    const conflicts = (await gitOut(['diff', '--name-only', '--diff-filter=U'], worktree))
      .split(/\r?\n/)
      .filter(Boolean);
    await git(['merge', '--abort'], worktree);
    say(`CONFLICT merging ${entry.branch}: ${conflicts.join(', ') || 'see detail'}`);
    report.candidates.push({
      branch: entry.branch,
      commit: entry.sha,
      merged: false,
      conflicts,
      detail: (merge.stdout + merge.stderr).trim().split(/\r?\n/).slice(0, 12).join('\n'),
    });
    composed = false;
  }
  report.composed = composed;

  if (composed && !has('no-gates')) {
    // The gates need this checkout's installed dependencies; a fresh worktree
    // has none, and installing a second copy would be both slow and a different
    // dependency tree from the one the candidate was tested against.
    const link = path.join(worktree, 'node_modules');
    try {
      await fs.symlink(
        path.join(root, 'node_modules'),
        link,
        os.platform() === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }
    say('running the gates on the composition');
    const identity: string[] = [];
    for (const name of ['role', 'pid', 'start', 'host'])
      if (flag(name) !== undefined) identity.push(`--${name}`, flag(name) as string);
    const withGates = flag('with');
    const gates = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(worktree, 'scripts', 'gates.ts'),
        ...identity,
        '--node',
        'COMPOSE',
        '--purpose',
        `Gates on composed ${branches.join(' + ')}`,
        ...(withGates ? ['--with', withGates] : []),
      ],
      worktree,
    );
    const summary = (gates.stdout + gates.stderr)
      .split(/\r?\n/)
      .filter((line) => /^\s{2}(PASS|FAIL|SKIP)\s/.test(line))
      .join('\n');
    report.gates = { ran: true, passed: gates.code === 0, summary: summary || '(no gate summary)' };
    say(gates.code === 0 ? 'gates passed on the composition' : 'gates FAILED on the composition');
  } else if (composed) {
    report.gates = { ran: false, passed: false, summary: 'skipped (--no-gates)' };
  }

  const reportPath = path.resolve(
    flag('report') ?? path.join(root, 'test-results', `compose-${stamp}.json`),
  );
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const green = report.composed && report.gates?.passed === true;
  process.stdout.write(`\n[compose] ===== summary =====\n`);
  for (const entry of report.candidates)
    process.stdout.write(
      `  ${entry.merged ? 'MERGED  ' : 'CONFLICT'}  ${entry.branch}${
        entry.conflicts.length ? `  (${entry.conflicts.join(', ')})` : ''
      }\n`,
    );
  if (report.gates?.ran) process.stdout.write(`${report.gates.summary}\n`);
  process.stdout.write(`  report: ${reportPath}\n`);
  process.stdout.write(`  staging branch: ${stagingBranch} (${worktree})\n`);
  process.stdout.write(
    `\n[compose] ${green ? 'COMPOSES AND GATES GREEN' : 'NOT READY'} — ${report.authorization}\n`,
  );

  if (green && !has('keep')) {
    say('removing the worktree; the staging branch is kept for inspection.');
    await git(['worktree', 'remove', '--force', worktree]);
  }
  process.exitCode = green ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`\n[compose] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
