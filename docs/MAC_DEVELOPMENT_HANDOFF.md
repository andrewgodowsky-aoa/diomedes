# Mac development handoff

Written 2026-09-20 on the Windows development machine. It lets development
continue on a MacBook Air from named, remotely reachable revisions. It is a
source handoff. It is not a Mac build, and nothing here has run on a Mac.

Canonical versions read: Core Pillars 2026-09-19.1; Roadmap and Project Memory
2026-09-19.2 (Drive mirror). Work order: **FD01** in the unified execution
package. Amendment source: the Mac, learning and website amendment package of
2026-09-20, Prompt 1 (this file) and Prompt 2 (the Mac lane).

Every command below is marked **[W]** Windows-verified, **[M]** macOS-verified,
or **[?]** not yet verified anywhere. There is no **[M]** in this document yet.

## Status, five separate things

| Area | Status |
|---|---|
| SOURCE HANDOFF | Done for the Mac lane and the planning masters. In-flight Windows work is **not** handed off; see *Local only*. |
| MAC DEVELOPMENT (M1) | Prepared, not run. Known blockers removed in source. First Mac session must verify. |
| MAC DESKTOP (M2) | Not started on a Mac. Packaging refuses by design until two decisions are made. |
| PUBLIC RELEASE (M3) | Not started. No signing identity, no artifact, no release record. |
| WEBSITE DEPLOYMENT | Nothing deployed. A Mac availability section is being prepared on a local site branch. |

## Repositories and starting points

| Repository | Visibility | Role |
|---|---|---|
| `https://github.com/andrewgodowsky-aoa/diomedes` | public | The product. `main` is the integration target for everything, including Mac work. |
| `https://github.com/andrewgodowsky-aoa/diomedes-mac` | private | The Mac development lane. Created 2026-09-20. |
| `https://github.com/andrewgodowsky-aoa/diomedes-site` | private | The website. |

`diomedes-mac` exists to keep Mac worktrees and work-in-progress out of a
checkout that already carries 142 worktrees. It is a separate place to work,
not a separate product. There is one Diomedes: shared Core, Runtime, Trust,
Store, Console and capability packs. The rules that keep it that way:

- `diomedes-mac` `main` mirrors `diomedes` `main` and is only ever
  fast-forwarded from it. Nobody commits to it directly.
- Mac work lives on feature branches and returns to `diomedes` `main` by pull
  request, reviewed like any other work. Windows stays a regression target.
- In the Windows clone the `upstream` push URL is deliberately disabled, so Mac
  work-in-progress cannot be pushed to the public repository by accident.

GitHub does not let an account fork its own repository, so `diomedes-mac` was
created empty and seeded from a fresh clone of `diomedes` `main`. It therefore
shows no "forked from" link, and pull requests to `diomedes` are opened from a
branch pushed to `diomedes`, not across repositories.

| Ref | SHA | Where |
|---|---|---|
| `diomedes` `main` | `80263205133c410d590549efd1c8f40cedf33b1c` | public |
| `diomedes-mac` `main` | `80263205133c410d590549efd1c8f40cedf33b1c` | private, identical |
| `diomedes-mac` `feature/apple-silicon-development` | see `git log`; base `8026320` | private. **The Mac work branch.** |
| `diomedes-mac` `planning/master-package` | orphan branch | private. Planning masters, never merged into source. |
| `diomedes-site` `main` | `9140f8937eeb38cc447a14925afd8294d4eab612` | private |

## What is on the Mac work branch

In order, on top of `8026320`:

1. **FD01.I reviewed candidate (v2).** The eight-file macOS packaging and
   discovery candidate that FD01.R v2 accepted as
   `ACCEPTED_LOCAL_SUBSET_ONLY` on 2026-09-19. It had never been committed
   anywhere. `candidate.patch` SHA256
   `69d8f2d9fd162144afc713f2fbf4457760a2b3a5313e240436c1a221c4814da3`; all eight
   Git blob hashes match the reviewed worktree. Full FD01 stays OPEN.
