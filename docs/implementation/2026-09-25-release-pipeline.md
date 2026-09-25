# Release pipeline on GitHub Actions, and version 0.2.0

Lane `release-pipeline`, branch `feature/release-pipeline`, PR #122 (draft). Andrew approved
publishing a new live build on 2026-09-25: Windows, macOS "if it works fine", and a GitHub
release. Until now every Windows installer was packaged by hand on Andrew's machine. This lane
makes GitHub Actions produce equivalent, verified artifacts on hosted runners. It publishes
nothing stable: the workflow makes a draft or a prerelease, and the integrator promotes it.

Canonical documents read: Core Pillars 2026-09-22.1, Live Roadmap 2026-09-25.1, Project Memory
2026-09-25.1. None was edited; the patch they need is at the end.

## What was built

### `.github/workflows/release.yml`

`workflow_dispatch` with three inputs:

| Input | Values | Meaning |
|---|---|---|
| `version` | `X.Y.Z` or `X.Y.Z-rc.N` | `X.Y.Z` must equal `package.json`. The tag is `v<version>`. |
| `publish` | `draft` (default), `prerelease` | A stable release is never made by the workflow. |
| `macos` | `build-only` (default), `attach-if-passing`, `skip` | Whether the macOS image may be attached. |

Jobs, all at the one commit the run starts on:

- **prepare** (Ubuntu): the version matches `package.json`, the publish mode is draft or
  prerelease, no tag or release already uses the name, release notes exist.
- **windows** (`windows-latest`): `npm ci` (root and control plane); gate 1 `tsc --noEmit`; the
  native runtime and the Electron archive, both verified (below); gate 3 and packaging through
  `npm run package:windows`; the build stamp printed to the log; gate 2 vitest with the JSON
  reporter; gate 4 Playwright `ui`, `native-ui` and `field` with the JSON reporter; the NSIS
  installer through `build-windows-installer.mjs`; the packaged desktop smoke; the negative smoke
  (recorded, not a gate, below); `verify-windows-installer.ps1 -RuntimeSmoke launch`, which
  installs silently into a new folder under `test-results`, launches the installed copy, repairs,
  uninstalls and hands the registration back; then `write-candidate-record.ts` with the desktop
  smoke, installer and installed-runtime proofs, and the capability record.
  Packaging comes before the unit gate, as in a hand release: packaging stamps
  `evidence/windows-release/build-info.json` with the version, and `tests/build-identity.test.ts`
  requires that stamp to match `package.json`. Nothing rebuilds `dist/` after packaging, because
  the candidate record re-hashes it.
- **macos** (`macos-14`, Apple Silicon asserted): verified Electron archive; `npm run
  package:mac`; the ad-hoc whole-bundle signature Andrew chose (below); a UDZO disk image
  (`Diomedes.app` and an Applications link), `hdiutil verify`; the signature facts; the launch
  smoke from the mounted, read-only image; a release proof binding the image's SHA-256 to the
  smoke, the signature facts and the build's commit; a `publishable` output that is true only when
  the smoke passed and `codesign --verify --deep --strict` accepts the bundle.
- **release** (`windows-latest`, `contents: write`): runs when Windows passed, whatever macOS did.
  The notes, `write-release-assets.mjs` from the candidate record, the body, `gh release create
  --target <sha>` as a draft or as a prerelease with `--latest=false`, then every uploaded asset is
  compared with GitHub's own `digest` and size, and the table goes to the run summary.

### Native runtime: a verified download, no pin changed

`package-desktop.mjs` refuses to package unless `.data/native-runtime` holds three files with
fixed SHA-256 values; `prepare-native.ts` copies them only from an installed Codex. A hosted
runner has none. OpenAI's current downloads cannot satisfy the pins: the GitHub release assets
for `rust-v0.153.4` and the npm package `@openai/codex@0.153.4-win32-x64` carry the same program
under a different Authenticode signature instance, so every whole-file hash differs (checked
again today: npm's `codex.exe` is `444a3f00…518b`, the pin is `a1cf6360…b6`;
`docs/releases/NOTICES_HANDOFF.md` has the section-by-section proof that the programs are
identical).

