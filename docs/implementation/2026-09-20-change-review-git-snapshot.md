# Change review's Git snapshot: whose end-of-line view, and whose repository

`docs/implementation/2026-09-20-test-teardown-capture.md` measured the cost of
change review's Git snapshot on Windows and left two questions open: whether the
cost was only a clock cost, and whether the subject should be the project folder
rather than the repository enclosing it. Both are answered here, and both are
fixed in `server/change-review/git.ts`. Nothing in `server/change-review/service.ts`
changed; the three-snapshots-per-run shape is left alone, for the reason below.

## The noise reaches the manifest, not only the clock

It does, and the shape is worse than a false positive.

Git compares content only for index entries whose recorded stat data it cannot
vouch for — a fresh checkout, a branch switch, anything a build touched. Change
review's environment set `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=NUL`,
which hide Git for Windows' system default `core.autocrlf=true`, and then forced
`core.autocrlf=false` outright. Every CRLF working file therefore compared
unequal to its LF blob, and every stat-stale entry read as modified. Because
`GIT_OPTIONAL_LOCKS=0` means the refreshed index is never written back, the state
persisted; one ordinary `git status` ended it, because that writes the index.

So the two ends of a run could see different worlds. Reproduced directly, in a
repository with `core.autocrlf true`, one committed CRLF file, and one `utimes`
call that changed no byte:

```
baseline (stat-stale)                  notes.txt  x=.  y=M  blob=17f2fc0a
the person's own `git status`          (clean)
build (after that status refreshed)    (no rows)

diffGitSnapshots(baseline, build)      1 entry
  notes.txt  kind=modified  beforeSha=17f2fc0a  afterSha=null
             evidence=status:.M->clean
  beforeSha 17f2fc0a names NO object in the repository
```

That entry is produced by the second loop of `diffGitSnapshots`, the one that
reports paths dirty at baseline and clean now as work committed or reverted
mid-run. A file nobody opened is reported as modified-and-then-cleaned, and its
recorded before-sha is the hash of the CRLF bytes — an object that was never
written to the repository, so nothing can be shown for it. It reaches a manifest
entry and a ledger row, not just the duration.

`tests/change-review-git.test.ts` pins this: *a file nobody edited is never
reported, however stale its stat data*.

## Forcing `core.autocrlf=false` was not load-bearing

Recorded shas do not depend on it. `git hash-object --no-filters` hashes the
bytes on disk and nothing else, which the second test asserts directly against a
sha1 computed in Node over `blob <len>\0` plus the file's bytes. Binary
classification does not depend on it either: numstat's verdict is content-level
and the fallback is a NUL probe.

The override can therefore go, and the person's own `core.autocrlf` and
`core.eol` are read and passed through instead, so "modified" means in a review
what it means in their shell. They are read with `git config --get`, which runs
no hook, no filter and no external program.

This widens nothing. The suppression never hid the *repository*; it only hid the
*person*. Checked rather than assumed: with nothing passed through, a repository
whose own `.git/config` sets `core.autocrlf=true` is still honoured by the
inspection environment, because `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL`
name the system and global files and there is no third variable for the
repository's own. A repository could already steer content comparison before
this change. The execution hooks that matter — `core.hooksPath`,
`core.fsmonitor`, `core.untrackedCache`, `diff.external` — stay pinned off, and
they win over every config file because `GIT_CONFIG_*` takes precedence.

The residual documented in the source is unchanged: `status`/`diff` may still
consult a repository's `filter.*.clean` for content comparison. That was true
before and is true now; only `hash-object --no-filters` is guaranteed free of it.

## The subject is now the project folder

`prepareGit` resolved `git rev-parse --show-toplevel`, so a project in one
directory of a monorepo made the whole monorepo the subject. It now also reads
`git rev-parse --show-prefix` — Git's own answer to where the folder sits inside
the repository, so no path arithmetic is done and a short-name alias, a symlink
or a case-different spelling cannot skew it — and bounds `status` and both
numstat diffs with `:(top,literal)<subdir>`. `top` anchors the pathspec at the
repository root whatever the working directory is; `literal` keeps a folder
named like a glob from matching its neighbours, which the `app[1]` test pins.

A project that *is* the repository root is unaffected: the prefix is empty, no
pathspec is added, and the whole repository is still the subject.

## Measured

One real checkout, identical bytes, identical stat state, `origin/main`'s
behaviour reproduced by overriding only the two fields this change introduces.
The machine's `core.autocrlf` is `true` (Git for Windows' system default).