2. **Dev-server guard reads command lines with `ps` on macOS.** It read Linux
   `/proc` on every non-Windows host, so on a Mac it could never reclaim its own
   orphaned dev servers. It still refuses to kill anything it cannot prove it
   owns.
3. **Compiling is separate from packaging.** `npm run build` no longer packages.
   Before this, `npm run build` on a Mac would exit non-zero after a successful
   compile, because packaging ran as `postbuild` and the Mac target refuses.
4. **An Apple Silicon CI job** on the named `macos-15` image that asserts the
   architecture before it does anything. It has never run.

When comparing file hashes across machines, use Git blob hashes
(`git hash-object`), not raw SHA256. The freeze manifest records raw bytes from a
Windows checkout; a Mac checks the same content out with LF endings and every
raw hash will differ while the content is identical.

## Local only: what a Mac clone cannot see

This is the largest gap, and it is about the Windows machine, not the Mac.

- **91 of 142 app worktrees hold uncommitted changes to tracked files.** They are
  real work, stacked: each lane's tree carries its predecessors' changes and its
  own, 3,800 to 4,600 added lines in the larger ones. None of it is in any
  commit. It exists on one disk.
- **15 lanes wrote files in the three hours before this was written**, one
  within the last minute. They are live, so they were not snapshotted: a changing
  patch is not a finished one.
- **10 branch heads are on no remote:**