The exact pinned bytes are published in our own release v0.1.11: its portable ZIP carries them
under `resources/native-runtime`. `scripts/release-support/acquire-native-runtime.mjs` downloads
`Diomedes-Experimental-0.1.11-win32-x64.zip`, requires 269,088,059 bytes and SHA-256
`e30c17c8228db2fdfba1380234fbbe4e69eca0cea4ad0ad90560c9f1e8c1a070` (the values v0.1.11's
`release-manifest.json` and `SHA256SUMS.txt` publish), extracts only the three files, and
requires each to hash to `WINDOWS_NATIVE_RUNTIME_SHA256`, now exported once from
`package-desktop.mjs`, which checks them again before packaging. Verified here on Linux and in
every proof run.

This keeps every bundled runtime byte-identical to 0.1.1–0.1.11. Its source is our own earlier
release. The day the runtime moves to a new Codex version, the pins, this source and
`prepare-native.ts` change together.

### Electron archive

`scripts/release-support/acquire-electron-archive.mjs` downloads
`electron-v<version>-<platform>-<arch>.zip` and accepts it only when its SHA-256 equals both the
line in Electron's `SHASUMS256.txt` and `node_modules/electron/checksums.json`, which came through
`package-lock.json`'s integrity-checked install. For 44.2.0: darwin-arm64 `f906dff5…9b02`,
win32-x64 `4021363e…81da`, both sources agreeing. Both platforms use it, so neither job downloads
Electron unverified.

### macOS packaging and signatures

Two separate signing steps, both named where they happen:

1. **The framework.** On a Mac host `@electron/packager` writes the ASAR integrity digest into the
   Electron Framework and then restores the ad-hoc signature Electron ships with (Apple Silicon
   will not execute a binary whose signature is invalid). `package-desktop.mjs` still refuses this
   by default, and both tests that pin the refusal pass unchanged;
   `DIOMEDES_MAC_ADHOC_FRAMEWORK_RESIGN=accept`, which only the release workflow sets, names it,
   and the build record says `macFrameworkSignature: ad-hoc, restored by @electron/packager …`.
2. **The bundle.** The first proof runs showed the packaged app launching from its disk image
   while `codesign --verify --deep --strict` refused the bundle: "code has no resources but
   signature indicates they must be present". The smoke executes the binary directly, which macOS
   allows; a downloaded copy is quarantined and judged by that signature, and one that does not
   verify is refused as damaged. The workflow therefore marks an image publishable only when the
   bundle verifies, and `write-release-assets.mjs` refuses one that does not. Andrew then chose
   (2026-09-25, O43 option a, commit `65dad09` from the integrator's session) to sign the whole
   bundle ad hoc (`codesign --force --deep --sign -`) before the disk image. That names no
   developer and is not notarized: Gatekeeper still asks the person to open it once.

### Launch smoke

`scripts/packaged-launch-smoke.mjs <executable> <new proof dir>` is platform-neutral. It launches
the packaged app on a fresh profile, data and projects folder with an empty `CODEX_HOME`, waits
for the window to load from 127.0.0.1, asks `/api/health` from inside the window (the only
caller the service answers) and requires `ok` and this version, asks the same URL from outside
and requires 401, reads `desktop-startup.json`, quits, and requires the data lock released and
the port closed. Its proof carries the fields `write-candidate-record.ts` reads for an installed
runtime (`passed`, `errors`, `version`, `executablePath`, `checks`), so the installer proof can use
it (`-RuntimeSmoke launch`).

### Release assets, notes and body

`write-release-assets.mjs`:

- accepts `v<version>-rc.<n>` beside the stable and `-experimental.<n>` tags;
- exports `releaseAssetNames`: Windows `Diomedes-Experimental-<v>-unsigned-setup.exe` and
  `Diomedes-Experimental-<v>-win32-x64.zip` (unchanged), macOS
  `Diomedes-Experimental-<v>-mac-arm64.dmg`;
- takes `--mac-dmg` and `--mac-proof` together. The image is published only beside a proof that
  passed on darwin/arm64 for this version with no page error, whose recorded image hash is the
  image's, whose build commit is the Windows record's, and whose bundle signature verifies;
- builds the manifest in an exported pure `releaseManifest`. Every schema-2 field is kept; the
  top-level `platform` still describes Windows; macOS is one more `artifacts` entry
  (`kind: macos-disk-image`, its own `platform`, `signing: ad-hoc only (no Developer ID signature,
  not notarized)`, `launchSmoke`); a new `platforms` list names what the release carries. The
  local-path guard now also catches `/Users/`, `/home/` and `/private/`.

`scripts/release-support/release-body.mjs`:

- **Notes** (`--notes-out`): the `resources/release-notes/releases.json` entry for the version (or
  the X.Y.Z base of a candidate), drawn in the README's plain-text sections (`New` → `WHAT IS NEW`
  with the headline first, `Fixed` → `FIXED`, `Updating` → `UPDATES`, `Known limits` → `LIMITS`),
  wrapped at 78 columns with the two-space indent; `docs/releases/notes/v<X.Y.Z>.txt` when there is
  no entry. They continue the README through `write-release-assets --notes`.
