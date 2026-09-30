# Change review for projects inside a repository

Prompt 26, branch `feature/change-review-subfolder`, based on
`af0fbec122e49f04895ea85137e5be0fc500685a`.

Status as of 2026-09-28: local regression and removal-mutation checks completed.
The integration owner's independent review found no concrete defect in the
scoped source fix. Full-project TypeScript and exact-main composition/acceptance
remain pending. This prompt is not DONE, merged or deployed.

Tested source: `20dd4ac9c25ae09f8ee4853c8cc4227797e51e68`.
Baseline test/docs checkpoint: `a351355fb83d0700da091bef6ce10c15dbf32722`.
This later documentation update does not change production code or tests.

## Problem and boundary

Git status and content hashing use paths relative to the repository root.
Recorded writes, folder observations, and the contained text reader use paths
relative to the project. For a project at `repo/apps/project`, these name the
same edit as `apps/project/notes.txt` and `notes.txt`. Before the correction, the
review's claimed-path set missed the duplicate. Its text reader also looked for
the Git entry under `repo/apps/project/apps/project/notes.txt`.

The correction runs after Git's content hashing and snapshot comparison.
Persisted Git baselines, status digests, blob hashes, entry IDs and Git evidence
pointers keep their repository-relative meaning. Display paths and rename
labels become project-relative before deduplication and text prefetch. A literal
complete-directory prefix excludes sibling paths; three-argument callers retain
their repository-relative output. Git baseline lookup converts the displayed
path back to the repository path, including after a service restart. The
ordinary contained reader still decides whether a file may be read.

No Store, route, admission, Board, session, shared contract, or canonical
document changes are part of this lane. Lazy loading belongs to prompt 21 and
is deferred. No historical terminal manifest is rewritten by this change.

## Verification status

Regression fixtures are in `tests/change-review-subfolder.test.ts`.
They exercise the public review service over real temporary Git repositories
and Store records, with no provider or account calls. They cover one recorded
edit, one outside edit, Git-only text, a literal glob-like project folder, a
root project, a persisted dirty baseline, and a rename.

| Check | Exact source | Executed result | Evidence owner |
| --- | --- | --- | --- |
| Baseline regression | `a351355f` | 7 failed, 1 passed, 0 skipped; exit 1. All failures were expected product assertions. | Source lane |
| Focused regression | `20dd4ac9` | 8 passed, 0 failed, 0 skipped; exit 0. | Source lane |
| Targeted TypeScript | `20dd4ac9` | Exit 0 after installing the already-declared control-plane dependencies. | Integration owner; original records inspected by source lane |
| Covering Change Review regressions | `20dd4ac9` | 3 files and 72 cases passed, 0 failed, 0 skipped; exit 0. | Integration owner; original records inspected by source lane |
| Four removal-mutation pairs | `20dd4ac9`, with one temporary removal at a time | Each red: 1 failed, 7 skipped, exit 1. Each restored green: 1 passed, 7 skipped, exit 0. | Source lane |

The suites overlap; these counts are not additive. Each mutation selected one
case, so its seven filtered cases are skipped, not passed. All four removals
failed on the intended assertion:

- Removing the service subdirectory argument produced two entries instead of one.
- Removing the prefix filter allowed the sibling entry through.
- Removing rename-label projection retained `apps/project/` in `renamedFrom`.
- Removing the repository-key baseline lookup produced an excerpt instead of
  the staged before-text diff after restart.

Every mutation was restored byte for byte before its green. All seven frozen
file hashes and clean status were confirmed at the end; no mutation was staged
or committed. This later documentation update intentionally changes only this
record. The original seven-file snapshots continue to bind the tested source
commit, while production, tests and package files retain their verified bytes.

The targeted TypeScript check uses
`node_modules/.cache/change-review-subfolder/tsconfig.json`, which inherits the
root compiler settings and selects the two production files and three covering
test files, plus their imports. It is not the full-project TypeScript gate.

The covering command was:

```powershell
& './node_modules/.bin/vitest.cmd' run tests/change-review.test.ts tests/change-review-git.test.ts tests/change-review-subfolder.test.ts --maxWorkers=1 --minWorkers=1 --reporter=verbose
```

Setup failures remain recorded: the first targeted compiler attempt lacked the
declared Neon package and exited 2; a mutation helper's first ownership check
rejected a timestamp representation before Vitest ran. The dependency install
and parsed-instant comparison corrected those setup issues. Neither was counted
as a killed mutation or a passing test. All acquired verification slots were
released.

## Evidence and review

- [Baseline log](F:/Temp/andre/astra-change-review-subfolder/red-a351355f/vitest-red.log).
- [Focused-green checkpoint and artifact hashes](F:/Temp/andre/astra-change-review-subfolder/green-20dd4ac9/checkpoint.json).
- [Targeted compiler result](F:/Temp/andre/astra-change-review-subfolder/covering-20dd4ac9-20260928/targeted-tsc-after-install-result.json) and [covering result](F:/Temp/andre/astra-change-review-subfolder/covering-20dd4ac9-20260928/covering-vitest-result.json).
- [Mutation results with original logs/exits](F:/Temp/andre/astra-change-review-subfolder/mutations-20dd4ac9-20260928/mutation-results.json) and [63-file evidence hash manifest](F:/Temp/andre/astra-change-review-subfolder/mutations-20dd4ac9-20260928/artifact-sha256.json).
- [Complete lane report](F:/Diomedes/deliverables/astra-week-20260927/reports/change-review-subfolder.md), including commit, file-hash and slot records.

The integration owner independently reviewed clean source `20dd4ac9`, the eight
regression cases, project pathspec and baseline lookup, the 72-case covering
result, and all four red/restored-green pairs. It reported no concrete source
defect in this scoped fix. This review does not establish acceptance of a later
composition with main.

## Remaining acceptance and risks

Full-project `tsc --noEmit` remains unrun for this lane. The local main reference
was `1af37e085ef24fc6c92d6b2b8510fc52a504bd1b` when this record was updated;
the tested feature source still has its older base. The integration owner must
compose the accepted source onto current main and complete the required checks
and final acceptance for that exact candidate. Main drift and interaction with
other changes therefore remain the acceptance risk; no concrete defect was
found in the scoped review.

No tests or builds were rerun for this documentation-only correction, no slot
was acquired, and no push or merge occurred. Source/report claims and the
feature worktree lock remain held for the integration handoff.

Canonical documents read from this worktree: Core Pillars `2026-09-27.1`, live
roadmap `2026-09-25.2`, project memory `2026-09-25.2`, standing decisions,
QUESTIONS and the harness change/verification records. No product definition
changes. Roadmap and package completion status remain unchanged pending
exact-main acceptance and integration. No build, publication or deployment claim.