| Branch | Head | Note |
|---|---|---|
| `docs/fractional-ai-ops-agreement-20260919` | `7738657` | 4 ahead of main. Checked out in the main checkout. |
| `feature/durable-event-recovery` | `dd53f03` | PR #3 is at `698c90e`; 5 local commits unpushed, merged into 02:10 today. |
| `feature/inventory-contracts` | `05b9b27` | PR #6 is at `58e5211`; 5 unpushed. |
| `feature/inventory-catalog-import` | `31b1a6b` | PR #7 is at `416ac54`; 6 unpushed. |
| `feature/inventory-stock-preparation` | `8ea2bf5` | PR #8 is at `60f89c7`; 7 unpushed. |
| `feature/devin-agent-worker-20260917` | `93378a2` | 1 ahead of main. |
| `fix/durable-write-rename-retry-20260917` | `ff50331` | 1 ahead of main. |
| `fix/ai-engines-default-save-20260913` | `7adf603` | 1 ahead; believed already landed by another commit. |
| `integration/unified-on-main-20260915` | `51493a8` | Carries the C00 repair that review **rejected**. Do not land. |
| `integration/unified-20260913` | `9ade95a` | Superseded integration branch. |

  The three inventory branches are a stack (#6, then #7 on #6, then #8 on #7)
  and belong to the Astra inventory lane. Push them in order, by their owner.
  Applying one twice, or out of order, double-applies a change.
- On the site, `feature/contact-booking` (`7f7ece0`) is on no remote, and three
  site worktrees hold uncommitted changes.
- The Windows coordination state (`.git/diomedes-coordination/`, claims,
  journals, run evidence) is local by design and is not copied. A claim held on
  Windows does not bind a Mac clone.

None of this blocks starting on the Mac. It does mean the Mac sees `main` plus
the Mac lane, and not the discovery, readiness, native-session, account or
inventory work that is still in flight.

### Open pull requests on `diomedes`, for orientation only

\#1 draft, discovery, readiness, rehearsal and native sessions (`9d6f3e3`). \#2
Jev evaluation (`9a328ce`). \#3 durable event recovery. \#4 Windows CI repairs,
which also carries the account service (`2ceefe3`). \#6, \#7, \#8 the inventory
stack. "Mergeable" means no textual conflict. It is not approval.

## Planning masters

The unified execution package and the amendment prompts lived only in
`F:/Diomedes/planning/` on the Windows machine, in no repository. They are now on
the private orphan branch `planning/master-package`:

```sh
git fetch origin planning/master-package
git worktree add ../diomedes-planning planning/master-package
```

Start at `diomedes-unified-execution-2026-09-13/RUN_ORDER.md`. FD01 is prompt
`03c`; its review is `04c`. It is a snapshot taken 2026-09-20 and the Windows
copy stays canonical. Edit the masters on one machine only. The amendment
package says no Mac work order existed; it was written without sight of the
unified package, and FD01 supersedes that statement. Nothing was added to the
master for the Mac lane, because FD01 already covers it.

Pillars, Roadmap and Project Memory are in `docs/` in this repository, with
Drive mirrors whose links are in `AGENTS.md`.

## Toolchain on the Mac

- Apple Silicon first. Intel and universal builds are a separate decision.
- Node 22, the line CI uses. `.nvmrc` says `22`. Install a native arm64 Node;
  `node -p process.arch` must print `arm64`, not `x64` under Rosetta.
- Git and the Xcode Command Line Tools (`xcode-select --install`). Full Xcode is
  not needed for source development.
- Work in an ordinary local folder such as `~/dev`. Do not put the checkout in
  iCloud Drive, Dropbox or any synced folder.
- Do not copy `node_modules`, `.data`, a Windows profile, or engine sign-in
  caches from Windows. Install fresh; sign in to each engine again on the Mac
  through its own flow.

## First session on the Mac

```sh
git clone https://github.com/andrewgodowsky-aoa/diomedes-mac.git ~/dev/diomedes-mac   # [?]
cd ~/dev/diomedes-mac
git remote add upstream https://github.com/andrewgodowsky-aoa/diomedes.git            # [?]
git switch feature/apple-silicon-development                                          # [?]
uname -m && node -p "process.version + ' ' + process.arch"                            # [?] expect arm64 twice
npm ci                                                                                # [W] from the committed lock
npm run check                                                                         # [W] tsc --noEmit, exit 0
node node_modules/vitest/vitest.mjs run --maxWorkers=2                                # [W] 2324 passed, 3 skipped, 0 failed
npm run build                                                                         # [?] must compile and create no release/ folder
npm run dev                                                                           # [?] then open http://127.0.0.1:5173, Ctrl+C stops both
node scripts/dev-server-guard.mjs                                                     # [W] exit 0 when ports are free
```

One heavy command at a time on the Air. Keep Vitest at two workers.

`package-lock.json` was generated on Windows and does carry the Apple Silicon
optional binaries (`@esbuild/darwin-arm64`, `@rollup/rollup-darwin-arm64`,
`fsevents`), so `npm ci` should not hit the missing-optional-dependency failure
that Windows-made lockfiles are known for. Newer npm blocks install scripts by
default and will warn about `esbuild`; on Windows the build still works without
it. If esbuild cannot find its binary on the Mac, that warning is the first place
to look. Do not run `npm install` to "fix" the lock; report it instead.

What to expect and report from that session:

- Some unit tests will probably fail on macOS the first time. The suite was
  written on Windows and has never run anywhere else. Record each failure with
  its reason. Fix the platform assumption or mark the test OS-exclusive with a
  stated reason. Do not skip failures to get a green run.
- `tests/dev-server-guard-platform.test.ts` has two tests that are skipped on
  Windows and run on a Mac. They are the first real check of the `ps` reader.
- Start `npm run dev`, kill the terminal without Ctrl+C, run `npm run dev`
  again. The guard should reclaim the orphaned pair. Then hold port 5173 with an
  unrelated process and confirm the guard refuses and kills nothing.
- Record macOS version, machine model, memory, and measured memory during a
  build. No performance figure is promised in advance.

## Known platform state

| Item | State |
|---|---|
| `npm run build` packaging on a Mac host | Fixed in source, not Mac-verified. |
| Dev-server guard on macOS | Fixed in source, not Mac-verified. |
| `npm run package:mac` | Refuses by design. Two separate reasons, below. |
| Desktop shell on macOS | `desktop/main.mjs` quits when the last window closes, has no Dock reopen, uses a Windows title-bar overlay, and offers Windows engine installers. Being addressed on `feature/macos-desktop-shell`, not merged. |
| Native Codex route on macOS | Refused before any account call. A Mac Codex install is reported as observed and unsupported. No Codex executable is bundled for Mac. |
| Engine discovery on macOS | Implemented against fixtures. Never run on a Mac. Discovery is not readiness. |
| Credentials | macOS uses Keychain through Electron's protected storage. Untested. No plaintext fallback is acceptable. |
| Line endings | The repository has no `.gitattributes`. Harmless today; worth adding before shell scripts appear. |

`npm run package:mac` refuses for two reasons that are easy to confuse:

1. **Missing offline Electron archive.** The packager never downloads a platform
   archive silently, from Windows or from a Mac. `npm ci` does not supply one
   either: Electron 44 has no install script and fetches its binary the first
   time it is launched, so after `npm ci` there is no `node_modules/electron/dist`
   on any platform (checked on Windows with npm 12). Source development, the
   tests and `npm run build` do not need the binary. Packaging needs
   `electron-v44.2.0-darwin-arm64.zip` placed in a folder named by
   `DIOMEDES_ELECTRON_ZIP_DIR`; obtaining it is a deliberate, recorded download.
2. **Ad-hoc signing policy.** For Electron 41 and later on macOS, the packager
   re-signs the Framework ad hoc to keep ASAR integrity valid. FD01 authorizes no
   signing, so a Mac-host package run refuses. Apple Silicon will not execute
   unsigned native code at all, so an ad-hoc signature is the minimum for a local
   test build to launch. Until this is decided there is no `.app`, signed or not.
   It does not affect `build`, `dev` or the tests.

## Who works where

| | |
|---|---|
| Mac work branch | `feature/apple-silicon-development` in `diomedes-mac` |
| Base | `8026320` |
| Integrator | One. Fable on the Windows machine until Andrew reassigns it. |
| Paths the Mac lane owns | `scripts/package-desktop.mjs`, `scripts/dev-server-guard.mjs`, `scripts/dev.mjs`, the `package:*` and `build` scripts, the `macos-arm64` CI job, `docs/MAC_*`, `docs/reference/MACOS_*`, `desktop/**` for platform branching, and the Mac tests. |
| Shared contracts | `shared/**`, `server/harness/**`, Trust interfaces. Not changed on the Mac lane without the owner. `server/discovery.ts` and `server/engines/service.ts` are shared with H02 to H04, which consume the reviewed FD01 interfaces. |

Two clones cannot coordinate through a local claims folder. Coordination between
the Mac and Windows is by pull request and by this file. One machine edits a
given branch at a time: push before switching machines, pull before starting.

## Code moves through Git. State does not.

A clone carries source. It does not carry projects, runs, approvals, engine
sign-ins, settings, or anything under `.data`. A task pending on Windows does not
continue on the Mac because the code is there; do not copy a run record across
to make it. Continuing work across devices is a separate capability that has not
been built or qualified. Use synthetic projects on the Mac. No live account,
customer data or provider spend is authorized by this handoff.

## Decisions waiting on Andrew

1. **Actions on `diomedes-mac`.** Disabled at creation so the seed push cost
   nothing. macOS runners bill at ten times Linux minutes on a private
   repository. The `macos-arm64` job is the only way to get real Darwin evidence
   without the Mac in hand. The alternative is free: open the pull request on
   public `diomedes`, where macOS runners cost nothing.
2. **Ad-hoc signing for founder-local Mac builds.** Blocks every M2 `.app`.
   Separate from Developer ID signing and notarization (O10), which stays the
   gate for anything a customer downloads.
3. **Pushing the ten local-only branch heads**, by their owners, and deciding
   what happens to the uncommitted stacked work.
4. **Repository name and visibility.** `diomedes-mac`, private, chosen as
   defaults.
5. **Upstream pull request** for the four commits on the Mac branch. Commits 2
   and 3 are platform-neutral fixes that help Windows too and could go first.

## Not done, and not claimed

No Mac command has run. No Mac package exists. No `.app` has launched. No engine
has been discovered or signed in on a Mac. Nothing is signed or notarized. The
CI job has never executed. `npm run package:windows` was not re-run after the
script change; the unit suite and type-check were. No website change is live.