- **Body** (`--readme … --out`): the README itself, as for 0.1.7–0.1.11, with a candidate opening
  on `RELEASE CANDIDATE n of X.Y.Z`. Main's update check (`notesFromReleaseBody` in
  `shared/release-notes.ts`) reads a body from its `WHAT IS NEW` heading on, and a test runs the
  body through that function.

### The updater

A correction to the brief: installed 0.1.x updaters do not read `release-manifest.json`. They read
GitHub's `releases/latest`, keep the single asset matching
`^Diomedes-Experimental-(\d+\.\d+\.\d+)-unsigned-setup\.exe$` whose URL is the official download
path under a stable `vX.Y.Z` tag, and accept the download only when its SHA-256 equals that
asset's GitHub `digest` (`sha256:<hex>`). So compatibility rests on the installer name, on there
being exactly one match, and on the upload itself; the release job checks every digest after
upload.

Two changes, Windows behaviour unchanged:

- `shared/app-updates.ts`: the selector became `selectMatchingAsset(payload, pattern, noun)`;
  `selectWindowsAsset` calls it with the old pattern and the old messages; `selectMacAsset` and
  `selectReleaseAsset(payload, platform)` are new, with `UPDATE_MAC_ASSET_PATTERN`, which can
  never match the installer pattern.
- `server/app-updates.ts` checks with `selectReleaseAsset`, so a Mac copy finds the disk image
  and never a Windows `.exe`; on macOS `download` refuses with "download the update from the
  release page", and `client/AppUpdates.tsx` hides the Download button there. Before this, a Mac
  build's check would have selected the Windows installer and offered to download it.

`tests/release-updater-compat.test.ts` runs the 0.1.11 selector itself:
`tests/fixtures/updater-0.1.11/app-updates.ts` is `shared/app-updates.ts` from release commit
`a492c42`, pinned by SHA-256 (`3141076e…9e5aca`, hashed with LF endings, as Git stores it) so an
edit fails the test. It proves that the 0.1.11 code finds the Windows installer, and only it, in a
release that also carries the disk image and zip; that the digest it holds the download to is the
installer's; that a `-rc.N` tag never parses as an update; that a macOS updater picks the disk
image with its own digest, reports none for a Windows-only release, and refuses to download; that
a Windows copy still downloads and verifies; that the manifest keeps every Windows field; that a
disk image is published only beside a verifying bundle signature; and the notes and body rules.

### Version 0.2.0

The files `f01d74e` touched for 0.1.11: `package.json` and `package-lock.json` (through `npm
version`), the README's version line, `resources/product-knowledge` (`buildVersion` and the index
hash of `core.json`), `tests/inventory-receipt-ui.spec.ts`; plus
`docs/reference/capability-record.json` regenerated as `a492c42` did, and
`docs/releases/notes/v0.2.0.txt`, which is now drawn from the `releases.json` 0.2.0 entry by the
same renderer (a test keeps them equal), so the notes have one source.

`evidence/windows-release/build-info.json` is the stamp of the 0.2.0 build that proof run 4 packaged
from `7499002`, read back from that run's log; all 599 tracked source hashes it lists match that
commit. `tests/build-identity.test.ts` requires the committed stamp to carry the package version.
The build published as 0.2.0 replaces it with its own, as every release commits its stamp.

### Fixes the hosted runners forced

Each was found by a proof run and fixed at its cause:

