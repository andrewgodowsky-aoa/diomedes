# Release candidate: one named build, and what was measured on its exact bytes

September 12, 2026. Brief 01 (release and demo), REL-02: one named candidate whose commit,
app version, package hash, protocol versions and test results agree, tested as the exact
distributed EXE rather than only under Vite. This record names that candidate, says what
proved it, and says what it does not claim. The two demonstration journeys traversed on the
same bytes have their own records, `2026-09-12-demo-journey-a.md` and
`2026-09-12-demo-journey-b.md`.

## 1. The candidate

| Field | Value |
|---|---|
| Release id | `diomedes-0.1.1-windows-experimental-20260912-da84689e08d7` |
| Source commit | `da84689e08d73c98390bccea63669cc93a21a657`, `main`, source status `committed` |
| App version | 0.1.1 (unchanged; see §5) |
| Build input digest | `ab11cc07d2e32970a74bf46e10d952987606dec519528cafaf64660cfdcb2cc0` |
| Built | 2026-09-12T04:29:01Z, Electron 44.2.0, native runtime codex 0.153.4 (three hash-verified binaries) |
| `Diomedes.exe` SHA-256 | `ae8ef98af1b83cacc237c1649de8a993b1577c0365e5b98066d4ad93404f249a` |
| `resources/app.asar` SHA-256 | `f2836d4f00884875fc98b333915e9b8975e34b5a188da27fff48aa4f933c1bdd` |
| Installer | `Diomedes-Experimental-0.1.1-unsigned-setup.exe`, 265,954,167 bytes, SHA-256 `ed9748c57001135598f3ba1b3c38b5a6225513749ed7594c8418ffd5f6455691`, NSIS 3.12, unsigned |
| Installer location | `F:\Diomedes\deliverables\windows-release-20260912-da84689\` on the build machine; not published |
| Protocols | Work command 1, scoped grant 2, reviewer 3, Agent 1; harness `harness-v1`, `in-process`, `codex app-server 0.153.4`, `codex app-server 0.153.4 with diomedes_team MCP`; tested engine versions Claude Code 2.1.252, OpenCode 1.18.4, oh-my-pi 18.0.6, Cursor 2026.08.11 |

The identity is embedded in the package (`resources/app.asar:BUILD_INFO.json`) and written
by the packager to `evidence/windows-release/build-info.json`; the two are compared byte for
byte. The full record, with every field above, is
`evidence/release-candidates/diomedes-0.1.1-windows-experimental-20260912-da84689e08d7.json`.

The build was made in an isolated worktree at `da84689` with `npm run build` (tsc, Vite,
`scripts/package-desktop.mjs`), then `scripts/build-windows-installer.mjs` with the cached
NSIS 3.12 archive, `--out-dir` and `--output-name` given explicitly because the script's
defaults still name the September 9 folder.

## 2. How the record is produced

`scripts/write-candidate-record.ts` (new; written by Muse Spark 1.3 from a one-file brief,
one correction by the integrator) reads the build info, `package.json`, `git rev-parse HEAD`,
the packaged executable and asar, the embedded `BUILD_INFO.json`, the vitest and Playwright
JSON reports, and the installer's manifest. It refuses to write a record unless the version,
commit, embedded identity, every recorded source hash, the unit and browser results, and the
installer digest all agree. It asserts zero failures, never a fixed test count; the two older
scripts that hard-coded 615 and 697 tests are the reason. Under `--allow-uncommitted` it
still writes a record but marks it `named: false`.

## 3. What was run on the exact bytes

All commands ran serially on the build machine (Windows 11 Home 10.0.26200) from the
candidate worktree. Nothing below used a Vite dev server.

| Proof | Result | Evidence |
|---|---|---|
| `tsc --noEmit` (inside `npm run build`) | clean | `test-results/candidate` build log (ignored) |
| `vitest run` with the JSON reporter | 1498 passed, 1 skipped, 0 failed; 88 files | `evidence/release-candidates/…-unit.json` |
| `playwright test` (full configured set) with the JSON reporter | 52 passed, 0 unexpected, 0 flaky | `evidence/release-candidates/…-browser.json` |
| `scripts/desktop-smoke.mjs` on the packaged EXE, isolated profile | passed: packaged startup, task board, font scaling, Workbook and Console lost-response recovery, team threads and messages, renderer isolation, shutdown with lock release, receipts retained after restart, no page errors | `evidence/desktop-proof.json` (regenerated; `executablePath` names this candidate) |
| `scripts/app-updates-desktop-smoke.mjs` on the packaged EXE | passed: portable shell facts and no automatic release check; compiled UI check, digest verification and accepted-response handoff; the real packaged helper refuses while the parent runs and refuses same-size tampering after exit | `evidence/autonomy-workbench/app-updates-desktop-proof.json` (regenerated; `exeSha256` equals the candidate) |
| `scripts/verify-windows-installer.ps1` on the installer | passed: silent per-user install of all 76 payload files with identical SHA-256, current-user keys and shortcut; the installed executable passed the Connections desktop/crash/restart smoke (11 checks) with an isolated profile; same-version repair retained unknown data and the profile; uninstall removed only owned payload, registration and shortcut | `evidence/release-candidates/…-installer-proof.json`, `…-installed-runtime-proof.json` |

The browser run on this worktree needed one restart: the first attempt was started with the
JSON reporter pointed at stdout, was stopped, and its replacement collided with the still-open
port, so one spec failed on a port-in-use error that was the integrator's own. The clean run
that followed is the one recorded. The unit skip is the 8.3-alias case this volume cannot
produce; CI on `windows-latest` covers it.

The installer verification writes real current-user registry keys and a Start Menu shortcut
during the run and removes them at the end; both were absent before and after.

## 4. Last known good

The brief asks for an independently identified last-known-good build beside any candidate.
There are two earlier identities, and neither is complete on disk:

- `docs/releases/release-manifest.json` names `diomedes-0.1.1-windows-experimental-20260909-09e551958dfa`
  (commit `11829e1962b4`, executable `1aa5a72eb0fb…`, installer `e487e62f50a6…`). Its
  artifacts were staged under `F:\deliverables\windows-release-20260909`, which no longer
  exists after the tree moved from Achilles. The hashes remain the record of it.
- The main checkout's `release/Diomedes-win32-x64` holds a later portable build from
  `7b1b5a61ec09` (built 2026-09-09T12:06Z, `committed`, executable `aa7a750d052f…`). It was
  left untouched by this work, which is why the candidate was built in a worktree.

So the last known good is the `7b1b5a6` portable package in the main checkout, and the
September 9 installer identity survives only as hashes. This candidate is the first whose
installer bytes, package bytes and record exist together on the machine.

## 5. Open questions for Andrew

- **Version.** The candidate is 0.1.1, the same as both earlier identities, because bumping
  the version is not this task (AGENTS.md). Two installers named
  `Diomedes-Experimental-0.1.1-unsigned-setup.exe` now exist in history with different
  digests, and the stable update channel distinguishes releases by version. Whether this
  candidate becomes 0.1.2, or stays an unpublished 0.1.1 experimental, is his call.
- **Product identity.** The installer's product id, ownership marker and Start Menu folder
  are still named `20260909` in `scripts/build-windows-installer.mjs`. Renaming them would
  break upgrade continuity with the earlier installer, so they were left. The date in the
  name is now misleading and should be renamed deliberately, once.

## 6. What this does not claim

No release was published, no public URL exists, nothing was signed, no user installation was
replaced, and the app-updates channel was not exercised against a real GitHub release. The
journeys' live provider calls are disclosed in their own records. Engine support remains as
measured on September 11: four pickers render, and each route's proven depth is what its
record says, not "four production-ready routes".

**PILLAR IMPACT.** Advances 01 (a build a person can install that says what it is), 09
(trust: an identity that is checked, not asserted; a record script that cannot pass on a
count) and 11 (release work that does not need the founder at the keyboard to name a
build). No conflict. Proof: the record file, the four smokes and the installer proof above.

**ROADMAP IMPACT.** REL-02 moves from UNPROVEN to done for this candidate; REL-07 has partial
evidence (the desktop smoke's shutdown, lock release and receipt persistence on restart) and
is not claimed complete; REL-08 (a real downloaded-version upgrade) remains unproven.

**BUILD / PUBLICATION / DEPLOYMENT STATUS.** Source, one local package, one local installer
and evidence. Version stays 0.1.1. Nothing published.
