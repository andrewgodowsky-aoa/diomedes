# Release gate outcomes reach the README

20 September 2026. Branch `feature/release-gate-outcomes`, worktree
`F:/Diomedes/diomedes-wt/release-gate-outcomes`. Written from `origin/main` at
`9ebde6e`, then rebased onto `origin/main` at `b4eb2c2` and gated there.

Closes the open item recorded at
[`2026-09-20-first-run-repair.md`](2026-09-20-first-run-repair.md) §"Known and
deliberately left": *"`scripts/write-candidate-record.ts` does not yet record the
desktop smoke, installer or installed-runtime gates, so the next release README
will print those as not verified until it does."*

## What was wrong

`scripts/write-release-assets.mjs` builds the README's evidence block from
`VERIFIED_CLAIMS`, reading `verification.desktopSmoke`, `verification.installer`
and `verification.installedRuntime` out of the candidate record. Its `claimed()`
helper prints `NOT VERIFIED in this record` for a key that is absent or carries
no readable outcome.

`scripts/write-candidate-record.ts` wrote `verification` with `typecheck`, `unit`
and `browser` and nothing else. Its `--installer` flag writes a **top-level**
`installer` field describing the artifact — filename, bytes, sha256, productId,
appTreeSha256, compiler — which is not a test outcome, and which `outcome()`
correctly reads as nothing, because it carries no `result`, `outcome`, `status`,
`lastRun` or `passed`.

So since the README started reading these gates from the record, it has printed
all three as `NOT VERIFIED` whatever was run. Neither script was wrong on its
own; the defect was in the seam between them.

### Which releases this touched

The brief for this work said 0.1.4 and 0.1.5 understated their verification.
They did not, and it is worth being exact, because the two directions are
different faults. What each published `README.txt` says was read from the local
deliverable and checked against the published asset's SHA-256, which matches for
all three:

| Release | Generator | Its README on the three gates | Published README.txt sha256 |
|---|---|---|---|
| v0.1.4 (`efa83ac`, 19 Sep) | before `f143e9e` | states all three as done, as literals | `ad04261f…83be39` |
| v0.1.5 (`8d7d63b`, 20 Sep 05:59) | before `f143e9e` | states all three as done, as literals | `d03c7df5…66e7f5` |
| v0.1.6 (`4a06a45`, 20 Sep 17:41) | after `f143e9e` | `NOT VERIFIED in this record`, all three | `9a17c184…36e0b0` |

Through 0.1.5 the generator printed "the packaged desktop smoke; the installer's
install, same-version repair and uninstall; the installed runtime" whatever the
record said — the overclaim that audit finding F09 was about. For 0.1.4 it
happened to be true: its installer and installed-runtime proofs are committed
beside its record as `…-efa83acd021c-installer-proof.json` and
`…-efa83acd021c-installer-proof-runtime.json`, though nothing read them. 0.1.5's
record is not in this repository, so nothing here shows what was run for it.