| Found | Cause | Fix |
|---|---|---|
| The frozen fixture's hash differed on Windows | CRLF checkout | hash with LF, as `write-capability-record.ts` does |
| `build-identity` could never pass on a version bump | unit gate ran before packaging | package first, as a hand release does |
| `ui.spec.ts` engine choices: "Install this tool to connect it." | an earlier test's Check connections runs real discovery; a runner has no Claude Code | accept that truthful sentence too; the list must still be empty |
| `ui.spec.ts` composer: Shift+Enter left only a newline | the test typed before New finished opening the thread, whose switch empties the box | wait for the creation, the reload and the new thread's greeting |
| Negative smoke: 401 on its first request | it asked the service from Node; the service answers only its own window | ask through the window, and check the 401 from outside |

## A product fault the release checks cannot get past

In a packaged build every Connections event is refused. `server/connections/desktop.ts`
`event()` always sends the synthetic, signed event to the app's own loopback ingress
(`/vendor/connections/<project>/<id>`, route at line 317 passes `req.socket.localPort`), and that
request carries no per-launch session header. Since the loopback session check in `server/app.ts`
(0.1.8), the service answers such a request with 401, and the driver reports
`409 ingress_refused: The signed local ingress refused the synthetic event.` This is why no
release since 0.1.8 records the installer proof or the installed runtime: both ran the
Connections desktop smoke, which posts events.

It is in the Trust middleware in `server/app.ts`, a shared hot file, so it is not changed here.
Two ways to fix it, for the owner:

- give the self-call the header: `createApp` holds `loopbackToken`; pass it to the Connections
  desktop service and add `X-Diomedes-Session` to the ingress `fetch`; or
- exempt `/vendor/connections/` from the session check, since that ingress authenticates each
  event by its `Toast-Signature` HMAC and stays loopback-only.

The first keeps the boundary exactly as it is and is the one proposed. Until one lands:

- `package-negative-smoke.mjs` runs in every release and its outcome is printed; it cannot block
  a release, and nothing reads it as passed (the candidate record does not take it).
- The installer proof runs the installed copy with the launch smoke (`-RuntimeSmoke launch`), so
  install, launch, repair and uninstall are proven on the exact installer. The Connections smoke
  remains the script's default.

## Proof runs

All on `feature/release-pipeline`, dispatched with `version=0.2.0-rc.1`, `publish=draft`,
`macos=attach-if-passing`. Only run 9 created a release.

| Run | Head | Outcome |
|---|---|---|
| 1 (36080551976) | 365a522 | push-triggered; the dispatch was refused (a job-level `env` cannot read `runner`) |
| 2 (36080584839) | 779260f | cancelled, superseded |
| 3 (36081797151) | 620ab98 | Windows failed: CRLF fixture hash, and the unit gate ran before packaging |
| 4 (36083334996) | 7499002 | Windows failed: engine-choices sentence on a hosted runner; the 0.2.0 build stamp was read from this run |
| 5 (36085135989) | 3a54150 | Windows failed: negative smoke 401 (it asked from outside the window) |
| 6 (36086603143) | de1e413 | Windows: negative smoke `ingress_refused` (the product fault above); macOS bundle signature did not verify |
| 7 (36088356420) | 2bd8310 | Windows and macOS passed every step; the release job wrote the assets, then `gh release create` failed on the one-element PowerShell splat |
| 8 (36089594230) | 792d9d6 | macOS passed; Windows unit gate failed twice on tests this lane does not touch: `native-loop.test.ts` (child run not seen within the 1 s poll), then on the re-run `h16-stream-triggers.test.ts` (30 s timeout) |
| **9 (36092737965)** | **440c2a6** | **prepare, windows, macos and release all passed, including the draft and the digest check** |

Run 9's head carries the integrator's `440c2a6`, which gives the parent-stop delegate test a 10 s
poll on a loaded runner (assertions unchanged).

Run 9, Windows job: gates 1 to 4 passed; native runtime from the v0.1.11 ZIP matched the pins;
Electron archive matched both SHASUMS256 and `checksums.json`; package, installer, packaged
desktop smoke, installer install/launch/repair/uninstall in a temporary folder with
`-RuntimeSmoke launch`, and the candidate and capability records passed. The negative smoke ran
and was recorded (not a gate). macOS job: package, ad-hoc bundle signature (`codesign --verify
--deep --strict` passes), disk image (`hdiutil verify` passes), launch smoke from the mounted image
and the publish check passed. Release job: assets, `gh release create --draft` at `440c2a6`, then
every uploaded asset compared with GitHub's own `digest` and size; all matched.

