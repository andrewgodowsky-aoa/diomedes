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
- **windows** (`windows-latest`): `npm ci` (root and control plane); gate 1 `tsc --noEmit`;
  gate 2 vitest with the JSON reporter; the native runtime and the Electron archive, both
  verified (below); gate 3 and packaging through `npm run package:windows`; gate 4 Playwright
  `ui`, `native-ui` and `field` with the JSON reporter; the NSIS installer through
  `build-windows-installer.mjs`; the packaged desktop smoke; the negative smoke;
  `verify-windows-installer.ps1`, which installs silently into a new folder under
  `test-results`, runs the Connections desktop smoke on the installed copy, repairs, uninstalls
  and hands the registration back; then `write-candidate-record.ts` with all three proof gates,
  and the capability record. Nothing rebuilds `dist/` after packaging, because the candidate
  record re-hashes it.
- **macos** (`macos-14`, Apple Silicon asserted): verified Electron archive; `npm run
  package:mac`; a UDZO disk image (`Diomedes.app` and an Applications link), `hdiutil verify`;
  signature facts; the launch smoke from the mounted, read-only image; a release proof binding
  the image's SHA-256 to the smoke and to the build's commit; a `publishable` output.
- **release** (`windows-latest`, `contents: write`): runs when Windows passed, whatever macOS
  did. `write-release-assets.mjs` from the candidate record, the release body, `gh release create
  --target <sha>` as a draft or as a prerelease with `--latest=false`, then every uploaded asset
  is compared with GitHub's own `digest` and size, and the table goes to the run summary.

### Native runtime: a verified download, no pin changed

`package-desktop.mjs` refuses to package unless `.data/native-runtime` holds three files with
fixed SHA-256 values; `prepare-native.ts` copies them only from an installed Codex. A hosted
runner has none. OpenAI's current downloads cannot satisfy the pins: the GitHub release assets
for `rust-v0.153.4` and the npm package `@openai/codex@0.153.4-win32-x64` both carry the same
program under a different Authenticode signature instance, so every whole-file hash differs
(checked again today: npm's `codex.exe` is `444a3f00…518b`, the pin is `a1cf6360…b6`;
`docs/releases/NOTICES_HANDOFF.md` has the section-by-section proof that the programs are
identical).

The exact pinned bytes are published in our own release v0.1.11: its portable ZIP carries them
under `resources/native-runtime`. `scripts/release-support/acquire-native-runtime.mjs` downloads
`Diomedes-Experimental-0.1.11-win32-x64.zip`, requires 269,088,059 bytes and SHA-256
`e30c17c8228db2fdfba1380234fbbe4e69eca0cea4ad0ad90560c9f1e8c1a070` (the values v0.1.11's
`release-manifest.json` and `SHA256SUMS.txt` publish), extracts only the three files, and
requires each to hash to `WINDOWS_NATIVE_RUNTIME_SHA256`, now exported once from
`package-desktop.mjs`, which checks them again before packaging. Verified here on Linux and in
the proof run.

This keeps every bundled runtime byte-identical to 0.1.1–0.1.11. Its source is our own earlier
release. The day the runtime moves to a new Codex version, the pins, this source and
`prepare-native.ts` change together.

### Electron archive

`scripts/release-support/acquire-electron-archive.mjs` downloads
`electron-v<version>-<platform>-<arch>.zip` and accepts it only when its SHA-256 equals both the
line in Electron's `SHASUMS256.txt` and `node_modules/electron/checksums.json`, which came through
`package-lock.json`'s integrity-checked install. For 44.2.0: darwin-arm64
`f906dff5…9b02`, win32-x64 `4021363e…81da`, both sources agreeing. Both platforms use it, so
neither job downloads Electron unverified.

### macOS packaging and the ad-hoc signature

On a Mac host, `@electron/packager` writes the ASAR integrity digest into the Electron Framework
and then restores the ad-hoc signature Electron ships with (Apple Silicon will not execute a
binary whose signature is invalid). `package-desktop.mjs` refused that step outright, because
the Mac work order authorised no signing (`docs/MAC_DEVELOPMENT_HANDOFF.md`, "Decisions waiting on
Andrew", item 2). It still refuses by default, and both tests that pin the refusal pass
unchanged. `DIOMEDES_MAC_ADHOC_FRAMEWORK_RESIGN=accept`, which only the release workflow sets,
names the step, and the build record then says `macFrameworkSignature: ad-hoc, restored by
@electron/packager …; no Developer ID, not notarized`.

### Launch smoke

`scripts/packaged-launch-smoke.mjs <executable> <new proof dir>` is platform-neutral. It launches
the packaged app on a fresh profile, data and projects folder with an empty `CODEX_HOME`, waits
for the window to load from 127.0.0.1, asks `/api/health` from inside the window (the only
caller the service answers) and requires `ok` and this version, asks the same URL from outside
and requires 401, reads `desktop-startup.json`, quits, and requires the data lock released and
the port closed.

### Release assets and manifest

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
  (`kind: macos-disk-image`, its own `platform`, `signing: ad-hoc only (no Developer ID
  signature, not notarized)`, `launchSmoke`); a new `platforms` list names what the release
  carries. The local-path guard now also catches `/Users/`, `/home/` and `/private/`.

`scripts/release-support/release-body.mjs` writes the release body from
`resources/release-notes/releases.json` (the entry for the version, or the X.Y.Z base of a
candidate) and otherwise from `docs/releases/notes/v<X.Y.Z>.txt`, with a heading that marks a
candidate as never offered as an update and a footer naming the commit, `README.txt` and
`SHA256SUMS.txt`. `releases.json` is not on main yet; the fallback is what ran.

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
`a492c42`, pinned by SHA-256 (`3141076e…9e5aca`) so an edit fails the test. It proves that
the 0.1.11 code finds the Windows installer, and only it, in a release that also carries the
disk image and zip; that the digest it holds the download to is the installer's; that a
`-rc.N` tag never parses as an update; that a macOS updater picks the disk image with its own
digest, reports none for a Windows-only release, and refuses to download; that a Windows copy
still downloads and verifies; that the manifest keeps every Windows field; and the release-body
fallbacks.

### Version 0.2.0

The files `f01d74e` touched for 0.1.11: `package.json` and `package-lock.json` (through `npm
version`), the README's version line, `resources/product-knowledge` (`buildVersion` and the index
hash of `core.json`), `tests/inventory-receipt-ui.spec.ts`; plus
`docs/reference/capability-record.json` regenerated as `a492c42` did, and
`docs/releases/notes/v0.2.0.txt` in v0.1.11's sections, drawn from
`docs/implementation/2026-09-24-overnight-sprint-summary.md`. The notes claim only what that
summary says landed in source, name the lanes without independent review, and say plainly that
no route was exercised live. **The integrator must reread them against whatever else lands before
the 0.2.0 run**, and change the last LIMITS line if macOS is attached.

