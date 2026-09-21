/**
 * Worktree sweep — report what every feature worktree is, and remove only the
 * ones whose work is provably on `origin/main`.
 *
 * This exists because 180 worktrees accumulated: every lane created one and
 * none removed it. The rule in AGENTS.md is that a lane removes its own
 * worktree when its pull request merges; this is the weekly backstop for the
 * ones that did not.
 *
 * Removal is deliberately narrow. A worktree is removed only when it is clean
 * and its HEAD is an ancestor of `origin/main` — then the checkout is the only
 * thing that disappears, because every commit is already on the branch nobody
 * can lose. Anything else is reported and left alone: uncommitted work, a
 * branch with commits of its own, a worktree another agent holds a
 * coordination claim on, and the main checkout itself.
 *
 * ## The junction hazard
 *
 * Worktrees here junction `node_modules` (and `services/control-plane/
 * node_modules`) to the main checkout's, and Playwright plants more under
 * `test-results/`. `git worktree remove --force` FOLLOWS a junction and
 * deletes through it — measured on 2026-09-20, where it destroyed a scratch
 * target's contents; pwsh's `Remove-Item -Recurse` does not. One `git worktree
 * remove` against an attached junction would therefore empty the shared
 * install for every other worktree at once.
 *
 * So every reparse point is detached first — `fs.rmdir` on a junction removes
 * the link and never the target — and the shared install is re-checked after
 * each removal. The first failed check aborts the run rather than continuing.
 *
 * Usage:
 *   npx tsx scripts/worktree-sweep.ts          # report only, changes nothing
 *   npx tsx scripts/worktree-sweep.ts --sweep  # also remove the landed ones
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
})
  .trim()
  .replace(/\/\.git$/, '');
const MAIN_CHECKOUT = path.resolve(REPO);
/** A file that exists in the shared install and must survive every removal. */
const CANARY = path.join(MAIN_CHECKOUT, 'node_modules', 'vitest');
const SWEEP = process.argv.includes('--sweep');

const git = (args: string[], cwd = MAIN_CHECKOUT): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const tryGit = (args: string[], cwd = MAIN_CHECKOUT): string | null => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};

interface Worktree {
  readonly dir: string;
  readonly branch: string | null;
  readonly head: string;
  /** `git worktree lock`'s reason, or null. A lock is an explicit "leave this". */
  readonly locked: string | null;
}

function listWorktrees(): Worktree[] {
  const out: Worktree[] = [];
  let dir = '';
  let branch: string | null = null;
  let head = '';
  let locked: string | null = null;
  const flush = (): void => {
    if (dir) out.push({ dir, branch, head, locked });
    dir = '';
    branch = null;
    head = '';
    locked = null;
  };
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9).trim();
    else if (line.startsWith('HEAD ')) head = line.slice(5).trim();
    else if (line.startsWith('branch ')) branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'locked' || line.startsWith('locked ')) locked = line.slice(7).trim() || '(no reason given)';
    else if (line.trim() === '') flush();
  }
  flush();
  return out;
}

/**
 * Worktrees another agent is actively holding, from the coordination
 * directory's unreleased claims. A claim whose owner process is gone is stale
 * and does not protect anything; one whose owner is alive does.
 */
function claimedWorktrees(): Set<string> {
  const held = new Set<string>();
  const root = path.join(REPO, '.git', 'diomedes-coordination');
  if (!fs.existsSync(root)) return held;
  for (const program of fs.readdirSync(root)) {
    const claims = path.join(root, program, 'claims');
    if (!fs.existsSync(claims)) continue;
    for (const name of fs.readdirSync(claims)) {
      if (!name.endsWith('.json') || name.endsWith('.released.json')) continue;
      if (fs.existsSync(path.join(claims, name.replace(/\.json$/, '.released.json')))) continue;
      try {
        const claim = JSON.parse(fs.readFileSync(path.join(claims, name), 'utf8')) as {
          owner?: { pid?: number; worktree?: string };
        };
        const pid = claim.owner?.pid;
        const wt = claim.owner?.worktree;
        if (!pid || !wt) continue;
        try {
          process.kill(pid, 0); // Signal 0 only tests for the process.
          held.add(path.resolve(wt).toLowerCase());
        } catch {
          /* the owner is gone; the claim is stale and protects nothing */
        }
      } catch {
        /* an unreadable claim is not a grant */
      }
    }
  }
  return held;
}