Draft `v0.2.0-rc.1`, "Diomedes 0.2.0-rc.1 (release candidate, experimental, unsigned)", target
`440c2a6b79f2352c7597b44e1f16772bd0bbfafe`, release id `diomedes-0.2.0-windows-experimental-20260925-440c2a6b79f2`:

| Asset | Bytes | SHA-256 (= GitHub digest) |
|---|---:|---|
| `Diomedes-Experimental-0.2.0-unsigned-setup.exe` | 268,958,688 | `37050ca78df029465fcb213679af4bed79507c6518acddfdd603acf6c0969b14` |
| `Diomedes-Experimental-0.2.0-win32-x64.zip` | 269,531,874 | `c684aca6a7d73969b58384940baece627923dc706bdeca0f8778199da8aece14` |
| `Diomedes-Experimental-0.2.0-mac-arm64.dmg` | 145,709,379 | `bad00e431410c8aadf5d67480489d3f73776a07dfc712e97cd332a109dee252c` |
| `Start-Experimental.ps1` | 1,421 | `bd2a15aa19863714625590c022f32d9f2a513a5f15acace86c41f3ac2f944bff` |

The README, `release-manifest.json` and `SHA256SUMS.txt` are attached as well and passed the same
digest check. The draft is left in place, labelled as a release candidate in its title and in the
first line of its body; a draft is never `latest`, and an `-rc.N` tag is not a stable version, so
no installed copy is offered it. Delete it once 0.2.0 is published.

## Is macOS working?

Yes, as an unsigned-for-distribution Apple Silicon build. In runs 7 and 9 the app packaged on
`macos-14`, took an ad-hoc whole-bundle signature that verifies (`codesign --verify --deep
--strict`), was put in a UDZO disk image that `hdiutil verify` accepts, and launched from the
mounted image: headless start, `/api/health` answered 200 with version 0.2.0 from inside the
window, 401 from outside it, the startup record written, a clean quit, and the lock and port
released. Gatekeeper does not accept it (no Developer ID, not notarized), which the notes say
with the right-click Open instructions. It was tested on a GitHub-hosted macOS 14.8.9 arm64
runner, not on a person's Mac. There is no Intel build. A Mac copy's update check points to the
release page; it does not download.

## Gates