`evidence/windows-release/build-info.json` is the stamp of the proof run's packaged build, as each
release commits it (`tests/build-identity.test.ts` requires it to carry the package version).

## Proof run

Pending: run 36080584839 (`0.2.0-rc.1`, draft) is in progress; its results replace this line.

## Is macOS working?

Pending the proof run; see the macOS job of run 36080584839.

## Gates

Pending the final local run after the merge of main.

## Publishing 0.2.0 (for the integrator)

Pending the proof run.

## PILLAR IMPACT

- **Pillar 11 (scale without scaling the founder), advanced:** a release no longer needs Andrew's
  machine to package, install-test and hash it; any run of the workflow at a named commit does,
  and records what it proved.
- **Pillar 09 (trust), held:** every public file is still produced from a named candidate record
  with its hashes checked after upload, and a macOS image needs its own launch proof and a
  verifying signature before it can be published. Nothing is represented as signed.

No pillar's meaning changes.

## ROADMAP IMPACT

- Release packaging moves from one Windows machine to a reproducible hosted workflow: implemented,
  proven on a draft (above).
- macOS desktop distribution: packaged and launched on a hosted Apple Silicon runner for the first
  time; **not distributable** until the signing decision below is made.
- Nothing is released. 0.1.11 remains the latest release.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

Pending the proof run. Nothing is published.

## Implemented versus recorded

Implemented and tested: everything under "What was built". Recorded only: the signing decisions
below, and the remaining items. Nothing claims a capability that is not shipped.

## Decisions for Andrew

1. **macOS signing.** A downloadable Mac build needs either (a) a whole-bundle ad-hoc signature
   (`codesign --force --deep --sign -`), which should make the bundle verify (not tried here: it
   is a signing step nobody authorised) but would still meet Gatekeeper's "cannot verify the
   developer" block that a person must override in System Settings, or (b) Developer ID signing and notarization (O10, Apple Developer Program, US$99 a
   year), which is the only route to a Mac download that opens normally. Until one is chosen the
   workflow publishes Windows only, whatever `macos` says.
2. **Ad-hoc framework signature in CI.** The workflow accepts the packager's restoration of
   Electron's own ad-hoc framework signature so that a Mac package can be built at all
   (`MAC_DEVELOPMENT_HANDOFF.md` item 2). This produces no publisher identity and nothing is
   published from it while decision 1 is open, but it is a signing step and is named here.

## Proposed canonical-doc patch

Not applied (the sprint forbids editing the canonical documents); for the integrator.

**Live Roadmap, release/build status paragraph, append:**

> Releases are built by `.github/workflows/release.yml` on hosted runners (from 2026-09-25,
> `docs/implementation/2026-09-25-release-pipeline.md`): Windows gates, package, installer
> install/repair/uninstall and candidate record on `windows-latest`; a macOS arm64 package and
> launch smoke on `macos-14`. The workflow makes drafts or prereleases only; a person promotes a
> stable release. The bundled Codex runtime is taken from the v0.1.11 portable ZIP against its
> published hash, byte-identical to every earlier release. A macOS image is not published until
> Andrew decides between an ad-hoc bundle signature and Developer ID with notarization (O10).

**Project Memory, definitions, add:**

> **Release workflow** — `.github/workflows/release.yml`, run by hand with a version and a publish
> mode (draft or prerelease). Its output is exactly what a hand-packaged release produced
> (installer, portable ZIP, launcher, README, manifest, SHA256SUMS) from one named commit, with
> the candidate record written on the runner. A hosted runner is not a person's computer: its
> installer proof runs on Windows Server, and its macOS smoke launches the executable directly,
> which is not what a downloaded copy meets.

**QUESTIONS.md, add as an open question:**

> **O43 — macOS distribution signature.** A hosted Apple Silicon build launches, but its bundle
> signature does not verify (`codesign --verify --deep --strict`: "code has no resources but
> signature indicates they must be present"), so a downloaded copy would be refused as damaged.
> Options: an ad-hoc whole-bundle signature (opens only after a manual override in System
> Settings), or Developer ID and notarization (O10). Default until decided: no macOS asset is
> published.