/** Detach every reparse point under a worktree. Never touches a target. */
function detachLinks(root: string): number {
  let detached = 0;
  const unlink = (p: string): void => {
    try {
      if (fs.lstatSync(p).isSymbolicLink() || (fs.lstatSync(p).mode & 0) !== 0) {
        /* fall through to the rmdir below */
      }
    } catch {
      return;
    }
    try {
      fs.rmdirSync(p); // On a junction this removes the link only.
      detached += 1;
    } catch {
      /* not a link, or not empty — leave it for the recursive walk */
    }
  };
  for (const rel of ['node_modules', path.join('services', 'control-plane', 'node_modules')]) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    try {
      if (fs.lstatSync(p).isSymbolicLink()) unlink(p);
    } catch {
      /* unreadable */
    }
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        unlink(p);
        continue; // Never descend through a link.
      }
      if (entry.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return detached;
}

function assertSharedInstallIntact(): void {
  if (!fs.existsSync(CANARY))
    throw new Error(
      `ABORT: ${CANARY} is gone — a removal deleted through a junction. Stop and restore it.`,
    );
}

const held = claimedWorktrees();
const worktrees = listWorktrees();
const mainSha = git(['rev-parse', 'origin/main']);

const landed: Worktree[] = [];
const keep: { wt: Worktree; why: string }[] = [];

for (const wt of worktrees) {
  if (path.resolve(wt.dir).toLowerCase() === MAIN_CHECKOUT.toLowerCase()) {
    keep.push({ wt, why: 'the main checkout' });
    continue;
  }
  if (!fs.existsSync(wt.dir)) {
    keep.push({ wt, why: 'directory is gone — run `git worktree prune`' });
    continue;
  }
  if (wt.locked !== null) {
    keep.push({ wt, why: `locked: ${wt.locked}` });
    continue;
  }
  if (held.has(path.resolve(wt.dir).toLowerCase())) {
    keep.push({ wt, why: 'a live agent holds a coordination claim on it' });
    continue;
  }
  const dirty = (tryGit(['status', '--porcelain'], wt.dir) ?? 'unreadable').split('\n').filter(Boolean);
  if (dirty.length > 0) {
    keep.push({ wt, why: `${String(dirty.length)} uncommitted change(s)` });
    continue;
  }
  const isLanded = tryGit(['merge-base', '--is-ancestor', wt.head, mainSha]) !== null;
  if (!isLanded) {
    const ahead = tryGit(['rev-list', '--count', `${mainSha}..${wt.head}`]) ?? '?';
    keep.push({ wt, why: `${ahead} commit(s) not on origin/main` });
    continue;
  }
  landed.push(wt);
}

console.log(`${String(worktrees.length)} worktrees against origin/main ${mainSha.slice(0, 8)}\n`);
console.log(`landed, removable : ${String(landed.length)}`);
for (const wt of landed) console.log(`  ${wt.branch ?? '(detached)'}  ${wt.dir}`);
console.log(`\nkept              : ${String(keep.length)}`);
for (const { wt, why } of keep) console.log(`  ${(wt.branch ?? '(detached)').padEnd(52)} ${why}`);

if (!SWEEP) {
  console.log('\nReport only. Pass --sweep to remove the landed ones.');
  process.exit(0);
}

assertSharedInstallIntact();
let removed = 0;
for (const wt of landed) {
  detachLinks(wt.dir);
  const nm = path.join(wt.dir, 'node_modules');
  if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink())
    throw new Error(`ABORT: ${nm} is still a link after detaching. Not running git against it.`);
  assertSharedInstallIntact();
  git(['worktree', 'remove', '--force', wt.dir]);
  assertSharedInstallIntact();
  if (wt.branch) tryGit(['branch', '-d', wt.branch]); // -d, never -D: refuses unmerged.
  removed += 1;
}
git(['worktree', 'prune']);
assertSharedInstallIntact();
console.log(`\nremoved ${String(removed)}; shared install intact.`);