Local, on `792d9d6` (the lane's last code commit), Linux container:

- `npx tsc --noEmit`: passed.
- vitest (`--maxWorkers=3`): 7,528 passed, 20 skipped, 0 failed; 425 files passed, 1 skipped.
- `npx vite build`: passed.
- Playwright `tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: 36 passed.

Hosted, run 9 on `440c2a6`: all four gates passed on `windows-latest` inside the release job.

Main's own Windows unit gate (`build-test.yml`, `local-gates`) was red on the batch 8 and batch 9
merges with a different harness timing test each time (`claude-session-runtime`, and on this
branch `h03-claude-live-controls`, `native-loop`, `h16-stream-triggers`). The release workflow
runs the same command, so a release run can fail on one of these; that is a fault in those tests
on a loaded Windows runner, not in the packaged build, and the workflow does not retry or skip it.

## Publishing 0.2.0 (for the integrator)

1. On main, with every lane merged: add the `Updating` section to the 0.2.0 entry in
   `resources/release-notes/releases.json` (see below), and regenerate
   `docs/releases/notes/v0.2.0.txt` from it.
2. Actions > Release > Run workflow on `main`: `version=0.2.0`, `publish=draft`,
   `macos=attach-if-passing` (or `build-only` for Windows only). `prepare` refuses a version that
   is not `package.json`'s, a tag or release that already exists, or missing notes.
3. If a Windows unit test fails on runner timing, re-run the failed jobs once; the macOS result is
   kept.
4. Read the release job's summary: every asset's bytes and SHA-256, each equal to GitHub's digest.
   Open the draft and check the title, the body (README, WHAT IS NEW onward) and seven assets
   (six without the DMG).
5. Publish the draft as a full release and mark it latest. This is the step installed 0.1.x copies
   see; they select `Diomedes-Experimental-0.2.0-unsigned-setup.exe` and verify it against GitHub's
   digest.
6. Commit that run's `evidence/windows-release/build-info.json` and candidate record (artifact
   `windows-proofs`) to main, as every release has.
7. Delete the `v0.2.0-rc.1` draft.

## PILLAR IMPACT

- **Pillar 11 (scale without scaling the founder), advanced:** a release no longer needs Andrew's
  machine to package, install-test and hash it; any run of the workflow at a named commit does,
  and records what it proved.
- **Pillar 09 (trust), held:** every public file is still produced from a named candidate record
  with its hashes checked after upload, and a macOS image needs its own launch proof and a
  verifying bundle signature before it can be published. Nothing is represented as Developer-ID
  signed or notarized.

No pillar's meaning changes.

## ROADMAP IMPACT

- Release packaging moves from one Windows machine to a reproducible hosted workflow: implemented,
  proven on a draft (above).
- macOS desktop distribution: packaged, ad-hoc signed and launched on a hosted Apple Silicon
  runner (see "Is macOS working?").
- Nothing is released. 0.1.11 remains the latest release.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Built and proven: run 9 (36092737965) built 0.2.0 at `440c2a6` for Windows x64 and macOS arm64
and created the draft `v0.2.0-rc.1` with every asset's digest checked. Nothing is published: the
draft is not public, 0.1.11 is still the latest release, and no stable release was created by this
lane. The lane's branch was merged to main as PR #122.

## Implemented versus recorded

Implemented and tested: everything under "What was built". Recorded only: the Connections
ingress fault and its proposed fix, and the items for Andrew below. Nothing claims a capability
that is not shipped.

## For Andrew and the integrator

1. **macOS asset.** Andrew chose an ad-hoc whole-bundle signature (O43 option a). The 0.2.0
   notes on main now describe the Mac build and how to open it (`1d4aed6`). Developer ID and
   notarization (O10) remain the route to a Mac download that opens without an override.
2. **The `releases.json` 0.2.0 entry has no `Updating` section**, which every earlier entry has.
   What an installed 0.1.x sees (stable only, digest-verified, 0.1.7 and 0.1.8 get the fresh start)
   belongs there before 0.2.0 is promoted.
3. **The Connections ingress fault** above, for the Trust owner.

## Proposed canonical-doc patch

Not applied (the sprint forbids editing the canonical documents); for the integrator.

**Live Roadmap, release/build status paragraph, append:**

> Releases are built by `.github/workflows/release.yml` on hosted runners (from 2026-09-25,
> `docs/implementation/2026-09-25-release-pipeline.md`): Windows gates, package, installer
> install/launch/repair/uninstall and candidate record on `windows-latest`; a macOS arm64
> package, ad-hoc signed as Andrew decided (O43 a), and launch smoke on `macos-14`. The workflow
> makes drafts or prereleases only; a person promotes a stable release. The bundled Codex runtime
> is taken from the v0.1.11 portable ZIP against its published hash, byte-identical to every
> earlier release. Open: a packaged build refuses its own Connections ingress, which keeps the
> Connections smokes out of the release checks.

**Project Memory, definitions, add:**

> **Release workflow** — `.github/workflows/release.yml`, run by hand with a version and a publish
> mode (draft or prerelease). Its output is exactly what a hand-packaged release produced
> (installer, portable ZIP, launcher, README, manifest, SHA256SUMS), plus a macOS disk image when
> asked for and publishable, from one named commit, with the candidate record written on the
> runner. A hosted runner is not a person's computer: its installer proof runs on Windows Server,
> and its macOS smoke launches the executable directly, which is not what a downloaded copy meets.

**QUESTIONS.md:**

> **O43 — macOS distribution signature.** Settled by Andrew on 2026-09-25: option (a), an ad-hoc
> whole-bundle signature. The bundle verifies; Gatekeeper still asks the person to open it once.
> Developer ID and notarization stay with O10.
>
> **O44 — Connections ingress in a packaged build.** The synthetic event driver's self-call to the
> loopback ingress carries no session header and is refused. Proposed: pass the launch's session
> header to the self-call. Until fixed, the Connections smokes cannot run in the release checks.