Project = the repository root, freshly added worktree, 1,278 tracked files:

| | rows | per snapshot |
|---|---|---|
| `origin/main` | 242 | 4,798 ms |
| this change | 0 | 324 ms |
| ordinary `git status` | 0 | — |
| either, once the index is refreshed | 0 | ~170 ms |

Project = `server/` of the same checkout, every tracked file's stat data stale:

| | rows | per snapshot |
|---|---|---|
| `origin/main` (forced eol, whole repository) | 1,036 | 15,152 ms |
| subject bounded to the project | 142 | 1,781 ms |
| and the person's own end-of-line view | 0 | 182 ms |

Ordinary Git reports no changes in every one of those states, which is now what
change review reports too.

## Three snapshots per run

Left as it is. The shape belongs to `service.ts` — one baseline during the run
and two more drained inside `app.locals.close()`, built from the session's own
change events — and that file is the change-review-ended-sessions lane's. At 182
ms a snapshot the question stops paying: three snapshots of a stale 1,278-file
subdirectory project cost about half a second, against roughly forty-five
seconds before. If it is revisited later, the lever to measure first is that
`snapshotGit` re-copies the real index on every call and so discards any refresh
it might have inherited; the private index could be re-copied only when the real
one's mtime or size moves.

## Left open

Git entry paths are repository-relative and folder-source entry paths are
project-relative. For a project at the repository root they agree, which is why
this has not bitten; for a project below it they never match, so `build`'s
`claimed` set does not deduplicate and one edited file is reported twice — once
as `a.txt` from the folder source and once as `apps/proj/a.txt` from Git.
Confirmed directly against both sources. Bounding the subject makes subdirectory
projects usable and therefore makes this reachable, so it is worth closing; it
changes entry identity in the manifest, so it belongs with whoever holds
`service.ts` rather than here.

Baselines already persisted under the old code keep their phantom rows. A
session still `waiting` when the application updates rebuilds under this change
and will report every one of them as `status:.M->clean`, and a large enough set
would reach `CHANGE_CAP`. This is not new behaviour — the same rebuild happened
before the fix the moment anything refreshed the index — but it is the one way
this change can make an existing record read differently, so it is worth
expecting rather than discovering.

A narrow disagreement survives. `GIT_CONFIG_GLOBAL=NUL` also hides a custom
`core.attributesFile`; the default global attributes file is still read, so only
someone who pointed that setting elsewhere, at a file carrying something like
`* text=auto`, still sees a view change review does not share.

Not established: whether any released manifest actually carries phantom entries
from this. The defect is demonstrated on a constructed repository, and the
conditions for it — Windows, `autocrlf=true`, a stat-stale checkout at baseline —
are ordinary, but no stored manifest was audited.

## Evidence

Worktree `F:/Diomedes/diomedes-wt/change-review-git-snapshot`, branch
`feature/change-review-git-snapshot`, from `origin/main` b4eb2c2.

All four gates on this tree, with the heavy-test slot held
(`slot_muaj1zay_39579f3b`, released after).

- **typecheck** — `tsc --noEmit` passes.
- **unit** — 206 of 207 files, 4,007 passed, 1 failed, 1 skipped. The failure is
  `tests/hostile-truth-capability-record.test.ts`, `expected true to be false`
  on `release.appVersionMatchesSource`. It is the known stale release pin and
  not this change: the same test fails the same way on a pristine detached
  `origin/main` checkout with none of these edits applied, which was run
  separately to check rather than assert it.
- **build** — `vite build` passes.
- **browser** — 126 of 126 pass. The suite re-rendered 40 evidence PNGs under
  `evidence/` and `docs/verification/`; all 40 were restored from HEAD, so the
  tree holds only the three files this change owns.

`tests/change-review-git.test.ts` is new and now holds 7 tests. Six were
written before the change and run against it: three passed and three failed, in
exactly the three ways described above — the phantom `status:.M->clean` entry, a
baseline that reported a file nobody had edited, and two out-of-project paths in
a subdirectory project's snapshot. The seventh, the `app[1]` literal-pathspec
guard, was added after the fix and so was never run against the old code; it
guards the pathspec this change introduces rather than evidencing the defect.

`tests/change-review.test.ts` — the existing Git coverage, not edited here
because the change-review-ended-sessions lane holds it — passes unchanged, 52
tests.

Hosted CI has not run. Nothing is committed.