`f143e9e` (20 Sep 08:12, *"Read the release README's claims from the records
instead of stating them"*) fixed the overclaim, which exposed this gap. 0.1.6 is
the only release built since. Its README says all three were not verified, its
record carries none of them and no proof is committed beside it, so it said
nothing false. The fault this change fixes is prospective: without it, a release
that does run all three still cannot say so.

## The decision: one record, one authority

The proofs are merged into the record's `verification` block **at write time**,
not read from sidecars by the asset writer. The asset writer is unchanged. A
release README should have exactly one thing to believe — the candidate record —
and adding a second source that it reads directly would mean two places to keep
honest and two ways for them to disagree.

## What was added

`scripts/write-candidate-record.ts` takes three new flags, each naming one report:

| Flag | Report it reads | Records |
|---|---|---|
| `--desktop-smoke` | `evidence/desktop-proof.json` from `npm run test:desktop` | `verification.desktopSmoke` |
| `--installer-proof` | `proof.json` from `scripts/verify-windows-installer.ps1` | `verification.installer` |
| `--installed-runtime` | `runtime-proof/proof.json` that the installer proof launches | `verification.installedRuntime` |

Each records `{ result: 'passed', report, reportSha256, ranAt }` and, where the
report enumerates them, `checks`. `reportSha256` is what makes the sidecar
copied in beside the record checkable against it afterwards. `report` is a
repository path, or a bare filename when the proof was read from another
worktree: the record is committed, so it never carries one machine's drive.

Note that `verification.installer` is the gate's outcome and the top-level
`installer` stays the artifact description. The two are deliberately different
things; conflating them is how this started.

### What each reader refuses

A named flag is read strictly. A report that is missing, unparseable, missing a
field, recording a failure, or describing bytes other than this build's stops the
record — the same way `--installer` already re-hashes the installer and throws
when the hash disagrees with the manifest. Nothing is ever recorded as a weaker
claim.

- **Desktop smoke.** The four assertions it makes (`rendererNodeDisabled`,
  `serviceStopsOnClose`, `dataLockReleased`, `persistedOnRestart`) must be true
  and `pageErrors` empty; `startup.version` must be this build's. It is tied to
  the bytes only by the proof's own `executableSha256`, which the smoke now takes
  from the executable before its first launch. A proof without one is refused,
  never completed by hashing the path it names: that hash would be taken now, not
  when the smoke ran, and after a same-version rebuild to the same path it would
  find the new bytes, match the record, and pass a smoke that only ran on the old
  ones. So a proof written before this change cannot be recorded; re-run the
  smoke. (The first draft of this change had exactly that fallback. It was taken
  out before it was committed.)
- **Installer proof.** `passed` must be true, and its `installerSha256` must be
  the installer this record hashed. Requires `--installer`.
- **Installed runtime.** `passed` true, `errors` empty, `version` this build's,
  and the executable it exercised must be inside the installer proof's own
  `installTarget`. Requires `--installer-proof`. The installed files are gone by
  the time the record is written — uninstall is part of the proof — so that
  containment is the available tie, and without it a run against the build
  directory would be recorded as the installed runtime.

### The conservative default is unchanged

The three flags have **no default path**, unlike `--unit` and `--browser`. A
default would let a leftover proof from an earlier build be picked up and claimed
silently, which is the one thing these gates must never do. Omitting a flag
records nothing, and the README goes on printing `NOT VERIFIED in this record`,
which is the truth: a gate the record does not carry is a gate nobody can show
was run on these bytes.

`scripts/desktop-smoke.mjs` now writes `executableSha256` and `passed: true` into
its proof, following `scripts/app-updates-desktop-smoke.mjs`. The hash is taken
before the first launch, so it names the bytes the smoke drives. It writes the
proof only on its passing path, so `passed` states what that path means rather
than asserting anything new.

## How to cut the next release

**First, copy the proofs in beside the record.** The installer proof and its
runtime proof are written under `test-results/`, which is ignored. A record that
cited them there would name a path that is in no commit, so copy each into
`evidence/release-candidates/` under the record's own release ID — the layout the
0.1.1 and 0.1.4 sidecars already use — and point the flags at the copies. The
release ID is known before the record is written:
`diomedes-<version>-windows-experimental-<builtAt as UTC yyyymmdd>-<baseCommit, first 12>`,
both read from `evidence/windows-release/build-info.json`.

```powershell
$id = 'diomedes-<version>-windows-experimental-<yyyymmdd>-<commit12>'
$to = 'evidence/release-candidates'
Copy-Item evidence/desktop-proof.json                 "$to/$id-desktop-proof.json"
Copy-Item <proof root>/proof.json                     "$to/$id-installer-proof.json"
Copy-Item <proof root>/runtime-proof/proof.json       "$to/$id-installed-runtime-proof.json"
```

Then, after the build, the suites, the desktop smoke and the installer proof,
from the candidate worktree:

```powershell
npx tsx scripts/write-candidate-record.ts `
  --typecheck passed `
  --unit test-results/candidate/unit-results.json `
  --browser test-results/candidate/browser-results.json `
  --installer <path to the installer this build produced> `
  --desktop-smoke "$to/$id-desktop-proof.json" `
  --installer-proof "$to/$id-installer-proof.json" `
  --installed-runtime "$to/$id-installed-runtime-proof.json"
```

Each gate's `report` then names a committed file and its `reportSha256` proves it
is the file that was read. Pass only the flags whose proofs were actually run on
these bytes. A release that skipped the installer proof omits those two flags and
its README says so.

`scripts/verify-windows-installer.ps1` interacts with the real per-user install,
hands the registration back, and must be recovered with
`scripts/restore-windows-installer-registration.ps1` rather than an interrupted
proof's own uninstaller. Read
[`docs/releases/INSTALLER_HANDOFF.md`](../releases/INSTALLER_HANDOFF.md) before
running it, and do not run it without Andrew's say-so.

## Verification

Run in this worktree on the commit rebased onto `origin/main` at `b4eb2c2`,
20 September 2026, with ports 5174 and 47632 free.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | clean |
| Unit | `npx vitest run` | 4016 passed, 2 failed, 1 skipped, of 4019; 205 of 207 files |
| Build | `npx vite build` | built; the existing chunk-size warning only |
| Browser | `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts` | 36 passed |

The two unit failures are not this change's, and they have different causes.
This change touches no server, client or shared code, and neither failing test
nor anything either one reads is changed by it.

- **`tests/hostile-truth-capability-record.test.ts` › "records that the published
  build is not this source version" — deterministic, and stale on `main`.** It
  fails on its own, every run, and failed the same way on `9ebde6e` before this
  work. It asserts `release.appVersionMatchesSource` is `false`, which was true
  while this tree was ahead of the newest published build. Publishing 0.1.6 made
  source and release the same version, so `docs/reference/capability-record.json`
  now correctly records `true` and the test's premise no longer holds. That
  record, that test and `package.json` are byte-identical to `origin/main`. What
  the test should assert once a release catches up with source is a question for
  its owner; it is being taken up separately.
- **`tests/native-work.test.ts` › "does not recreate a project folder removed
  while its proposal was waiting" — a Windows handle, not logic.** The test
  renames a project folder to simulate its removal, and under the full suite the
  rename failed with `EPERM`: something still held a handle in that folder. The
  file passed 63 of 63 in each of three runs on its own.

Before the rebase, on `9ebde6e`, the unit suite also failed two or three tests in
`tests/scoped-work.test.ts` — a socket closed and a 30 s hook timeout, a
different set each run, and 30 of 30 on its own. PR #19, which `b4eb2c2` merges
(*"Give three load-sensitive tests explicit budgets and a teardown that cannot
cascade"*), rewrote that file's teardown and budgets, and on the rebased commit it
passed inside the full suite.

**The real CLI, end to end.** The unit tests exercise the readers and the seam
with fixtures, but not the wiring inside `main()` that puts a reader's result into
the record. That was checked by building the smallest thing the script accepts —
a stand-in executable, a real asar carrying a matching `BUILD_INFO.json`, an
installer with its manifest, and the three proofs in the shapes their scripts
write — then running `npx tsx scripts/write-candidate-record.ts` and feeding the
record it wrote to `releaseReadme` with the repository's own capability record.
Run on the final code, after the desktop-smoke fallback was removed:

- **All three flags.** The record's `verification` carried `desktopSmoke`,
  `installer` (5 checks) and `installedRuntime` (3 checks), each `result:
  "passed"` with a repository-relative `report` and its `reportSha256`, and the
  README printed `The packaged desktop smoke: passed`, `The installer's install,
  same-version repair and uninstall: passed` and `The installed runtime: passed`.
- **No gate flags.** The same build's README printed all three as
  `NOT VERIFIED in this record`.
- **A desktop proof with no `executableSha256`** — the shape every proof had
  before this change. The script refused it with *"The desktop smoke report names
  no executableSha256, so nothing ties it to the bytes it drove. Re-run npm run
  test:desktop on this build."*, exited 1, and wrote no record.

The script also still fails with its own one line on a missing executable, an
unknown flag (naming all eight flags) and each of the two flag dependencies, and
it refused the stand-in build whenever the working tree's `HEAD` moved under it,
which is its commit check doing its job. The stand-in files were removed and
`evidence/windows-release/build-info.json`, which a test reads, was restored.

`tests/candidate-record-gates.test.ts` is new. It holds each reader to refusing a
proof it cannot tie to this build, and then runs the writer's own output through
`releaseReadme` — the seam that actually failed, since each half was correct on
its own while nothing the writer produced could reach the reader. Its fixtures
are the field names of the real 0.1.4 sidecars.

`tests/release-assets.test.ts` already held the reader to printing an absent gate
as `NOT VERIFIED` and a present one as the record states it; that half of the
contract was never broken and is unchanged.

## Not done, and why

- **No record or published README was touched.** The writer re-checks
  artifacts against `git HEAD` and the packaged bytes, so a record for a past
  build cannot be regenerated honestly now, and editing a published record by
  hand is the opposite of what this change is for. 0.1.4's and 0.1.5's READMEs
  keep their literal claims and 0.1.6's keeps its `NOT VERIFIED` lines.
- **`release-manifest.json` still carries only `typecheck`, `unit` and
  `browser`.** The public manifest points at the record for the rest. Widening it
  is a separate decision about what the manifest is for.
- **No proof was run.** This slice has no packaged build; every gate above is
  exercised against fixtures. The first real use is the next release.
